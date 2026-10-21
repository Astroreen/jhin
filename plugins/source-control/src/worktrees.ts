// Worktrees of a project, as T3 Code makes them (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/vcs/GitVcsDriverCore.ts (createWorktree, removeWorktree,
// fetching a base branch from origin), apps/server/src/worktreesDirectory.ts
// (where they live), packages/shared/src/git.ts (temporary branch names,
// sanitizeBranchFragment) and apps/server/src/orchestration-v2/ThreadLaunchService.ts
// with GitVcsDriverCore.ts (renaming a temporary branch from the first message).
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { SourceControlError, type Git } from "./git.ts";

/** T3's `t3/<8 hex>`, here under `jhin`. */
const BRANCH_PREFIX = "jhin";

/** No checkout of a large repository should take longer (T3's limit). */
const WORKTREE_TIMEOUT_MS = 300_000;

/**
 * The directory worktrees live in: the `worktreesDirectory` setting (absolute,
 * `~` expanded, not a filesystem root), else `<jhin home>/worktrees`.
 */
export function worktreesRoot(setting: string, home: string): string {
  const trimmed = setting.trim();
  if (trimmed === "") return Path.join(home, "worktrees");
  const expanded =
    trimmed === "~"
      ? Os.homedir()
      : trimmed.startsWith("~/")
        ? Path.join(Os.homedir(), trimmed.slice(2))
        : trimmed;
  const resolved = Path.resolve(expanded);
  if (!Path.isAbsolute(expanded) || Path.dirname(resolved) === resolved) {
    throw new SourceControlError(
      "WORKTREE_INVALID",
      `The worktree location "${setting}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Source control.`,
      { setting },
    );
  }
  return resolved;
}

/** `<root>/<repository>/<branch, "/" as "-">`, as T3 places them. */
const worktreePath = (root: string, repository: string, branch: string) =>
  Path.join(root, Path.basename(repository), branch.replaceAll("/", "-"));

/** A path under the worktrees root, two levels down: one this plugin made and may make again. */
export function isManagedWorktree(root: string, path: string): boolean {
  const relative = Path.relative(root, path);
  const parts = relative.split(Path.sep);
  return relative !== "" && !Path.isAbsolute(relative) && parts[0] !== ".." && parts.length === 2;
}

const branchExists = async (git: Git, branch: string) =>
  (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { ok: [0, 1] })).code ===
  0;

/** T3's temporary branch of a new worktree: `jhin/<8 hex>`, flat when a branch `jhin` exists. */
async function temporaryBranch(git: Git): Promise<string> {
  const hex = Crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return (await branchExists(git, BRANCH_PREFIX))
    ? `${BRANCH_PREFIX}-${hex}`
    : `${BRANCH_PREFIX}/${hex}`;
}

/** A branch this plugin named for a new worktree: `jhin/<8 hex>` or `jhin-<8 hex>`. */
export const isTemporaryBranch = (branch: string) =>
  new RegExp(`^${BRANCH_PREFIX}[-/][0-9a-f]{8}$`).test(branch.trim().toLowerCase());

/** T3's `sanitizeBranchFragment`: lowercase, `[a-z0-9/_-]`, at most 64 characters. */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");
  const fragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return fragment.length > 0 ? fragment : "update";
}

/**
 * Renames a temporary branch to `jhin/<fragment>` (`jhin-<fragment>` when the
 * temporary one was flat), taking `-1` to `-100` when that name is taken, as
 * T3's `renameBranch` does; returns the new name.
 */
export async function renameTemporaryBranch(
  git: Git,
  oldBranch: string,
  fragment: string,
): Promise<string> {
  const separator = oldBranch.charAt(BRANCH_PREFIX.length);
  const wanted = `${BRANCH_PREFIX}${separator}${sanitizeBranchFragment(fragment)}`;
  let target: string | undefined;
  for (let suffix = 0; suffix <= 100 && target === undefined; suffix += 1) {
    const candidate = suffix === 0 ? wanted : `${wanted}-${suffix}`;
    if (!(await branchExists(git, candidate))) target = candidate;
  }
  if (target === undefined || !(await validBranch(git, target))) {
    throw new SourceControlError(
      "BRANCH_INVALID",
      `Could not find an available branch name for '${wanted}'.`,
      { branch: wanted },
    );
  }
  await git(["branch", "-m", "--", oldBranch, target]);
  return target;
}

async function validBranch(git: Git, name: string): Promise<boolean> {
  if (name.startsWith("-")) return false;
  return (await git(["check-ref-format", "--branch", name], { ok: [0, 1, 128] })).code === 0;
}

/**
 * Fetches `base` from `origin` and returns `refs/remotes/origin/<base>` when it
 * exists there, else nothing (the local branch is used then).
 */
