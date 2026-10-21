// Checking a pull request out, as T3 Code does (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/git/GitManager.ts (normalizePullRequestReference,
// preparePullRequestThread, materializePullRequestHeadBranch,
// resolvePullRequestWorktreeLocalBranchName, configurePullRequestHeadUpstream),
// apps/server/src/vcs/GitVcsDriverCore.ts (ensureRemote, fetchPullRequestHeadCommit,
// refreshCheckedOutBranch) and the GitHub provider's checkoutChangeRequest.
import * as Path from "node:path";

import type { PreparedPullRequest, PullRequest } from "@jhin/source-control-api";

import type { CheckoutTarget } from "./forge.ts";
import { SourceControlError, type Git } from "./git.ts";
import {
  listWorktrees,
  recreateWorktree,
  sanitizeBranchFragment,
  worktreePath,
} from "./worktrees.ts";

/**
 * T3's normalization: trimmed, `#42` as `42`; the forge reads numbers, URLs
 * and branches. One that starts with `-` would read as an option: refused.
 */
export function normalizeReference(reference: string): string {
  const trimmed = reference.trim();
  if (trimmed.startsWith("-")) {
    throw new SourceControlError("PULL_REQUEST_INVALID", `${trimmed} is not a pull request`);
  }
  return /^#\d+$/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/**
 * The remote of the pull request's own repository (its base), when one points
 * there: with `origin` a fork and `upstream` the repository, `gh` reads the
 * pull request in `upstream`. Else `origin`, else the first remote.
 */
async function primaryRemote(git: Git, pullRequestUrl?: string): Promise<string> {
  const remotes = (await git(["remote"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (pullRequestUrl !== undefined) {
    for (const remote of remotes) {
      const url = await git(["config", "--get", `remote.${remote}.url`], { ok: [0, 1] });
      if (url.code === 0 && isPullRequestOf(url.stdout, pullRequestUrl)) return remote;
    }
  }
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (remote === undefined) {
    throw new SourceControlError("GIT_FAILED", "No git remote is configured for this repository.");
  }
  return remote;
}

/** `host/owner/name` of a remote URL, lowercased, whichever protocol it uses. */
function normalizeUrl(url: string): string {
  return (
    url
      .trim()
      .toLowerCase()
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/^[^@/]+@/, "")
      // `host:port/…` (ssh:// with a port) and scp-style `host:owner/…` both as `host/…`.
      .replace(/^([^/:]+):\d+\//, "$1/")
      .replace(/^([^/:]+):/, "$1/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
  );
}

/**
 * Whether a pull request's URL (`https://<host>/<owner>/<name>/pull/<n>`) is
 * one of the repository a remote URL names: a URL reference may name another.
 */
export function isPullRequestOf(remoteUrl: string, pullRequestUrl: string): boolean {
  const repository = pullRequestUrl.split(/\/pull\/\d+/)[0];
  return repository !== undefined && normalizeUrl(repository) === normalizeUrl(remoteUrl);
}

/** The fork's clone URL on the pull request's host, over SSH when the primary remote uses it. */
async function forkUrl(git: Git, target: CheckoutTarget): Promise<string> {
  const host = new URL(target.pr.url).host;
  const primary = await primaryRemote(git);
  const primaryUrl = (await git(["config", "--get", `remote.${primary}.url`])).stdout.trim();
  // The same way in as the primary remote: ssh:// (with its user and port), scp-style or https.
  const sshUrl = /^ssh:\/\/[^/]+\//i.exec(primaryUrl)?.[0];
  if (sshUrl !== undefined) return `${sshUrl}${target.headRepository}.git`;
  return /^[^/]+@[^/]+:/.test(primaryUrl)
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
  if (!target.crossRepository) return primaryRemote(git, target.pr.url);
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

/** The commit of `refs/pull/<n>/head` on the pull request's repository. */
async function fetchPullRequestHead(git: Git, pr: PullRequest): Promise<string> {
  const remote = await primaryRemote(git, pr.url);
  await git(["fetch", "--quiet", "--no-tags", "--", remote, `refs/pull/${pr.number}/head`]);
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

/** The head's commit, and the remote-tracking ref it came from (none from `refs/pull`). */
async function headCommit(
  git: Git,
  target: CheckoutTarget,
  warn: (message: string, fields: Record<string, unknown>) => void,
): Promise<{ commit: string; ref?: string }> {
  try {
    const ref = await fetchHead(git, await headRemote(git, target), target.pr.headBranch);
    return { commit: (await git(["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim(), ref };
  } catch (error) {
    // T3 falls back on any failure too: the pull request's own ref, without an upstream.
    warn("could not fetch the pull request's head branch, using refs/pull", {
      number: target.pr.number,
      headBranch: target.pr.headBranch,
      error: (error as Error).message,
    });
    return { commit: await fetchPullRequestHead(git, target.pr) };
  }
}

/** Refuses a branch that has commits the head does not: moving it would lose them. */
async function assertBehind(git: Git, branch: string, commit: string, number: number) {
  const behind = await git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, commit], {
    ok: [0, 1],
  });
  if (behind.code !== 0) {
    throw new SourceControlError(
      "BRANCH_EXISTS",
      `Branch '${branch}' has commits that pull request #${number} does not. Push or move them, then check it out again.`,
      { branch },
    );
  }
}

/**
 * Checks the pull request out in the project's own checkout (T3's "Local"):
 * its head branch (`<owner>/<head>` for a fork whose head is named like its
 * base), created or fast-forwarded to the head, tracking it. Unlike T3's reset,
 * it refuses a checkout with changes and a branch with commits of its own.
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
  if ((await git(["status", "--porcelain"])).stdout.trim() !== "") {
    throw new SourceControlError(
      "ACTION_UNAVAILABLE",
      "Commit or stash the changes in the project's checkout before checking a pull request out in it.",
    );
  }
  try {
    const { commit, ref } = await headCommit(git, target, warn);
    if (await branchExists(git, local)) {
      await assertBehind(git, local, commit, pr.number);
      await git(["switch", "--quiet", "--", local]);
      await git(["merge", "--ff-only", "--quiet", commit]);
    } else {
      await git(["branch", "--", local, commit]);
      await git(["switch", "--quiet", "--", local]);
    }
    if (ref !== undefined) {
      await git(["branch", `--set-upstream-to=${ref.slice("refs/remotes/".length)}`, "--", local]);
    }
  } catch (error) {
    if (error instanceof SourceControlError && error.code !== "GIT_FAILED") throw error;
    warn("could not check the pull request out", { error: (error as Error).message });
    throw new SourceControlError(
      "GIT_FAILED",
      `The pull request could not be checked out with git. ${(error as Error).message}`,
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

/**
 * Makes `local` point at the pull request's head (T3's
 * `materializePullRequestHeadBranch`): created there, or moved forward when it
 * is behind; one with commits of its own is refused.
 */
async function materialize(
  git: Git,
  target: CheckoutTarget,
  local: string,
  warn: (message: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  const { pr } = target;
  let commit: string;
  try {
    ({ commit } = await headCommit(git, target, warn));
  } catch {
    throw new SourceControlError(
      "GIT_FAILED",
      `Failed to materialize pull request #${pr.number} branch ${pr.headBranch} as ${local}.`,
      { number: pr.number },
    );
  }
  if (await branchExists(git, local)) await assertBehind(git, local, commit, pr.number);
  await git(["branch", "--force", "--", local, commit]);
}

/**
 * Moves a reused worktree's branch to the pull request's head when that is
 * safe (T3's `refreshCheckedOutBranch`): already there, or a fast-forward of
 * a clean checkout. Returns whether it is on the head.
 */
async function refresh(git: Git, pr: PullRequest): Promise<boolean> {
  const target = await fetchPullRequestHead(git, pr);
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
  // A worktree git still lists but whose folder is gone is pruned, not reused.
  await git(["worktree", "prune"]);
  const entries = await listWorktrees(git);
  const same = (a: string, b: string) => Path.resolve(a) === Path.resolve(b);
  // A fork's head named like a branch of this repository is not that branch.
  const found = entries.find((entry) => entry.branch === local);
  if (found !== undefined && (found.main || same(found.path, options.repository))) {
    throw new SourceControlError(
      "WORKTREE_IN_USE",
      "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
      { branch: local },
    );
  }
  if (found !== undefined) {
    const worktreeGit = options.createGit(found.path);
    await configureUpstream(worktreeGit, target, local, options.warn);
    const onHead = await refresh(worktreeGit, pr).catch((error: unknown) => {
      options.warn("could not refresh a reused pull request worktree", {
        worktreePath: found.path,
        error: (error as Error).message,
      });
      return false;
    });
    return {
      pullRequest: pr,
      branch: local,
      worktreePath: found.path,
      isOnPullRequestHead: onHead,
    };
  }
  const existed = await branchExists(git, local);
  await materialize(git, target, local, options.warn);
  const path = worktreePath(options.root, options.repository, local);
  try {
    await recreateWorktree(git, path, local);
  } catch (error) {
    // A branch made only for this worktree goes with it.
    if (!existed) await git(["branch", "-D", "--", local], { ok: [0, 1] });
    throw error;
  }
  await configureUpstream(options.createGit(path), target, local, options.warn);
  return { pullRequest: pr, branch: local, worktreePath: path, isOnPullRequestHead: true };
}
