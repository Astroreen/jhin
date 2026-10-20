import { z } from "@jhin/sdk";

/** `source-control.git@1`: git repositories of a node's projects (docs/plans/source-control.md). */
export const SOURCE_CONTROL_CAPABILITY = "source-control.git";

/**
 * The node's source control changes: one event per change of a project's
 * status or a thread's branch. Clients read `git.status` and follow this
 * stream after the `head` it returns.
 */
export const SOURCE_CONTROL_STREAM = "source-control";

export const SourceControlEvents = {
  /** A project's `ProjectStatus` after a change. */
  statusChanged: "source-control.status.changed",
  /** `{ projectId }`: the project went away. */
  projectRemoved: "source-control.project.removed",
  /** A thread's `ThreadBranch` after a change. */
  threadChanged: "source-control.thread.changed",
  /** `{ threadId }`: the thread went away. */
  threadRemoved: "source-control.thread.removed",
  /** A thread's `TurnCheckpoint` after a change (D245). */
  checkpointChanged: "source-control.checkpoint.changed",
} as const;

export const FileChangeStatus = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "type-changed",
]);
export type FileChangeStatus = z.output<typeof FileChangeStatus>;

/** One changed file of a working tree or a diff. */
export const ChangedFile = z.object({
  path: z.string(),
  /** Where a renamed or copied file came from. */
  previousPath: z.string().optional(),
  status: FileChangeStatus,
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** No line counts: git reports the file as binary. */
  binary: z.boolean(),
});
export type ChangedFile = z.output<typeof ChangedFile>;

