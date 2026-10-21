import { z, type Disposable } from "@jhin/sdk";

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
  /** `{ threadId, pullRequest }`: a pull request was linked to a thread (D34, D267). */
  pullRequestLinked: "git.pr.linked",
  /** `{ threadId, key }`: a pull request was unlinked from a thread. */
  pullRequestUnlinked: "git.pr.unlinked",
  /** `{ threadId, pullRequest }`: a linked pull request's state (or its watch) changed. */
  pullRequestUpdated: "git.pr.updated",
  /** A thread's `TurnCheckpoint` after a change (D245). */
  checkpointChanged: "source-control.checkpoint.changed",
  /** A `WorktreeStatus` after a change: a worktree a thread works in (D251). */
  worktreeChanged: "source-control.worktree.changed",
  /** `{ worktreePath }`: no thread works in that worktree any more. */
  worktreeRemoved: "source-control.worktree.removed",
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
  /** When it merged or closed (ISO 8601), if it did. */
  mergedAt: z.string().optional(),
  closedAt: z.string().optional(),
  checks: PullRequestChecks,
});
export type PullRequest = z.output<typeof PullRequest>;

/** A pull request checked out for a thread (`git.pr.checkout`, D902). */
export const PreparedPullRequest = z.object({
  pullRequest: PullRequest,
  branch: z.string(),
  /** The worktree it is checked out in; `null` in the project's own checkout. */
  worktreePath: z.string().nullable(),
  /** False for a reused worktree whose branch could not be moved to the pull request's head. */
  isOnPullRequestHead: z.boolean(),
});
export type PreparedPullRequest = z.output<typeof PreparedPullRequest>;

/**
 * Where a repository's pull requests come from (D275): the forge of the
 * remote they go to, through its CLI or API; `available` is false with a
 * `reason` when its tool is missing or signed out, and pull requests are then
 * unknown.
 */
