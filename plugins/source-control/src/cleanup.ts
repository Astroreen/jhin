// Worktree cleanup follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/storageCleanup.ts (cleanWorktrees, localChangesReason and the
// reasons it keeps a worktree for) and packages/contracts/src/settings.ts
// (WorktreeCleanupRules).
import * as Fs from "node:fs/promises";

import { z } from "@jhin/sdk";

import type { Git } from "./git.ts";

const DAY_MS = 86_400_000;

/** T3's `WorktreeCleanupRules`, with T3's words (D1128). */
export const WorktreeCleanupConfig = z
  .object({
    onDelete: z.boolean().default(false).meta({
      title: "Delete worktrees with deleted threads",
      description:
        "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
    }),
    afterDays: z.number().int().min(1).max(3650).nullable().default(null).meta({
      title: "Delete inactive worktrees",
      description:
        "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
    }),
    settledAfterDays: z.number().int().min(0).max(3650).nullable().default(null).meta({
      title: "Delete settled worktrees",
      description:
        "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
    }),
    onMerge: z.boolean().default(false).meta({
      title: "Delete merged worktrees",
      description:
        "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
    }),
    unchanged: z.boolean().default(false).meta({
      title: "Delete unchanged worktrees",
      description: "Remove worktrees with no commits beyond the default branch.",
    }),
    keepWhen: z
      .union([
        z.literal("any-local-files").meta({ title: "Any local files" }),
        z.literal("uncommitted-changes").meta({ title: "Uncommitted changes" }),
        z.literal("tracked-changes").meta({ title: "Edited tracked files" }),
      ])
      .default("uncommitted-changes")
      .meta({
        title: "Keep worktrees with local changes",
        description:
          "Uncommitted changes keeps edits and untracked files and deletes ignored files, including .env; edited tracked files deletes untracked and ignored files too; any local files includes ignored files, except node_modules.",
      }),
  })
  .default({
    onDelete: false,
    afterDays: null,
    settledAfterDays: null,
    onMerge: false,
    unchanged: false,
    keepWhen: "uncommitted-changes",
  })
  .meta({ title: "Worktree cleanup" });
export type WorktreeCleanupRules = z.output<typeof WorktreeCleanupConfig>;

export const cleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.onDelete ||
  rules.afterDays !== null ||
  rules.settledAfterDays !== null ||
  rules.onMerge ||
  rules.unchanged;

/** One worktree of a sweep: what was done and why (T3's report entry). */
export const CleanupEntry = z.object({
  path: z.string(),
  threadId: z.string().optional(),
  outcome: z.enum(["removed", "kept", "failed"]),
  reason: z.string(),
});
export type CleanupEntry = z.output<typeof CleanupEntry>;

export const CleanupReport = z.object({
  entries: z.array(CleanupEntry),
  counts: z.object({
    removed: z.number().int(),
    kept: z.number().int(),
    failed: z.number().int(),
  }),
});
export type CleanupReport = z.output<typeof CleanupReport>;

/** T3's `sentence`: a reason as the report shows it. */
export const sentence = (reason: string) => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;

/** A worktree a sweep looks at, with what is known of the threads there. */
export interface CleanupCandidate {
  readonly path: string;
  readonly projectId: string;
  readonly projectPath: string;
  /** The branch its thread works on. */
  readonly branch: string;
  /** The thread (the first, when several) that works or worked there. */
  readonly threadId: string;
  /** The threads working there now; empty for a deleted thread's worktree. */
  readonly threads: readonly {
    readonly id: string;
    readonly running: boolean;
    /** It has had a turn: a thread still waiting for its first message keeps its fresh worktree. */
    readonly started?: boolean;
    /** Last activity, epoch ms. */
    readonly activeAt: number;
    readonly settledAt?: number | undefined;
  }[];
  /** Its thread was deleted (it worked there alone). */
  readonly deleted: boolean;
  /** The linked pull requests of its branch that merged: their base, and head commit if told. */
  readonly mergedInto: readonly { readonly base: string; readonly headSha?: string }[];
}

