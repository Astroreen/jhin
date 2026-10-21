// Checking a pull request out, as T3 Code does (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/git/GitManager.ts (normalizePullRequestReference,
// preparePullRequestThread, materializePullRequestHeadBranch,
// resolvePullRequestWorktreeLocalBranchName, configurePullRequestHeadUpstream),
// apps/server/src/vcs/GitVcsDriverCore.ts (ensureRemote, fetchPullRequestHeadCommit,
// refreshCheckedOutBranch) and the GitHub provider's checkoutChangeRequest.
import * as Path from "node:path";

import type { PullRequest } from "@jhin/source-control-api";

import type { CheckoutTarget } from "./forge.ts";
import { SourceControlError, type Git } from "./git.ts";
import {
  listWorktrees,
  recreateWorktree,
  sanitizeBranchFragment,
  worktreePath,
} from "./worktrees.ts";

/** What checking a pull request out made (T3's `preparePullRequestThread` result). */
export interface PreparedPullRequest {
  readonly pullRequest: PullRequest;
  readonly branch: string;
  /** The worktree it is checked out in; `null` in the project's own checkout. */
  readonly worktreePath: string | null;
  /** False for a reused worktree on a branch of the same name that is not the pull request's. */
  readonly isOnPullRequestHead: boolean;
}