export const PullRequestProvider = z.object({
  kind: z.enum(["github", "gitlab", "azure-devops", "bitbucket", "forgejo"]),
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
  /**
   * Commits on `branch` its default branch lacks (T3's `aheadOfDefaultCount`):
   * whether there is anything for a pull request. Absent when unknown.
   */
  aheadOfDefault: z.number().int().nonnegative().optional(),
  /** The repository has a remote to push to (T3's `hasPrimaryRemote`). Absent when unknown. */
  hasPrimaryRemote: z.boolean().optional(),
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

// --- Pull requests linked to threads (D267–D271) ----------------------------------------------

/** Who linked a pull request to a thread, as T3 Code tells them apart. */
export const PullRequestLinkSource = z.enum(["manual", "created", "agent"]);
export type PullRequestLinkSource = z.output<typeof PullRequestLinkSource>;

/**
 * What a watch has told its thread already, so it tells each change once
 * (T3 Code's ThreadPullRequestWatch).
 */
export const PullRequestWatch = z.object({
  startedAt: z.string(),
  /** The head commit the check state below belongs to. */
  headSha: z.string().nullable(),
  failedChecks: z.array(z.string()),
  passed: z.boolean(),
  /** Comments up to this time were told; those at it, by id. */
  remarksThrough: z.string(),
  remarkIds: z.array(z.string()),
  conflicting: z.boolean(),
  /** Comment-only wakes in a row; the watch stops at `PULL_REQUEST_WATCH_WAKE_LIMIT`. */
  wakes: z.number().int().nonnegative(),
  /** Reads that failed in a row; the watch stops at `PULL_REQUEST_WATCH_FAILURE_LIMIT`. */
  failures: z.number().int().nonnegative().default(0),
});
export type PullRequestWatch = z.output<typeof PullRequestWatch>;

export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
export const PULL_REQUEST_WATCH_FAILURE_LIMIT = 8;

/** A pull request linked to a thread: identified by host, repository and number. */
export const ThreadPullRequest = z.object({
  /** `host/owner/repo#number`, lowercased: the identity links are compared by. */
  key: z.string(),
  host: z.string(),
  /** `owner/repo` (GitLab: the project's full path). */
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  source: PullRequestLinkSource,
  linkedAt: z.string(),
  /** What the forge last said about it; `null` until it was read. */
  snapshot: PullRequest.nullable(),
  /** When `snapshot` was read. */
  syncedAt: z.string().optional(),
  /** Set while the thread watches the pull request (D271). */
  watch: PullRequestWatch.optional(),
});
export type ThreadPullRequest = z.output<typeof ThreadPullRequest>;

/** The pull requests linked to a thread, in the order they were linked. */
export const ThreadPullRequests = z.object({
  threadId: z.string(),
  pullRequests: z.array(ThreadPullRequest),
});
export type ThreadPullRequests = z.output<typeof ThreadPullRequests>;
export const CheckpointStatus = z.enum(["ready", "error", "stale"]);
export type CheckpointStatus = z.output<typeof CheckpointStatus>;

/**
 * The checkpoint a turn ended with (D243–D245): a commit of the thread's
 * working tree under `ref`, and the files the turn changed since the one
 * before it. `error`: it could not be written, or the turn's start
 * checkpoint is missing or was given up on, so what it changed is unknown;
 * `stale`: the thread was reverted to an earlier turn (written by D257).
 * A directory that is no repository has no records.
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

/** The status of a worktree a thread works in (D251): its project's, read in the worktree. */
export const WorktreeStatus = ProjectStatus.extend({ worktreePath: z.string() });
export type WorktreeStatus = z.output<typeof WorktreeStatus>;

/** A worktree of a repository, as `git worktree list` lists it. */
export const Worktree = z.object({
  path: z.string(),
  /** `null` on a detached `HEAD`. */
  branch: z.string().nullable(),
  /** The repository's own working tree, not an added worktree. */
  main: z.boolean(),
  /** Under the node's worktrees directory: made here, and made again if it goes missing. */
  managed: z.boolean(),
  /** The threads that work in it. */
  threadIds: z.array(z.string()),
});
export type Worktree = z.output<typeof Worktree>;

/** A worktree just made (D250). */
export const CreatedWorktree = z.object({
  path: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  /** What the branch starts from: `baseRef`, or `refs/remotes/origin/<baseRef>`. */
  startRef: z.string(),
  /** Asked to start from origin, it did: false when origin has no such branch (T3's handoff result). */
  startedFromOrigin: z.boolean(),
});
export type CreatedWorktree = z.output<typeof CreatedWorktree>;

/** What `git.status` returns: everything to show, and the stream head it reflects. */
export const StatusSnapshot = z.object({
  head: z.number().int().nonnegative(),
  projects: z.array(ProjectStatus),
  threads: z.array(ThreadBranch),
  /** The pull requests linked to each thread that has any (D267). */
  links: z.array(ThreadPullRequests).optional(),
  /** Each thread's latest checkpoint (1.1). */
  checkpoints: z.array(TurnCheckpoint).optional(),
  /** The worktrees threads work in (1.1). */
  worktrees: z.array(WorktreeStatus).optional(),
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
  /** A new worktree's branch exists already. */
  | "BRANCH_EXISTS"
  /** The worktrees directory setting, or a path given as a worktree, is unusable. */
  | "WORKTREE_INVALID"
  /** A worktree to remove that threads still work in. */
  | "WORKTREE_IN_USE"
  /** A thread's worktree is gone and could not be made again. */
  | "WORKTREE_MISSING"
  /** A handoff of a thread that works in a worktree already. */
  | "ALREADY_IN_WORKTREE"
  | "THREAD_ARCHIVED"
  | "GIT_FAILED"
  /** A git action that cannot run now: a detached `HEAD`, nothing to commit, no remote. */
  | "ACTION_UNAVAILABLE"
  /** The forge refused or failed to create the pull request. */
  | "PULL_REQUEST_FAILED"
  /** A pull request to link is named by neither a URL nor a repository and number. */
  | "PULL_REQUEST_INVALID";

/** The service of `source-control.git@1`, for other server plugins. */
export interface SourceControl {
  /** The project's status; `refresh` reads git and the pull requests again now. */
  status(projectId: string, options?: { refresh?: boolean }): Promise<ProjectStatus>;
  diff(
    projectId: string,
    options?: {
      scope?: DiffScope;
      base?: string;
      ignoreWhitespace?: boolean;
      /** The thread's working directory instead: its worktree, when it has one (1.1). */
      threadId?: string;
    },
  ): Promise<Diff>;
  /** What a thread's turns changed, `fromTurn` (the turn before by default) to `turn` (1.1). */
  turnDiff(
    threadId: string,
    turn: number,
    options?: { fromTurn?: number; ignoreWhitespace?: boolean },
  ): Promise<Diff>;
  /** A thread's checkpoints, oldest first (1.1). */
  checkpoints(threadId: string): Promise<TurnCheckpoint[]>;
  /** A new worktree of a project's repository (1.1, D250). */
  createWorktree(
    projectId: string,
    options: {
      baseRef: string;
      branch?: string | undefined;
      startFromOrigin?: boolean | undefined;
    },
  ): Promise<CreatedWorktree>;
  /**
   * Removes a listed worktree no thread works in (`force`: with its changes;
   * `deleteBranch`: its branch too).
   */
  removeWorktree(
    projectId: string,
    path: string,
    options?: { force?: boolean; deleteBranch?: boolean },
  ): Promise<void>;
  worktrees(projectId: string): Promise<Worktree[]>;
  /** Moves a thread into a new worktree (1.1, D256). */
  handoff(
    threadId: string,
    options?: {
      branch?: string | undefined;
      baseRef?: string | undefined;
      startFromOrigin?: boolean | undefined;
    },
  ): Promise<CreatedWorktree>;
  branches(projectId: string, options?: { threadId?: string }): Promise<Branch[]>;
  /**
   * Checks a branch out (`create`: a new one from `HEAD`); `threadId` moves that
   * thread to it, in the thread's worktree when it has one.
   */
  checkout(
    projectId: string,
    branch: string,
    options?: { create?: boolean; threadId?: string },
  ): Promise<ProjectStatus>;
  threadBranch(threadId: string): Promise<ThreadBranch | undefined>;
  /** Runs a git action (D261): commit, push and create a pull request, in that order. */
  runAction(projectId: string, input: GitActionOptions): Promise<GitActionResult>;
  /** Pulls the checked-out branch from its upstream, fast-forward only. */
  pull(projectId: string): Promise<PullResult>;
}

// --- Git actions (docs/plans/source-control.md, D260–D266) -------------------------------

/**
 * T3 Code's stacked git actions: each runs its steps in order (feature
 * branch, commit, push, pull request) and stops at the first that fails.
 */
export const GitStackedAction = z.enum([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = z.output<typeof GitStackedAction>;

/** The steps of a git action, as its progress names them. */
export const GitActionPhase = z.enum(["branch", "commit", "push", "pr"]);
export type GitActionPhase = z.output<typeof GitActionPhase>;

export const GitActionOptions = z.object({
  action: GitStackedAction,
  /** Chosen by the client, so it can follow the action's progress before it starts. */
  actionId: z.string().min(1).max(200).optional(),
  /** First line the subject, the rest the body; written by the node's writer when absent. */
  commitMessage: z.string().trim().min(1).max(10_000).optional(),
  /** Commit on a new branch named after the changes (only for actions that commit). */
  featureBranch: z.boolean().optional(),
  /** Commit only these files (paths relative to the repository); every change when absent. */
  filePaths: z.array(z.string().min(1)).min(1).optional(),
  /** The thread the action is for: a new branch becomes its branch, a pull request is linked to it. */
  threadId: z.string().min(1).optional(),
});
export type GitActionOptions = z.input<typeof GitActionOptions>;

/** What T3 calls the forge's word for a pull request: GitLab says merge request. */
export const ChangeRequestTerminology = z.object({
  /** "pull request" */
  singular: z.string(),
  /** "PR" */
  shortLabel: z.string(),
});
export type ChangeRequestTerminology = z.output<typeof ChangeRequestTerminology>;

/** The call to action of a finished git action's toast. */
export const GitActionCta = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("open_pr"), label: z.string(), url: z.string() }),
  z.object({ kind: z.literal("run_action"), label: z.string(), action: GitStackedAction }),
]);
export type GitActionCta = z.output<typeof GitActionCta>;

export const GitActionResult = z.object({
  actionId: z.string(),
  action: GitStackedAction,
  branch: z.object({
    status: z.enum(["created", "skipped_not_requested"]),
    name: z.string().optional(),
  }),
  commit: z.object({
    status: z.enum(["created", "skipped_no_changes", "skipped_not_requested"]),
    sha: z.string().optional(),
    subject: z.string().optional(),
  }),
  push: z.object({
    status: z.enum(["pushed", "skipped_up_to_date", "skipped_not_requested"]),
    branch: z.string().optional(),
    upstream: z.string().optional(),
    setUpstream: z.boolean().optional(),
  }),
  pr: z.object({
    status: z.enum(["created", "opened_existing", "skipped_not_requested"]),
    pullRequest: PullRequest.optional(),
  }),
  toast: z.object({
    title: z.string(),
    description: z.string().optional(),
    cta: GitActionCta,
  }),
});
export type GitActionResult = z.output<typeof GitActionResult>;

export const PullResult = z.object({
  status: z.enum(["pulled", "skipped_up_to_date"]),
  branch: z.string(),
  upstream: z.string().nullable(),
});
export type PullResult = z.output<typeof PullResult>;

/**
 * A git action's progress, on the live stream `SOURCE_CONTROL_ACTIONS_STREAM`
 * (T3's `GitActionProgressEvent`): started with its phases, each phase with
 * its label, a commit hook's output, and how it ended.
 */
export const GitActionProgress = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action_started"),
    actionId: z.string(),
    projectId: z.string(),
    action: GitStackedAction,
    phases: z.array(GitActionPhase),
  }),
  z.object({
    kind: z.literal("phase_started"),
    actionId: z.string(),
    projectId: z.string(),
    action: GitStackedAction,
    phase: GitActionPhase,
    label: z.string(),
  }),
  z.object({
    kind: z.literal("hook_output"),
    actionId: z.string(),
    projectId: z.string(),
    action: GitStackedAction,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("action_finished"),
    actionId: z.string(),
    projectId: z.string(),
    action: GitStackedAction,
    result: GitActionResult,
  }),
  z.object({
    kind: z.literal("action_failed"),
    actionId: z.string(),
    projectId: z.string(),
    action: GitStackedAction,
    phase: GitActionPhase.nullable(),
    message: z.string(),
  }),
]);
export type GitActionProgress = z.output<typeof GitActionProgress>;