/** T3's `localChangesReason`: what counts as local changes under `keepWhen`. */
export async function localChangesReason(
  git: Git,
  keepWhen: WorktreeCleanupRules["keepWhen"],
  /** The worktree's folder: its submodules are asked only when it has a `.gitmodules`. */
  path?: string,
): Promise<string | null> {
  const status = await git([
    "status",
    "--porcelain=v1",
    "-z",
    "--ignore-submodules=none",
    keepWhen === "tracked-changes" ? "--untracked-files=no" : "--untracked-files=all",
  ]);
  const records = status.stdout.split("\0").filter(Boolean);
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    count++;
    // A rename or copy names its source in the next record.
    if (/^[RC]|^.[RC]/.test(records[index]!)) index++;
  }
  if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
  // A submodule's git folder lives in this worktree's, so a forced removal takes its own
  // commits (on its HEAD or any local branch) and its stashes, none of which a clean status
  // shows (D1134). A commit on a remote branch or a tag is safe; any other (one fetched by
  // hash alone, say) keeps the worktree, the safe side: forcing it away stays the user's.
  const hasSubmodules =
    path === undefined ||
    (await Fs.stat(`${path}/.gitmodules`).then(
      () => true,
      // Only a missing file means none: another error asks git all the same.
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
    ));
  const unpushed = !hasSubmodules
    ? { code: 0, stdout: "" }
    : await git(
        [
          "submodule",
          "foreach",
          "--quiet",
          "--recursive",
          "git rev-list -n 1 HEAD --branches --not --remotes --tags; git stash list -n 1",
        ],
        { ok: [0, 1, 128] },
      );
  if (unpushed.code !== 0) return "submodules could not be read";
  if (unpushed.stdout.trim() !== "") return "has unpushed submodule commits or stashes";
  if (keepWhen !== "any-local-files") return null;
  const ignored = await git([
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  const file = ignored.stdout
    .split("\0")
    .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
  return file === undefined ? null : `has ignored files (${file})`;
}

/** The commit a worktree's branch must be part of to count as unchanged. */
async function defaultCommit(git: Git): Promise<{ commit: string; branch: string } | undefined> {
  const head = (
    await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { ok: [0, 1, 128] })
  ).stdout.trim();
  const remoteDefault = head.startsWith("refs/remotes/origin/")
    ? head.slice("refs/remotes/origin/".length)
    : undefined;
  if (remoteDefault !== undefined) {
    await git(
      [
        "fetch",
        "--quiet",
        "--",
        "origin",
        `+refs/heads/${remoteDefault}:refs/remotes/origin/${remoteDefault}`,
      ],
      { ok: [0, 1, 128], timeoutMs: 300_000 },
    );
  }
  for (const [ref, branch] of [
    ...(remoteDefault === undefined
      ? []
      : [[`refs/remotes/origin/${remoteDefault}`, remoteDefault] as const]),
    ["refs/heads/main", "main"] as const,
    ["refs/heads/master", "master"] as const,
  ]) {
    const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      ok: [0, 1, 128],
    });
    if (found.code === 0) return { commit: found.stdout.trim(), branch };
  }
  return undefined;
}

/**
 * Decides one worktree, T3's `cleanWorktrees` for a thread: the reason to keep
 * it, or the reason it may go.
 */