async function originRef(git: Git, base: string): Promise<string | undefined> {
  const remotes = (await git(["remote"])).stdout.split("\n").map((line) => line.trim());
  if (!remotes.includes("origin")) return undefined;
  const fetched = await git(
    ["fetch", "--quiet", "--", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`],
    { ok: [0, 1, 128], timeoutMs: WORKTREE_TIMEOUT_MS },
  );
  if (fetched.code !== 0) {
    await git(["fetch", "--quiet", "--", "origin"], {
      ok: [0, 1, 128],
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
  }
  const found = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`],
    { ok: [0, 1, 128] },
  );
  return found.code === 0 ? `refs/remotes/origin/${base}` : undefined;
}

export interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
  /** What the branch starts from: `baseRef`, or `refs/remotes/origin/<baseRef>`. */
  readonly startRef: string;
  /** Asked to start from origin, it did: false when origin has no such branch. */
  readonly startedFromOrigin: boolean;
}

/**
 * `git worktree add -b <branch> -- <path> <start>` in the project's repository;
 * with `startFromOrigin`, from `origin/<baseRef>` once fetched (when it exists).
 */
export async function createWorktree(
  git: Git,
  options: {
    readonly repository: string;
    readonly root: string;
    readonly baseRef: string;
    readonly branch?: string;
    readonly startFromOrigin?: boolean;
  },
): Promise<CreatedWorktree> {
  const { baseRef } = options;
  if (baseRef.startsWith("-")) {
    throw new SourceControlError("BRANCH_INVALID", `${baseRef} is not a valid ref`, {
      branch: baseRef,
    });
  }
  const base = await git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
    ok: [0, 1, 128],
  });
  if (base.code !== 0) {
    throw new SourceControlError("BRANCH_NOT_FOUND", `No branch ${baseRef}`, { branch: baseRef });
  }
  const branch = options.branch ?? (await temporaryBranch(git));
  if (!(await validBranch(git, branch))) {
    throw new SourceControlError("BRANCH_INVALID", `${branch} is not a valid branch name`, {
      branch,
    });
  }
  if (await branchExists(git, branch)) {
    throw new SourceControlError(
      "BRANCH_EXISTS",
      `Branch '${branch}' already exists. Choose a different branch name, or delete the existing branch first.`,
      { branch },
    );
  }
  // "origin/main" names the remote branch the toolbar shows: fetched as main.
  const remoteBase = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
  const fromOrigin =
    options.startFromOrigin === true ? await originRef(git, remoteBase) : undefined;
  const startRef = fromOrigin ?? baseRef;
  const path = worktreePath(options.root, options.repository, branch);
  // Branches can share a folder ("a/b" and "a-b"), and so can repositories of one name.
  if (
    await Fs.stat(path).then(
      () => true,
      () => false,
    )
  ) {
    throw new SourceControlError(
      "WORKTREE_INVALID",
      `The folder ${path} is taken already: choose another branch name`,
      { path, branch },
    );
  }
  await Fs.mkdir(Path.dirname(path), { recursive: true });
  await git(["worktree", "add", "-b", branch, "--", path, startRef], {
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  return {
    path: await Fs.realpath(path),
    branch,
    baseRef,
    startRef,
    startedFromOrigin: fromOrigin !== undefined,
  };
}

/** Checks an existing branch out again at `path` (a managed worktree that went missing). */
export async function recreateWorktree(git: Git, path: string, branch: string): Promise<void> {
  await git(["worktree", "prune"]);
  await Fs.mkdir(Path.dirname(path), { recursive: true });
  await git(["worktree", "add", "--", path, branch], { timeoutMs: WORKTREE_TIMEOUT_MS });
}

/** `git worktree remove`; a worktree already gone is pruned instead. */
export async function removeWorktree(
  git: Git,
  path: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const exists = await Fs.stat(path).then(
    () => true,
    () => false,
  );
  // Listed by git but gone from disk (the caller checked it is listed): pruned.
  if (!exists) {
    await git(["worktree", "prune"]);
    return;
  }
  await git(
    [
      "-c",
      "status.showUntrackedFiles=normal",
      "worktree",
      "remove",
      ...(options.force === true ? ["--force"] : []),
      "--",
      path,
    ],
    { timeoutMs: WORKTREE_TIMEOUT_MS },
  );
}

export interface WorktreeEntry {
  readonly path: string;
  /** `null` on a detached `HEAD`. */
  readonly branch: string | null;
  readonly head: string | null;
  /** The repository's own working tree (listed first). */
  readonly main: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line !== "");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (path === undefined) continue;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? null;
    const ref = lines.find((line) => line.startsWith("branch "))?.slice(7);
    entries.push({
      path,
      branch: ref === undefined ? null : ref.replace(/^refs\/heads\//, ""),
      head,
      main: entries.length === 0,
    });
  }
  return entries;
}

export async function listWorktrees(git: Git): Promise<WorktreeEntry[]> {
  return parseWorktreeList((await git(["worktree", "list", "--porcelain"])).stdout);
}