/** Uncommitted changes against `HEAD`, untracked files included. */
export const WorkingTree = z.object({
  /** At most `MAX_STATUS_FILES`, sorted by path; `truncated` when there were more. */
  files: z.array(ChangedFile),
  fileCount: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type WorkingTree = z.output<typeof WorkingTree>;

/** How many files a status lists; the totals always count every file. */
export const MAX_STATUS_FILES = 200;

export const PullRequestState = z.enum(["open", "closed", "merged"]);
export type PullRequestState = z.output<typeof PullRequestState>;

/** The checks of a pull request's head commit, rolled up as T3 Code rolls them up. */
export const PullRequestChecks = z.object({
  /** `null` while no check reports anything that decides it. */
  state: z.enum(["passing", "failing", "pending"]).nullable(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type PullRequestChecks = z.output<typeof PullRequestChecks>;

export const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: PullRequestState,
  isDraft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  updatedAt: z.string().optional(),
  checks: PullRequestChecks,
});
export type PullRequest = z.output<typeof PullRequest>;

/**
 * Where a repository's pull requests come from. Only GitHub, through its CLI
 * (`gh`), today; `available` is false with a `reason` when `gh` is missing or
 * signed out, and pull requests are then unknown.
 */
export const PullRequestProvider = z.object({
  kind: z.literal("github"),
  available: z.boolean(),
  reason: z.string().optional(),
});
export type PullRequestProvider = z.output<typeof PullRequestProvider>;

/** One project's repository as its node sees it now. */
export const ProjectStatus = z.object({
  projectId: z.string(),
  /** False for a project that is not in a git repository (or git is missing: see `reason`). */
  isRepo: z.boolean(),
  reason: z.string().optional(),
  /** The repository's top-level directory. */
  root: z.string().optional(),
  /** The checked-out branch; `null` on a detached `HEAD`. */
  branch: z.string().nullable(),
  /** The upstream of `branch`, e.g. `origin/main`. */
  upstream: z.string().nullable(),
  /** Commits on `branch` its upstream lacks, and the reverse. */
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  /** The default branch: `origin/HEAD`'s, else `main` or `master` when it exists. */
  defaultBranch: z.string().nullable(),
  /** The URL of `origin` (or the first remote). */
  remoteUrl: z.string().nullable(),
  workingTree: WorkingTree,
  provider: PullRequestProvider.nullable(),
  /**
   * The pull request of each branch looked up (the checked-out one and the
   * threads' branches): `null` when the branch has none, absent while unknown.
   */
  pullRequests: z.record(z.string(), PullRequest.nullable()),
  checkedAt: z.string(),
});
export type ProjectStatus = z.output<typeof ProjectStatus>;

/**
 * The branch a thread works on: the branch checked out in its project when it
 * was created, and again whenever one of its turns starts or ends (D113).
 */
export const ThreadBranch = z.object({
  threadId: z.string(),
  projectId: z.string(),
  /** `null` when its project is no repository or `HEAD` was detached. */
  branch: z.string().nullable(),
  at: z.string(),
});
export type ThreadBranch = z.output<typeof ThreadBranch>;

export const CheckpointStatus = z.enum(["ready", "missing", "error", "stale"]);
export type CheckpointStatus = z.output<typeof CheckpointStatus>;

/**
 * The checkpoint a turn ended with (D243–D245): a commit of the thread's
 * working tree under `ref`, and the files the turn changed since the one
 * before it. `missing`: the directory is no repository; `error`: it could not
 * be written; `stale`: the thread was reverted to an earlier turn.
 */
export const TurnCheckpoint = z.object({
  threadId: z.string(),
  turnId: z.string(),
  /** The thread's turn count after this turn: 1 for its first turn. */
  turn: z.number().int().positive(),
  ref: z.string(),
  status: CheckpointStatus,
  /** At most `MAX_STATUS_FILES`, sorted by path; the totals count every file. */
  files: z.array(ChangedFile),
  fileCount: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  capturedAt: z.string(),
});
export type TurnCheckpoint = z.output<typeof TurnCheckpoint>;

/** What `git.status` returns: everything to show, and the stream head it reflects. */
export const StatusSnapshot = z.object({
  head: z.number().int().nonnegative(),
  projects: z.array(ProjectStatus),
  threads: z.array(ThreadBranch),
  /** Each thread's latest checkpoint (1.1). */
  checkpoints: z.array(TurnCheckpoint).optional(),
});
export type StatusSnapshot = z.output<typeof StatusSnapshot>;

/**
 * Which changes a diff shows, as T3 Code's diff panel offers them:
 * `uncommitted` against `HEAD`, `branch` against where the branch left its base,
 * `turn` what a thread's turn changed, between its checkpoints (1.1).
 */
export const DiffScope = z.enum(["uncommitted", "branch", "turn"]);
export type DiffScope = z.output<typeof DiffScope>;

/** A patch is cut after this many bytes (`truncated`); the file totals stay complete. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export const Diff = z.object({
  projectId: z.string(),
  scope: DiffScope,
  /** For `branch`: the base compared against, and the branch compared. */
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  /** For `turn`: the turn counts compared, `fromTurn → turn`. */
  fromTurn: z.number().int().nonnegative().optional(),
  turn: z.number().int().positive().optional(),
  /** A unified diff (`git diff` output), untracked files as additions. */
  patch: z.string(),
  truncated: z.boolean(),
  files: z.array(ChangedFile),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type Diff = z.output<typeof Diff>;

export const Branch = z.object({
  /** `main`, or `origin/main` for a remote branch. */
  name: z.string(),
  current: z.boolean(),
  isDefault: z.boolean(),
  isRemote: z.boolean(),
  upstream: z.string().nullable(),
});
export type Branch = z.output<typeof Branch>;

/** Error codes of the source control commands and service. */
export type SourceControlErrorCode =
  | "PROJECT_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  /** `git.checkout` named a thread of another project. */
  | "THREAD_PROJECT_MISMATCH"
  | "NOT_A_REPOSITORY"
  | "BRANCH_NOT_FOUND"
  | "BRANCH_INVALID"
  /** A turn diff names a turn without a ready checkpoint. */
  | "CHECKPOINT_UNAVAILABLE"
  | "GIT_FAILED";

/** The service of `source-control.git@1`, for other server plugins. */
export interface SourceControl {
  /** The project's status; `refresh` reads git and the pull requests again now. */
  status(projectId: string, options?: { refresh?: boolean }): Promise<ProjectStatus>;
  diff(
    projectId: string,
    options?: { scope?: DiffScope; base?: string; ignoreWhitespace?: boolean },
  ): Promise<Diff>;
  /** What a thread's turns changed, `fromTurn` (the turn before by default) to `turn` (1.1). */
  turnDiff(
    threadId: string,
    turn: number,
    options?: { fromTurn?: number; ignoreWhitespace?: boolean },
  ): Promise<Diff>;
  /** A thread's checkpoints, oldest first (1.1). */
  checkpoints(threadId: string): Promise<TurnCheckpoint[]>;
  branches(projectId: string): Promise<Branch[]>;
  /** Checks a branch out (`create`: a new one from `HEAD`); `threadId` moves that thread to it. */
  checkout(
    projectId: string,
    branch: string,
    options?: { create?: boolean; threadId?: string },
  ): Promise<ProjectStatus>;
  threadBranch(threadId: string): Promise<ThreadBranch | undefined>;
}