export async function judge(
  candidate: CleanupCandidate,
  rules: WorktreeCleanupRules,
  options: {
    readonly now: number;
    readonly git: (cwd: string) => Git;
    /** The default branch's commit of each project, fetched once per sweep. */
    readonly defaults?: Map<string, Promise<{ commit: string; branch: string } | undefined>>;
    /** A terminal of the node works in the folder. */
    readonly hasTerminal: (path: string) => boolean;
  },
): Promise<{ keep: string } | { remove: string }> {
  const keep = (reason: string) => ({ keep: sentence(reason) });
  if (candidate.deleted && !rules.onDelete) return keep("no rules apply");
  // A live thread's worktree under the delete rule alone: nothing to read git for.
  if (!candidate.deleted && !cleanupEnabled({ ...rules, onDelete: false })) {
    return keep("no rules apply");
  }
  if (candidate.threads.length > 1) return keep(`shared by ${candidate.threads.length} threads`);
  if (candidate.threads.some((thread) => thread.running)) {
    return keep("thread is running or has pending work");
  }
  if (options.hasTerminal(candidate.path)) return keep("open terminal");
  const git = options.git(candidate.path);
  const current = (await git(["symbolic-ref", "--quiet", "HEAD"], { ok: [0, 1, 128] })).stdout
    .trim()
    .replace(/^refs\/heads\//, "");
  if (current !== candidate.branch) return keep("repository or branch changed");
  const changes = await localChangesReason(git, rules.keepWhen, candidate.path);
  if (changes !== null) return keep(changes);
  if (candidate.deleted) return { remove: sentence("thread was deleted") };

  const thread = candidate.threads[0];
  const activeAt = thread?.activeAt ?? options.now;
  const inactiveDays = Math.floor((options.now - activeAt) / DAY_MS);
  if (rules.afterDays !== null && options.now - activeAt >= rules.afterDays * DAY_MS) {
    return { remove: sentence(`inactive for ${inactiveDays} days`) };
  }
  // Settled since its last activity, as T3 counts it.
  const settledFor =
    thread?.settledAt === undefined ? null : options.now - Math.max(thread.settledAt, activeAt);
  const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
  if (
    settledFor !== null &&
    rules.settledAfterDays !== null &&
    settledFor >= rules.settledAfterDays * DAY_MS
  ) {
    return { remove: sentence(`settled for ${settledDays} days`) };
  }
  // A fresh worktree has no commits of its own yet: the commit rules wait for its first
  // turn, while inactivity still counts.
  if (
    (rules.unchanged || rules.onMerge) &&
    candidate.threads.some((thread) => thread.started === false)
  ) {
    return keep("thread has not started yet");
  }
  if (rules.unchanged || rules.onMerge) {
    // One fetch per project and sweep, however many of its worktrees are asked.
    const known = options.defaults?.get(candidate.projectPath);
    // A lookup that fails counts as no default branch, for this worktree and the rest.
    const pending =
      known ?? defaultCommit(options.git(candidate.projectPath)).catch(() => undefined);
    options.defaults?.set(candidate.projectPath, pending);
    const base = await pending;
    if (base === undefined) return keep("default branch is unavailable");
    const integrated =
      (await git(["merge-base", "--is-ancestor", "HEAD", base.commit], { ok: [0, 1, 128] }))
        .code === 0;
    if (integrated && rules.unchanged) {
      return { remove: sentence("no commits beyond the default branch") };
    }
    // T3's storageCleanupPullRequestMerged: its commits in the default branch, or (a squash
    // leaves them out) merged into it with the worktree still at the merged head commit, so
    // nothing made after the merge goes.
    if (rules.onMerge && candidate.mergedInto.length > 0) {
      const head = integrated
        ? undefined
        : (
            await git(["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [0, 1, 128] })
          ).stdout.trim();
      if (
        integrated ||
        candidate.mergedInto.some(
          (pr) => pr.base === base.branch && pr.headSha !== undefined && pr.headSha === head,
        )
      ) {
        return { remove: sentence("pull request was merged") };
      }
    }
  }
  return keep(
    rules.afterDays !== null
      ? `inactive for ${inactiveDays} of ${rules.afterDays} days`
      : rules.settledAfterDays !== null
        ? settledFor === null
          ? "not settled"
          : `settled for ${settledDays} of ${rules.settledAfterDays} days`
        : rules.onMerge
          ? "not merged"
          : rules.unchanged
            ? "has commits beyond the default branch"
            : // Only the delete rule (or none) for a thread that is still there.
              "no rules apply",
  );
}

export const exists = (path: string) =>
  Fs.stat(path).then(
    () => true,
    () => false,
  );
