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

import { contextReferencesAsLabels, ThreadEvents, visibleThreadEvents } from "@jhin/agent-api";

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
export const worktreePath = (root: string, repository: string, branch: string) =>
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

/**
 * A thread's first message, its text and what was sent with it (D1127), when
 * `turnId` is the thread's own first turn that a rollback did not drop: a
 * fork's first turn follows its parent's, and a message of attachments alone
 * names nothing.
 */
export function firstMessageInputOf(
  events: readonly { readonly type: string; readonly payload: unknown }[],
  turnId: string,
):
  | {
      text: string;
      attachments: { name: string; mimeType: string; sizeBytes?: number }[];
    }
  | undefined {
  const visible = visibleThreadEvents(events as Parameters<typeof visibleThreadEvents>[0]);
  const first = visible.find((event) => event.type === ThreadEvents.turnStarted)?.payload as
    | {
        turnId?: string;
        input?: {
          text?: string;
          attachments?: { name?: string; mimeType?: string; sizeBytes?: number }[];
        };
      }
    | undefined;
  const typed = first?.input?.text;
  // A context reference names the branch by its label (D1006).
  const text = typed === undefined ? undefined : contextReferencesAsLabels(typed).trim();
  if (first?.turnId !== turnId || !text) return undefined;
  const attachments = (first.input?.attachments ?? []).flatMap((attachment) =>
    typeof attachment.name === "string" && typeof attachment.mimeType === "string"
      ? [
          {
            name: attachment.name,
            mimeType: attachment.mimeType,
            ...(typeof attachment.sizeBytes === "number"
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
        ]
      : [],
  );
  return { text, attachments };
}

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
 * A branch name no existing branch is in the way of, part by part as T3's
 * `resolveAutoFeatureBranchName` walks it: a part that is a branch, or a last
 * part that is a branch or a folder of branches, takes `-1` to `-100`.
 */
export function availableBranchName(existing: readonly string[], wanted: string): string {
  const taken = new Set(existing);
  const parts = wanted.split("/");
  let resolved = "";
  for (const [index, part] of parts.entries()) {
    const base = resolved === "" ? part : `${resolved}/${part}`;
    const last = index === parts.length - 1;
    const clashes = (candidate: string) =>
      taken.has(candidate) || (last && existing.some((name) => name.startsWith(`${candidate}/`)));
    let candidate = base;
    for (let suffix = 1; clashes(candidate); suffix += 1) {
      if (suffix > 100) {
        throw new SourceControlError(
          "BRANCH_INVALID",
          `Could not find an available branch name for '${wanted}'.`,
          { branch: wanted },
        );
      }
      candidate = `${base}-${suffix}`;
    }
    resolved = candidate;
  }
  return resolved;
}

/** T3's `formatGeneratedBranchName`: a prefix's parts sanitized, joined to the fragment. */
function branchPrefixOf(prefix: string): string {
  return prefix
    .split("/")
    .map((part) =>
      part
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
}

/**
 * Renames a new worktree's temporary branch to the name a writer gave (D901,
 * D1126): `custom` takes it as it is (T3's `exactName`); `semantic` takes the
 * sanitized name; `static` puts the prefix before the sanitized fragment, with
 * `-` when the prefix is a branch itself. The fragment modes walk around taken names.
 */
export async function renameTemporaryBranch(
  git: Git,
  oldBranch: string,
  name: string,
  naming: { readonly mode: "static" | "semantic" | "custom"; readonly prefix: string } = {
    mode: "static",
    prefix: BRANCH_PREFIX,
  },
): Promise<string> {
  let target: string;
  // The other branches there are, once for every mode.
  const existing = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).stdout
    .split("\n")
    .filter((entry) => entry !== "" && entry !== oldBranch);
  if (naming.mode === "custom") {
    // T3's exactName: no suffix walks around a taken name; it is refused, saying why.
    target = name.trim();
    // Taken, or in the way of a branch (`a/b` beside `a`, or `a` beside `a/b`).
    if (availableBranchName(existing, target) !== target) {
      throw new SourceControlError(
        "BRANCH_EXISTS",
        existing.includes(target)
          ? `Branch '${target}' already exists: the custom branch name is used as given`
          : `Branch '${target}' is in the way of an existing branch: the custom branch name is used as given`,
        { branch: target },
      );
    }
  } else {
    const fragment = sanitizeBranchFragment(name);
    const prefix = naming.mode === "static" ? branchPrefixOf(naming.prefix) : "";
    // A prefix that is a branch has no folder for others: T3's flat `t3-<hex>` case.
    const wanted =
      prefix === ""
        ? fragment
        : existing.includes(prefix) ||
            // The flat temporary `jhin-<8 hex>` (a branch `jhin` was in the way when it was made).
            (isTemporaryBranch(oldBranch) && oldBranch === `${prefix}-${oldBranch.slice(-8)}`)
          ? `${prefix}-${fragment}`
          : `${prefix}/${fragment}`;
    target = availableBranchName(existing, wanted);
  }
  if (!(await validBranch(git, target))) {
    throw new SourceControlError("BRANCH_INVALID", `${target} is not a valid branch name`, {
      branch: target,
    });
  }
  await git(["branch", "-m", "--", oldBranch, target]);
  return target;
}

async function validBranch(git: Git, name: string): Promise<boolean> {
  // `--branch` also takes `@{-1}`-style names and HEAD, which name another ref, not a new one.
  if (name.startsWith("-") || name === "HEAD" || name.includes("@{") || name === "@") return false;
  const checked = await git(["check-ref-format", "--branch", name], { ok: [0, 1, 128] });
  // It answers the name it would use: one it expanded to another is no branch of its own.
  return checked.code === 0 && checked.stdout.trim() === name;
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
    /** How a new worktree populates git submodules (T3's `worktreeSubmodules`, D1134). */
    readonly submodules?: "recursive" | "top-level" | "none";
    /** Told when fetching the base and checking the files out start and end (D1123). */
    readonly onStage?: (
      stage: "fetch" | "checkout",
      status: "running" | "done" | "skipped" | "warning",
      detail?: string,
    ) => void;
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
  const onStage = options.onStage ?? (() => undefined);
  let fromOrigin: string | undefined;
  if (options.startFromOrigin === true) {
    onStage("fetch", "running");
    fromOrigin = await originRef(git, remoteBase);
    // Not on origin: the local branch is used, as T3's fetch stage warns.
    if (fromOrigin === undefined) onStage("fetch", "warning", `origin has no ${remoteBase}`);
    else onStage("fetch", "done");
  } else {
    onStage("fetch", "skipped");
  }
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
  onStage("checkout", "running");
  await git(["worktree", "add", "-b", branch, "--", path, startRef], {
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  const [status, detail] = await populateSubmodules(git, path, options.submodules ?? "recursive");
  onStage("checkout", status, detail);
  return {
    path: await Fs.realpath(path),
    branch,
    baseRef,
    startRef,
    startedFromOrigin: fromOrigin !== undefined,
  };
}

/**
 * T3's submodule step of a new worktree: `git worktree add` leaves submodules
 * empty, so a repository that keeps tooling or source in one gets them
 * checked out (`--recursive` unless only the top level is wanted). A failure
 * leaves their folders empty and the worktree in use, with a warning.
 */
async function populateSubmodules(
  git: Git,
  path: string,
  mode: "recursive" | "top-level" | "none",
): Promise<["done", undefined] | ["warning", string]> {
  // Only a missing `.gitmodules` means none; another error reading it is said.
  const hasSubmodules = await Fs.stat(Path.join(path, ".gitmodules")).then(
    () => true,
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : error),
  );
  if (hasSubmodules instanceof Error) {
    return ["warning", `submodules not checked out: ${hasSubmodules.message}`];
  }
  if (!hasSubmodules) return ["done", undefined];
  if (mode === "none") return ["warning", "submodules left empty"];
  let updated: { code: number; stderr: string };
  try {
    updated = await git(
      [
        "-C",
        path,
        "submodule",
        "update",
        "--init",
        ...(mode === "recursive" ? ["--recursive"] : []),
      ],
      { ok: [0, 1, 128], timeoutMs: WORKTREE_TIMEOUT_MS },
    );
  } catch (error) {
    // Any failure (another exit code, a timeout) leaves the worktree, made already, in use.
    return [
      "warning",
      `submodules not checked out: ${redactUrls((error as Error).message.split("\n")[0] ?? "")}`,
    ];
  }
  if (updated.code === 0) return ["done", undefined];
  // git's reason is its `fatal:` or `error:` line; progress ("Cloning into …") comes first.
  const lines = updated.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = (lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1) ?? "").replace(
    /^(fatal|error):\s*/,
    "",
  );
  return ["warning", `submodules not checked out${reason === "" ? "" : `: ${redactUrls(reason)}`}`];
}

/** A URL's credentials (`https://user:token@host`) never reach the setup card. */
export const redactUrls = (text: string) => text.replace(/(\w+:\/\/)[^/\s@]+@/g, "$1***@");

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