/** T3's normalization: trimmed, `#42` as `42`; the forge reads numbers, URLs and branches. */
export function normalizeReference(reference: string): string {
  const trimmed = reference.trim();
  return /^#\d+$/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/** `origin`, else the first remote. */
async function primaryRemote(git: Git): Promise<string> {
  const remotes = (await git(["remote"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (remote === undefined) {
    throw new SourceControlError("GIT_FAILED", "No git remote is configured for this repository.");
  }
  return remote;
}

/** `host/owner/name` of a remote URL, lowercased, whichever protocol it uses. */
function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** The fork's clone URL on the pull request's host, over SSH when the primary remote uses it. */
async function forkUrl(git: Git, target: CheckoutTarget): Promise<string> {
  const host = new URL(target.pr.url).host;
  const primary = await primaryRemote(git);
  const primaryUrl = (await git(["config", "--get", `remote.${primary}.url`])).stdout.trim();
  const ssh = /^[^/]+@[^/]+:/.test(primaryUrl) || primaryUrl.startsWith("ssh://");
  return ssh
    ? `git@${host}:${target.headRepository}.git`
    : `https://${host}/${target.headRepository}.git`;
}

/** A remote for `url`: one that already points there, else a new one named `name`, `name-1`, … */
async function ensureRemote(git: Git, name: string, url: string): Promise<string> {
  const remotes = (await git(["remote"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const remote of remotes) {
    // As configured, before any `insteadOf` rewrites it.
    const known = await git(["config", "--get", `remote.${remote}.url`], { ok: [0, 1] });
    if (known.code === 0 && normalizeUrl(known.stdout) === normalizeUrl(url)) return remote;
  }
  let candidate = name;
  for (let suffix = 1; remotes.includes(candidate); suffix += 1) candidate = `${name}-${suffix}`;
  await git(["remote", "add", "--", candidate, url]);
  return candidate;
}

/** The remote the head branch lives on: the primary one, or the fork's (added when missing). */
async function headRemote(git: Git, target: CheckoutTarget): Promise<string> {
  if (!target.crossRepository) return primaryRemote(git);
  if (target.headRepository === undefined) {
    throw new SourceControlError("PULL_REQUEST_FAILED", "The fork of this pull request is gone.");
  }
  const name = target.headOwner ?? target.headRepository.split("/")[0] ?? "fork";
  return ensureRemote(git, name, await forkUrl(git, target));
}

/** Fetches the head branch into `refs/remotes/<remote>/<head>` and returns that ref. */
async function fetchHead(git: Git, remote: string, head: string): Promise<string> {
  await git([
    "fetch",
    "--quiet",
    "--no-tags",
    "--",
    remote,
    `+refs/heads/${head}:refs/remotes/${remote}/${head}`,
  ]);
  return `refs/remotes/${remote}/${head}`;
}

/** The commit of `refs/pull/<n>/head` on the primary remote. */
async function fetchPullRequestHead(git: Git, number: number): Promise<string> {
  const remote = await primaryRemote(git);
  await git(["fetch", "--quiet", "--no-tags", "--", remote, `refs/pull/${number}/head`]);
  return (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).stdout.trim();
}

/** T3's `configurePullRequestHeadUpstream`: best effort, a failure only warns. */
async function configureUpstream(
  git: Git,
  target: CheckoutTarget,
  branch: string,
  warn: (message: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const remote = await headRemote(git, target);
    const ref = await fetchHead(git, remote, target.pr.headBranch);
    await git(["branch", `--set-upstream-to=${ref.slice("refs/remotes/".length)}`, "--", branch]);
  } catch (error) {
    warn("could not set the pull request branch's upstream", {
      branch,
      error: (error as Error).message,
    });
  }
}

const branchExists = async (git: Git, branch: string) =>
  (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { ok: [0, 1] })).code ===
  0;

/**
 * Checks the pull request out in the project's own checkout (T3's "Local"):
 * its head branch (`<owner>/<head>` for a fork whose head is named like its
 * base), created or reset to the head, tracking it.
 */
export async function checkoutLocal(
  git: Git,
  target: CheckoutTarget,
  warn: (message: string, fields: Record<string, unknown>) => void,
): Promise<PreparedPullRequest> {
  const { pr } = target;
  const local =
    target.crossRepository && target.headOwner !== undefined && pr.headBranch === pr.baseBranch
      ? `${target.headOwner}/${pr.headBranch}`
      : pr.headBranch;
  try {
    let ref: string;
    let tracking = true;
    try {
      ref = await fetchHead(git, await headRemote(git, target), pr.headBranch);
    } catch {
      // A head branch that is gone: the pull request's own ref, without an upstream.
      ref = await fetchPullRequestHead(git, pr.number);
      tracking = false;
    }
    if (await branchExists(git, local)) {
      await git(["switch", "--quiet", "--", local]);
      await git(["reset", "--hard", "--quiet", ref]);
    } else {
      await git(["branch", "--", local, ref]);
      await git(["switch", "--quiet", "--", local]);
    }
    if (tracking) {
      await git(["branch", `--set-upstream-to=${ref.slice("refs/remotes/".length)}`, "--", local]);
    }
  } catch (error) {
    warn("could not check the pull request out", { error: (error as Error).message });
    throw new SourceControlError(
      "GIT_FAILED",
      "The pull request could not be checked out with git.",
      { number: pr.number },
    );
  }
  const branch = (await git(["branch", "--show-current"])).stdout.trim() || local;
  return { pullRequest: pr, branch, worktreePath: null, isOnPullRequestHead: true };
}

/** T3's local branch of a worktree: the head branch, or `jhin/pr-<n>/<head>` for a fork. */
function worktreeBranchOf(target: CheckoutTarget): string {
  return target.crossRepository
    ? `jhin/pr-${target.pr.number}/${sanitizeBranchFragment(target.pr.headBranch)}`
    : target.pr.headBranch;
}

/** Makes `local` point at the pull request's head (T3's `materializePullRequestHeadBranch`). */
async function materialize(git: Git, target: CheckoutTarget, local: string): Promise<void> {
  const { pr } = target;
  const primary = await primaryRemote(git);
  const fromPullRef = () =>
    git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      primary,
      `+refs/pull/${pr.number}/head:refs/heads/${local}`,
    ]);
  try {
    if (target.crossRepository) {
      const ref = await fetchHead(git, await headRemote(git, target), pr.headBranch);
      await git(["branch", "--force", "--", local, ref]);
      return;
    }
    try {
      await fromPullRef();
      return;
    } catch (error) {
      if (pr.state !== "open") throw error;
      await git(["branch", "--force", "--", local, await fetchHead(git, primary, pr.headBranch)]);
      return;
    }
  } catch {
    try {
      await fromPullRef();
    } catch {
      throw new SourceControlError(
        "GIT_FAILED",
        `Failed to materialize pull request #${pr.number} branch ${pr.headBranch} as ${local}.`,
        { number: pr.number },
      );
    }
  }
}

/**
 * Moves a reused worktree's branch to the pull request's head when that is
 * safe (T3's `refreshCheckedOutBranch`): already there, or a fast-forward of
 * a clean checkout. Returns whether it is on the head.
 */
async function refresh(git: Git, number: number): Promise<boolean> {
  const target = await fetchPullRequestHead(git, number);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (head === target) return true;
  if ((await git(["status", "--porcelain"])).stdout.trim() !== "") return false;
  const ancestor = await git(["merge-base", "--is-ancestor", head, target], { ok: [0, 1] });
  if (ancestor.code !== 0) return false;
  await git(["merge", "--ff-only", "--quiet", target]);
  return true;
}

/**
 * Checks the pull request out in a worktree (T3's "Worktree"): one that
 * already has its branch is reused, else its branch is made from the head and
 * checked out in a new worktree under the worktrees directory.
 */
export async function checkoutWorktree(
  git: Git,
  target: CheckoutTarget,
  options: {
    readonly repository: string;
    readonly root: string;
    readonly createGit: (cwd: string) => Git;
    readonly warn: (message: string, fields: Record<string, unknown>) => void;
  },
): Promise<PreparedPullRequest> {
  const { pr } = target;
  const local = worktreeBranchOf(target);
  const entries = await listWorktrees(git);
  const same = (a: string, b: string) => Path.resolve(a) === Path.resolve(b);
  // The jhin branch wherever it is; the bare head branch only in a worktree of its own.
  const found =
    entries.find((entry) => entry.branch === local) ??
    entries.find((entry) => !entry.main && entry.branch === pr.headBranch);
  if (found !== undefined && (found.main || same(found.path, options.repository))) {
    throw new SourceControlError(
      "WORKTREE_IN_USE",
      "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
      { branch: local },
    );
  }
  if (found !== undefined) {
    const worktreeGit = options.createGit(found.path);
    let onHead = false;
    if (found.branch === local) {
      await configureUpstream(worktreeGit, target, local, options.warn);
      onHead = await refresh(worktreeGit, pr.number).catch((error: unknown) => {
        options.warn("could not refresh a reused pull request worktree", {
          worktreePath: found.path,
          error: (error as Error).message,
        });
        return false;
      });
    }
    return {
      pullRequest: pr,
      branch: found.branch ?? local,
      worktreePath: found.path,
      isOnPullRequestHead: onHead,
    };
  }
  await materialize(git, target, local);
  const path = worktreePath(options.root, options.repository, local);
  await recreateWorktree(git, path, local);
  await configureUpstream(options.createGit(path), target, local, options.warn);
  return { pullRequest: pr, branch: local, worktreePath: path, isOnPullRequestHead: true };
}