/** The live stream of git actions' progress (`rpc.streams@1`); nothing of it survives a restart. */
export const SOURCE_CONTROL_ACTIONS_STREAM = "source-control/actions";

/** Event type of every `GitActionProgress` on `SOURCE_CONTROL_ACTIONS_STREAM`. */
export const GIT_ACTION_PROGRESS = "source-control.action.progress";

/** Where a pull request lives, read from its URL. */
export interface PullRequestReference {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

const PULL_REQUEST_PATHS: readonly RegExp[] = [
  // GitHub, Forgejo and Gitea: /owner/repo/pull/7, /owner/repo/pulls/7
  /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)\/?$/,
  // GitLab: /group/sub/repo/-/merge_requests/7
  /^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/,
  // Bitbucket: /workspace/repo/pull-requests/7
  /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)\/?$/,
  // Azure DevOps: /org/project/_git/repo/pullrequest/7
  /^\/(.+?\/_git\/[^/]+)\/pullrequest\/(\d+)\/?$/,
];

/** The parts of an http(s) URL this contract needs; no `URL` here, the package is isomorphic. */
function splitUrl(
  url: string,
): { protocol: string; credentials: boolean; host: string; path: string } | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]*@)?([^/?#:]+)(:\d+)?([^?#]*)/i.exec(url.trim());
  if (match === null) return undefined;
  return {
    protocol: match[1]!.toLowerCase(),
    credentials: match[2] !== undefined,
    // The host alone, as remotes name it: a link's key is the same whichever way it was named.
    host: match[3]!.toLowerCase(),
    path: match[5] || "/",
  };
}

/** The host, repository and number of a pull request URL, or `undefined` for anything else. */
export function parsePullRequestUrl(url: string): PullRequestReference | undefined {
  const parsed = splitUrl(url);
  if (parsed === undefined || parsed.credentials) return undefined;
  if (parsed.protocol !== "https" && parsed.protocol !== "http") return undefined;
  const path = parsed.path.replace(/\/(files|commits|checks|diffs|overview)\/?$/, "");
  for (const pattern of PULL_REQUEST_PATHS) {
    const match = pattern.exec(path);
    if (match === null) continue;
    return {
      host: parsed.host,
      repository: decodeURIComponent(match[1]!),
      number: Number(match[2]),
    };
  }
  return undefined;
}

/** The host and `owner/repo` of a remote URL (`https://…`, `git@host:owner/repo.git`, `ssh://…`). */
export function repositoryOfRemote(url: string): { host: string; repository: string } | undefined {
  const scp = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (scp) return { host: scp[1]!.toLowerCase(), repository: scp[2]!.replace(/^\/+/, "") };
  const parsed = splitUrl(url);
  if (parsed === undefined) return undefined;
  const repository = parsed.path.replace(/^\/+/, "").replace(/(?:\.git)?\/?$/, "");
  if (repository === "") return undefined;
  return { host: parsed.host, repository };
}

/** The identity links are compared by: `host/owner/repo#number`, lowercased. */
export const pullRequestKey = (reference: PullRequestReference): string =>
  `${reference.host}/${reference.repository}#${reference.number}`.toLowerCase();

/** A chain of linked pull requests, bottom (the one closest to the base) to top. */
export interface PullRequestChain {
  /** Keys, bottom to top. */
  readonly keys: readonly string[];
}

/**
 * Chains linked pull requests into stacks, as T3 Code derives them: a pull
 * request's parent is the one of the same repository whose head is its base.
 * A head two of them share is ambiguous and chains nothing. Chains come
 * newest first (by their latest update or link).
 */
export function pullRequestChains(links: readonly ThreadPullRequest[]): PullRequestChain[] {
  const repoOf = (link: ThreadPullRequest) => `${link.host}/${link.repository}`.toLowerCase();
  const byHead = new Map<string, ThreadPullRequest | null>();
  for (const link of links) {
    const head = link.snapshot?.headBranch;
    if (!head) continue;
    const id = `${repoOf(link)}\u0000${head}`;
    byHead.set(id, byHead.has(id) ? null : link);
  }
  const parentOf = (link: ThreadPullRequest) => {
    const base = link.snapshot?.baseBranch;
    if (!base) return undefined;
    const parent = byHead.get(`${repoOf(link)}\u0000${base}`);
    return parent === null || parent === link ? undefined : parent;
  };
  const children = new Map<string, ThreadPullRequest[]>();
  const roots: ThreadPullRequest[] = [];
  for (const link of links) {
    const parent = parentOf(link);
    if (parent === undefined) roots.push(link);
    else children.set(parent.key, [...(children.get(parent.key) ?? []), link]);
  }
  const chains: { keys: string[]; latest: string }[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const keys: string[] = [];
    let latest = "";
    const walk = (link: ThreadPullRequest) => {
      if (seen.has(link.key)) return;
      seen.add(link.key);
      keys.push(link.key);
      const at = link.snapshot?.updatedAt ?? link.linkedAt;
      if (at > latest) latest = at;
      for (const child of children.get(link.key) ?? []) walk(child);
    };
    walk(root);
    chains.push({ keys, latest });
  }
  // A cycle (a base that is a later head) has no root: each of its links stands alone.
  for (const link of links) {
    if (!seen.has(link.key)) chains.push({ keys: [link.key], latest: link.linkedAt });
  }
  return chains
    .toSorted((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))
    .map(({ keys }) => ({ keys }));
}

/**
 * `source-control.diff-scopes@1`, provided by the web client's source control
 * plugin: the scopes its diff panel offers (D283). The builtin provider offers
 * "Changes" and "Uncommitted"; another plugin adds its own (a turn's diff) with
 * `register`, and its options join the panel's scope menu.
 */
export const DIFF_SCOPES_CAPABILITY = "source-control.diff-scopes";

/** What a diff scope is asked about: the thread on screen, or the project of a draft. */
export interface DiffScopeContext {
  /** The node's connection, and the mesh member reached through it if any. */
  readonly target: { readonly node: string; readonly remote?: string };
  readonly projectId: string;
  readonly threadId?: string;
}

/** One entry of the scope menu. */
export interface DiffScopeOption {
  /** Unique among every provider's options, e.g. `branch` or `turn:<id>`. */
  readonly value: string;
  readonly label: string;
  /** A submenu holding the option (T3's "Turn"); none lists it in the menu itself. */
  readonly group?: string;
  /** Shown at the option's right end, e.g. a time. */
  readonly detail?: string;
  /** The base ref picker applies: `load` receives the chosen `base`. */
  readonly baseRefs?: boolean;
}

export interface DiffScopeLoadInput {
  readonly ignoreWhitespace: boolean;
  /** For an option with `baseRefs`: the ref chosen to compare with (the default otherwise). */
  readonly base?: string;
}

/** A scope's diff: a unified patch with its totals. */
export interface DiffScopeResult {
  readonly patch: string;
  /** The patch was cut at the size limit; the totals stay complete. */
  readonly truncated: boolean;
  readonly insertions: number;
  readonly deletions: number;
  /** For a comparison: the ref compared against and the one compared. */
  readonly baseRef: string | null;
  readonly headRef: string | null;
}

export interface DiffScopeProvider {
  /** A stable id, e.g. `jhin.source-control.git`. */
  readonly id: string;
  /** Lower first; the builtin provider is 0. */
  readonly order?: number;
  /** The options for a context, newest first (compared by what they say, so a fresh array is fine). */
  options(context: DiffScopeContext): readonly DiffScopeOption[];
  /** `listener` fires when the options or their diffs change. */
  subscribe?(context: DiffScopeContext, listener: () => void): Disposable;
  load(
    context: DiffScopeContext,
    value: string,
    input: DiffScopeLoadInput,
  ): Promise<DiffScopeResult>;
}

/** The service of `source-control.diff-scopes@1`. */
export interface DiffScopes {
  register(provider: DiffScopeProvider): Disposable;
  /** Every provider, in order; the same array until one comes or goes. */
  providers(): readonly DiffScopeProvider[];
  subscribe(listener: () => void): Disposable;
}
