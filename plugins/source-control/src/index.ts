import { randomUUID } from "node:crypto";
import { constants as FsConstants } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
  ProjectScript,
  settleProjectScript,
  T3_PROJECT_FILE_MAX_BYTES,
  T3_PROJECT_FILE_NAME,
  parseT3ProjectFile,
  type T3ProjectFileRead,
  projectSettingsRecord,
  resolveProjectSettings,
  setupProjectScript,
  THREADS_STREAM,
  ThreadEvents,
  ThreadHooks,
  type AgentRegistry,
  type AgentRuntime,
  type TurnHookInput,
} from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { LIVE_STREAMS_CAPABILITY, createMemoryStreams, type LiveStreams } from "@jhin/rpc";
import { MESH_STREAMS_CAPABILITY, type MeshStreams } from "@jhin/mesh-api";
import { definePlugin, z, type PluginContext, describePermissions } from "@jhin/sdk";
import {
  Branch,
  Diff,
  DiffFileContents,
  DiffScope,
  GIT_ACTION_PROGRESS,
  GitActionOptions,
  GitActionResult,
  ProjectStatus,
  PreparedPullRequest,
  PullRequest,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullResult,
  SOURCE_CONTROL_ACTIONS_STREAM,
  PULL_REQUESTS_CAPABILITY,
  SOURCE_CONTROL_CAPABILITY,
  SOURCE_CONTROL_STREAM,
  SourceControlEvents,
  StatusSnapshot,
  CreatedWorktree,
  ThreadBranch,
  ThreadPullRequest,
  parsePullRequestUrl,
  pullRequestChains,
  pullRequestKey,
  type GitActionProgress,
  TurnCheckpoint,
  Worktree,
  WORKTREE_SETUP_CHANGED,
  WORKTREE_SETUP_STREAM_PREFIX,
  WorktreeSetupSnapshot,
  worktreeSetupStream,
  type PullRequestProvider,
  type SourceControl,
  type ThreadPullRequestStates,
} from "@jhin/source-control-api";
import {
  TERMINAL_SESSIONS_CAPABILITY,
  terminalStream,
  type TerminalSessions,
} from "@jhin/terminal-api";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
  appendKeepingNewest,
  keepNewest,
  type StoredEvent,
} from "@jhin/storage-api";

import {
  SourceControlError,
  checkout,
  createGit,
  locate,
  readBranches,
  readDefaultBranch,
  readDiffFile,
  readLocalStatus,
  readPatch,
  readRemoteUrl,
  summarize,
  type Git,
  type LocalStatus,
  type Repository,
} from "./git.ts";
import {
  aheadOfBase,
  baseRemoteOf,
  headContextOf,
  remoteUrlOf,
  pull,
  runStackedAction,
  type PullRequestCreator,
} from "./actions.ts";
import {
  FORGE_KINDS,
  ForgeUnavailable,
  forgeKindOf,
  forgeName,
  type Forge,
  type ForgeKind,
} from "./forge.ts";
import { bitbucketCredentials, bitbucketForge } from "./bitbucket.ts";
import { forgejoForge } from "./forgejo.ts";
import { azureForge, gitlabForge, siteOf } from "./forges.ts";
import { githubForge, remoteHost } from "./github.ts";
import type { Viewers } from "./forge.ts";
import { createLinks, type LinkTarget } from "./links.ts";
import { createWatcher } from "./watcher.ts";
import {
  checkoutLocal,
  checkoutWorktree,
  isPullRequestOf,
  normalizeReference,
} from "./checkout.ts";
import { followTurns } from "./turns.ts";
import { writeWorkingTree } from "./checkpoints.ts";
import {
  createWorktree,
  firstMessageInputOf,
  isManagedWorktree,
  isTemporaryBranch,
  listWorktrees,
  recreateWorktree,
  removeWorktree,
  renameTemporaryBranch,
  worktreesRoot,
  hasCheckedOutSubmodules,
  submodulesNeedForce,
} from "./worktrees.ts";
import { watchTree, type TreeWatcher } from "./watch.ts";
import {
  CleanupReport,
  ProjectWorktreeCleanup,
  WorktreeCleanupConfig,
  cleanupEnabled,
  orphanEntries,
  resolveWorktreeCleanup,
  exists,
  judge,
  localChangesReason,
  sentence,
  type CleanupCandidate,
  type CleanupEntry,
} from "./cleanup.ts";
import {
  completionShellOf,
  createSetupTracker,
  runSetupScript,
  scriptCommandLine,
  scriptTerminalId,
  setupTerminalId,
  type FollowTerminal,
} from "./setup.ts";
import { agentWriter } from "./writer.ts";

export { parseNumstat, parseStatus } from "./git.ts";
export { remoteHost, rollupChecks } from "./github.ts";
export { forgeKindOf, matchesHead } from "./forge.ts";
export {
  parseCommitMessage,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
  sanitizeSubject,
  splitUpstream,
} from "./actions.ts";
export { agentWriter, parseJsonObject, plainWriter } from "./writer.ts";
export { createLinks, pullRequestUrl } from "./links.ts";
export { evaluateWatch, startWatch, watchMessage } from "./pr-watch.ts";
export { createWatcher } from "./watcher.ts";

export const CONFIG_SECTION = "jhin.source-control";
const NAMESPACE = "jhin.source-control";

/**
 * Events of the `source-control` stream kept (D497): clients follow it from
 * the head `git.status` names, so older ones are never read again. It is
 * trimmed at start and after every `TRIM_EVERY`th append.
 */
export const HISTORY = 1000;
const TRIM_EVERY = 100;

/** Changes that come close together are read once: this long after the last of them… */
const SETTLE_MS = 150;
/** …but no later than this after the first, so a steady stream of writes still shows. */
const MAX_SETTLE_MS = 1000;

const SubmodulesSetting = z.union([
  z.literal("recursive").meta({ title: "Recursive" }),
  z.literal("top-level").meta({ title: "Top level only" }),
  z.literal("none").meta({ title: "Skip" }),
]);
const BranchNamingMode = z.union([
  z.literal("static").meta({ title: "Static prefix" }),
  z.literal("semantic").meta({ title: "Semantic prefix" }),
  z.literal("custom").meta({ title: "Custom instructions" }),
]);
const BRANCH_NAMING_MODE_META = {
  title: "Worktree branch naming",
  description:
    "Choose how new worktree branches are named from your first message. Semantic prefix: the model chooses a prefix that describes the work, such as feat/add-search, fix/login-timeout, or refactor/auth.",
};
const BRANCH_NAME_PREFIX_META = {
  title: "Branch prefix",
  description: "For example, jhin or jhin/ produces jhin/add-search. Leave empty for no prefix.",
  when: { branchNamingMode: "static" },
  clearWhenEmpty: "persist",
};
const BRANCH_NAME_INSTRUCTIONS_META = {
  title: "Branch naming instructions",
  description:
    "Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added.",
  when: { branchNamingMode: "custom" },
  examples: ["Use julius/ followed by the issue ID and a short description."],
  // T3's text area (D1461).
  multiline: true,
};
/** The keys a project's entry replaces whole; its worktree cleanup is resolved apart (D1468). */
const PROJECT_KEYS = [
  "worktreeSubmodules",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
] as const;

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
export const Config = z
  .object({
    watch: z.boolean().default(true).meta({
      title: "Watch repositories",
      description:
        "Follow changes to the projects' files and git metadata as they happen; otherwise a repository is read again when a turn ends or a client asks",
    }),
    pullRequestRefreshSeconds: z.number().int().min(0).max(86_400).default(60).meta({
      title: "Pull request refresh (seconds)",
      description:
        "How often pull requests and their checks are read again; 0 reads them only when asked",
    }),
    githubHosts: z.array(z.string()).default(["github.com"]).meta({
      title: "GitHub hosts",
      description:
        "Remote hosts whose pull requests are read with the GitHub CLI (gh), besides those recognised as GitHub (github.com, *.ghe.com, hosts named github)",
      advanced: true,
    }),
    forgeHosts: z.record(z.string(), z.enum(FORGE_KINDS)).default({}).meta({
      title: "Forge hosts",
      description:
        "Which forge a remote host is, for self-hosted ones whose name does not say (git.example.com: gitlab)",
      advanced: true,
    }),
    // Below the threads plugin's 60 s turn hook deadline, so the start never fails the turn (D244).
    checkpointStartTimeoutSeconds: z.number().min(0).max(55).default(45).meta({
      title: "Checkpoint start timeout (seconds)",
      description:
        "How long a turn's start waits for its checkpoint before its agent starts anyway; that turn's changes then show as unknown. Keep it below the threads plugin's turn hook timeout",
      advanced: true,
    }),
    gitPath: z
      .string()
      .default("git")
      .meta({ title: "git executable", description: "Path to git", advanced: true }),
    worktreesDirectory: z.string().default("").meta({
      title: "Worktrees directory",
      description:
        "Where new worktrees of threads are made, as <directory>/<repository>/<branch>; the node's worktrees folder (~/.jhin/worktrees) when empty",
      advanced: true,
    }),
    ghPath: z.string().default("gh").meta({
      title: "GitHub CLI executable",
      description: "Path to gh, the GitHub CLI",
      advanced: true,
    }),
    glabPath: z.string().default("glab").meta({
      title: "GitLab CLI executable",
      description: "Path to glab, the GitLab CLI",
      advanced: true,
    }),
    azPath: z.string().default("az").meta({
      title: "Azure CLI executable",
      description: "Path to az, the Azure CLI with its azure-devops extension",
      advanced: true,
    }),
    teaPath: z.string().default("tea").meta({
      title: "Forgejo and Gitea CLI executable",
      description: "Path to tea, the Gitea CLI (it serves Forgejo too)",
      advanced: true,
    }),
    // Bitbucket's token as the node's secret (D1446): `writeOnly`, so the config file holds a
    // reference and the value lives in the secret store; the environment is read without it.
    bitbucketAccessToken: z.string().optional().meta({
      title: "Bitbucket access token",
      description:
        "A Bitbucket Cloud access token (repository, project or workspace) the node reads pull requests with; JHIN_BITBUCKET_ACCESS_TOKEN when unset",
      writeOnly: true,
      advanced: true,
    }),
    bitbucketEmail: z.string().optional().meta({
      title: "Bitbucket email",
      description:
        "The Atlassian account's email for a Bitbucket API token (with Bitbucket API token); JHIN_BITBUCKET_EMAIL when unset",
      advanced: true,
    }),
    bitbucketApiToken: z.string().optional().meta({
      title: "Bitbucket API token",
      description:
        "An Atlassian API token with Bitbucket scopes, used with Bitbucket email when no access token is set; JHIN_BITBUCKET_API_TOKEN when unset",
      writeOnly: true,
      advanced: true,
    }),
    bitbucketApiBaseUrl: z.string().optional().meta({
      title: "Bitbucket API URL",
      description:
        "The Bitbucket API's base URL; https://api.bitbucket.org/2.0 (or JHIN_BITBUCKET_API_BASE_URL) when unset",
      advanced: true,
    }),
    watchSweepSeconds: z.number().int().min(0).max(86_400).default(120).meta({
      title: "Pull request watch (seconds)",
      description:
        "How often watched pull requests are read for finished checks, new comments and conflicts; 0 reads them only when asked",
    }),
    writerTimeoutSeconds: z.number().int().min(1).max(3_600).default(120).meta({
      title: "Writer time limit (seconds)",
      description:
        "How long the writer agent may take; past it the message is written without a model",
      advanced: true,
    }),
    // T3's file-backed worktreeSubmodules: unset, the project's t3.json decides (D1467).
    worktreeSubmodules: SubmodulesSetting.optional().meta({
      title: "Worktree submodules",
      description:
        "How new worktrees populate git submodules. Recursive checks out submodules and theirs; Top level only checks out the repository's own and leaves theirs empty; Skip leaves every submodule empty, for a setup script to handle. Unset: the project's t3.json decides, else Recursive.",
    }),
    // T3's branch naming settings (D1126), with T3's words.
    branchNamingMode: BranchNamingMode.default("static").meta(BRANCH_NAMING_MODE_META),
    branchNamePrefix: z.string().trim().default("jhin").meta(BRANCH_NAME_PREFIX_META),
    branchNameInstructions: z.string().trim().default("").meta(BRANCH_NAME_INSTRUCTIONS_META),
    // T3's worktree cleanup rules (D1128), all off by default.
    worktreeCleanup: WorktreeCleanupConfig,
    // T3's projectSettingsOverrides of the settings above (D1466, config-ui.md D1462).
    projects: projectSettingsRecord({
      worktreeSubmodules: SubmodulesSetting.optional().meta({
        title: "Worktree submodules",
        description: "How this project's new worktrees populate git submodules.",
        // The t3.json field that backs it, and what applies when nothing is set (D1467).
        t3File: "worktreeSubmodules",
        builtIn: "recursive",
      }),
      branchNamingMode: BranchNamingMode.optional().meta(BRANCH_NAMING_MODE_META),
      branchNamePrefix: z.string().trim().optional().meta(BRANCH_NAME_PREFIX_META),
      branchNameInstructions: z.string().trim().optional().meta(BRANCH_NAME_INSTRUCTIONS_META),
      worktreeCleanup: ProjectWorktreeCleanup.optional(),
    }),
    writerAgent: z.string().optional().meta({
      title: "Writer agent",
      description:
        "The agent runtime that writes commit messages and pull requests, by id (see agents.list); the thread's agent, else the first available one, when unset",
      advanced: true,
    }),
  })
  .meta({
    title: "Source control",
    description: "Git status, diffs, branches and pull requests of this node's projects.",
  });
export type Config = z.output<typeof Config>;

interface ProjectRef {
  readonly id: string;
  readonly path: string;
  /** The node's project for chats without one (D51): never read as a repository. */
  readonly scratch?: boolean;
}

interface CachedPullRequest {
  readonly pr: PullRequest | null;
  readonly at: number;
}

/** One project followed by the plugin, or a worktree of one that a thread works in. */
interface Repo {
  project: ProjectRef;
  /** For a worktree: its path (`project.path` too); its status goes out as a `WorktreeStatus`. */
  worktree: string | undefined;
  location: Repository | undefined;
  git: Git | undefined;
  status: ProjectStatus | undefined;
  /** The first status; later reads go through `refresh`. */
  ready: Promise<ProjectStatus>;
  /** Reads of the repository run one at a time. */
  chain: Promise<unknown>;
  /** A read is queued behind the running one already. */
  queued: Promise<ProjectStatus> | undefined;
  watcher: TreeWatcher | undefined;
  settle: ReturnType<typeof setTimeout> | undefined;
  firstChangeAt: number | undefined;
  pullRequests: Map<string, CachedPullRequest>;
  prChain: Promise<unknown>;
  provider: PullRequestProvider | null;
  /** The forge of the remote pull requests go to, and that remote's URL. */
  forge: { readonly kind: ForgeKind; readonly url: string } | undefined;
  /** When `gh` last could not answer; it is asked again once a refresh period has passed. */
  unavailableAt: number | undefined;
  disposed: boolean;
}

const emptyTree = () => summarize([]);

function nonRepository(projectId: string, reason: string): ProjectStatus {
  return {
    projectId,
    isRepo: false,
    reason,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    defaultBranch: null,
    remoteUrl: null,
    workingTree: emptyTree(),
    provider: null,
    pullRequests: {},
    checkedAt: new Date().toISOString(),
  };
}

/** Two statuses say the same, whenever they were read. */
const sameStatus = (a: ProjectStatus | undefined, b: ProjectStatus) =>
  a !== undefined &&
  JSON.stringify({ ...a, checkedAt: "" }) === JSON.stringify({ ...b, checkedAt: "" });

const isCommandMissing = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "COMMAND_NOT_FOUND";

/**
 * A branch's `t3.json` read once, from one open file: none without one, why
 * not when it is no regular file of at most 1 MiB, cannot be read, or is no
 * T3 project file (D1467). The threads plugin reads a project's the same way.
 */
async function readT3File(
  file: string,
): Promise<T3ProjectFileRead | { file: null; error?: undefined }> {
  let handle: Fs.FileHandle;
  try {
    handle = await Fs.open(file, FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: null };
    return {
      file: null,
      error: `${T3_PROJECT_FILE_NAME} cannot be read: ${(error as Error).message}`,
    };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > T3_PROJECT_FILE_MAX_BYTES) {
      return { file: null, error: `${T3_PROJECT_FILE_NAME} is not a file of at most 1 MiB` };
    }
    return parseT3ProjectFile(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export function activateSourceControl(context: PluginContext): SourceControl {
  const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
  const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
  const hostPaths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
  context.subscriptions.add(context.config.define(CONFIG_SECTION, Config));
  // D501: members relay the stream to their clients (D503).
  const mesh = context.services.tryGet<MeshStreams>(MESH_STREAMS_CAPABILITY);
  if (mesh !== undefined) context.subscriptions.add(mesh.share(SOURCE_CONTROL_STREAM));
  const config = () => context.config.get<Config>(CONFIG_SECTION);
  /** The section as a project sees it: its own settings over the node's (D1466). */
  const projectConfig = (projectId: string | undefined) =>
    resolveProjectSettings(config(), projectId, PROJECT_KEYS);
  /** A project's worktree cleanup rules: its own Off or Custom, else the node's (D1468). */
  const cleanupRulesOf = (projectId: string | undefined) =>
    resolveWorktreeCleanup(
      config().worktreeCleanup,
      projectId === undefined ? undefined : config().projects[projectId]?.worktreeCleanup,
    );
  /** Some rule, the node's or a project's, may remove a worktree. */
  const anyCleanupEnabled = () =>
    cleanupEnabled(config().worktreeCleanup) ||
    Object.keys(config().projects).some((projectId) => cleanupEnabled(cleanupRulesOf(projectId)));
  /**
   * How a project's new worktree populates its submodules: the project's
   * setting, the node's, the worktree's own `t3.json`, else recursive (D1467).
   */
  const submodulesOf = (projectId: string) => async (worktree: string) => {
    const configured = projectConfig(projectId).worktreeSubmodules;
    if (configured !== undefined) return configured;
    const read = await readT3File(Path.join(worktree, T3_PROJECT_FILE_NAME));
    if (read.error !== undefined) {
      context.log.warn("ignored a worktree's t3.json", { worktree, error: read.error });
    }
    return read.file?.worktreeSubmodules ?? "recursive";
  };
  // Its events name repositories and branches: reading them takes git.read (security.md D415).
  const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
  if (live?.guard !== undefined) {
    context.subscriptions.add(live.guard(SOURCE_CONTROL_STREAM, ["git.read"]));
  }

  // A git action's progress is a live stream (D263): clients follow it while the action runs.
  const progressStreams = createMemoryStreams({ log: context.log });
  if (live !== undefined) {
    context.subscriptions.add(
      // A commit hook's output may hold secrets: following it takes what running an action takes.
      live.serve(SOURCE_CONTROL_ACTIONS_STREAM, progressStreams, { permissions: ["git.write"] }),
    );
  }
  /** How many progress events the stream keeps for clients that subscribe late. */
  const KEPT_PROGRESS = 500;
  const publishProgress = (event: GitActionProgress) => {
    progressStreams.append(SOURCE_CONTROL_ACTIONS_STREAM, GIT_ACTION_PROGRESS, event as never);
    const kept = progressStreams.events(SOURCE_CONTROL_ACTIONS_STREAM).length;
    if (kept > KEPT_PROGRESS)
      progressStreams.drop(SOURCE_CONTROL_ACTIONS_STREAM, kept - KEPT_PROGRESS);
  };
  /**
   * Writes to a project's repository (git actions, pulls, checkouts) run one at
   * a time, so none moves `HEAD` under another; a project's entry goes once its
   * last write is done.
   */
  const writeChains = new Map<string, Promise<unknown>>();
  function exclusive<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const next = (writeChains.get(projectId) ?? Promise.resolve()).then(task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    writeChains.set(projectId, settled);
    void settled.then(() => {
      if (writeChains.get(projectId) === settled) writeChains.delete(projectId);
    });
    return next;
  }

  const repos = new Map<string, Repo>();
  /** The worktrees threads work in, by path (D251). */
  const worktreeRepos = new Map<string, Repo>();
  /** Every followed repository: the projects' and the worktrees'. */
  const allRepos = () => [...repos.values(), ...worktreeRepos.values()];
  /** Where each thread works: its project, and its worktree if it has one. */
  const threadDirs = new Map<string, { projectId: string; worktreePath: string | undefined }>();
  const threads = new Map<string, ThreadBranch>();
  /** The last turn state seen per thread (`turnId:status`), so each change is handled once. */
  const lastTurns = new Map<string, string>();
  let stopped = false;
  let projectsLoaded: Promise<void> | undefined;
  /** Events of the `threads` index are handled one at a time, in order. */
  let indexChain: Promise<unknown> = Promise.resolve();
  let threadsLoaded: Promise<void> | undefined;

  const onTrimError = (error: unknown) =>
    context.log.warn("source control history not trimmed", { error: String(error) });
  const append = async (type: string, payload: unknown) => {
    if (stopped) return;
    await appendKeepingNewest(log, SOURCE_CONTROL_STREAM, [{ type, payload: payload as Json }], {
      keep: HISTORY,
      every: TRIM_EVERY,
      onTrimError,
    });
  };
  /** The trim at start; the first `git.status` waits for it. */
  const started = keepNewest(log, SOURCE_CONTROL_STREAM, HISTORY).catch(onTrimError);

  // --- Pull requests linked to threads (D267–D270) ------------------------------------

  /** The project's repository of a thread, once it is known. */
  const projectRepoOfThread = async (threadId: string): Promise<Repo | undefined> => {
    const projectId = await threadProject(threadId).catch(() => undefined);
    return projectId === undefined ? undefined : repos.get(projectId);
  };
  /** The forge a linked pull request's host is, working in its thread's project. */
  const forgeOfLink = async (threadId: string, host: string): Promise<Forge | undefined> => {
    const kind = kindOfHost(host);
    if (kind === undefined) return undefined;
    const repo = await projectRepoOfThread(threadId);
    const cwd =
      repo?.location?.isRepo === true ? repo.location.root : (repo?.project.path ?? process.cwd());
    return makeForge(kind, cwd, undefined);
  };
  const links = createLinks({
    kv,
    append: async (type, payload) => {
      await append(type, payload);
      // A linked pull request that merged or closed may settle its thread (D1133).
      const { threadId, pullRequest } = payload as {
        threadId?: string;
        pullRequest?: ThreadPullRequest;
      };
      // …and so may unlinking the one that held it open.
      if (
        threadId !== undefined &&
        !removingThreads.has(threadId) &&
        (type === SourceControlEvents.pullRequestUnlinked ||
          ((type === SourceControlEvents.pullRequestUpdated ||
            type === SourceControlEvents.pullRequestLinked) &&
            pullRequest?.snapshot != null &&
            pullRequest.snapshot.state !== "open"))
      ) {
        void settleOnLinks(threadId).catch((error: unknown) =>
          context.log.warn("settling a thread on its linked pull requests failed", {
            threadId,
            error: String(error),
          }),
        );
      }
    },
    remoteOf: async (threadId) => {
      const repo = await projectRepoOfThread(threadId);
      return repo === undefined
        ? null
        : ((await statusOf(repo).catch(() => undefined))?.remoteUrl ?? null);
    },
    read: async (threadId, link) => (await forgeOfLink(threadId, link.host))?.at(link.url),
    warn: (message, fields) => context.log.warn(message, fields),
  });

  // --- Watching linked pull requests (D271–D274) ---------------------------------------
  /** The node's GitHub accounts as `gh` last named them, for as long as the plugin runs. */
  const viewers: Viewers = new Map();
  const watcher = createWatcher({
    kv,
    links,
    read: async (threadId, link) => (await forgeOfLink(threadId, link.host))?.watch?.(link.url),
    thread: async (threadId) => {
      const answer = (await context.commands
        .execute("threads.get", { threadId })
        .catch(() => undefined)) as
        | { thread: { archivedAt?: string; lastTurn?: { status?: string } } }
        | undefined;
      if (answer === undefined) return undefined;
      const status = answer.thread.lastTurn?.status;
      return {
        archived: answer.thread.archivedAt !== undefined,
        busy: status === "running" || status === "waiting",
      };
    },
    send: async (threadId, text) => {
      await context.commands.execute("threads.send", { threadId, text });
    },
    warn: (message, fields) => context.log.warn(message, fields),
  });

  // --- Thread branches ---------------------------------------------------------

  const loadThreads = () =>
    (threadsLoaded ??= (async () => {
      for (const entry of await kv.list(NAMESPACE, { prefix: "thread/" })) {
        const parsed = ThreadBranch.safeParse(entry.value);
        if (parsed.success) threads.set(parsed.data.threadId, parsed.data);
      }
    })());

  const setThreadBranch = async (threadId: string, projectId: string, branch: string | null) => {
    await loadThreads();
    const known = threads.get(threadId);
    if (known !== undefined && known.projectId === projectId && known.branch === branch) return;
    const record: ThreadBranch = { threadId, projectId, branch, at: new Date().toISOString() };
    threads.set(threadId, record);
    await kv.set(NAMESPACE, `thread/${threadId}`, record as unknown as Json);
    await append(SourceControlEvents.threadChanged, record);
    const repo = repos.get(projectId);
    if (repo !== undefined && branch !== null) void lookUpPullRequests(repo, { force: false });
  };

  /** Threads going away: their links' removal settles nothing (D1133). */
  const removingThreads = new Set<string>();
  const removeThread = async (threadId: string) => {
    await loadThreads();
    // Going away for the whole removal: a settle already on its way decides nothing.
    removingThreads.add(threadId);
    try {
      await links.remove(threadId);
      await turns.remove(threadId);
      if (!threads.delete(threadId)) return;
      lastTurns.delete(threadId);
      await kv.delete(NAMESPACE, `thread/${threadId}`);
      await append(SourceControlEvents.threadRemoved, { threadId });
    } finally {
      removingThreads.delete(threadId);
      heldThreads.delete(threadId);
      unsettledByLinks.delete(threadId);
      const told = `${JSON.stringify([threadId]).slice(0, -1)},`;
      for (const key of Array.from(announced)) if (key.startsWith(told)) announced.delete(key);
    }
  };

  // --- Checkpoints (D243–D246) ------------------------------------------------------

  const turns = followTurns(context, {
    kv,
    gitPath: () => config().gitPath,
    startTimeoutMs: () => config().checkpointStartTimeoutSeconds * 1000,
    append,
    isScratch: async (projectId) =>
      (await repoOf(projectId).catch(() => undefined))?.project.scratch === true,
  });

  // --- Projects ------------------------------------------------------------------

  /** Reads the projects from `projects.list` once; until a threads plugin answers, again each time. */
  const loadProjects = () =>
    (projectsLoaded ??= (async () => {
      try {
        const projects = (await context.commands.execute("projects.list", {})) as ProjectRef[];
        for (const project of projects) track(project);
        // The worktrees threads already work in; later moves come through the index.
        // Agents' generations work in worktrees too (D745).
        const listed = (await context.commands.execute("threads.list", {
          includeGenerations: true,
        })) as Record<string, unknown>[];
        for (const thread of listed) {
          if (typeof thread["id"] === "string") await noteDir(thread["id"], thread);
        }
      } catch (error) {
        projectsLoaded = undefined;
        if (!isCommandMissing(error)) throw error;
      }
    })());

  const repoOf = async (projectId: string): Promise<Repo> => {
    await loadProjects();
    const repo = repos.get(projectId);
    if (repo === undefined) {
      throw new SourceControlError("PROJECT_NOT_FOUND", `No project ${projectId} on this node`, {
        projectId,
      });
    }
    return repo;
  };

  const track = (project: ProjectRef): Repo => {
    const known = repos.get(project.id);
    if (known !== undefined && known.project.path === project.path) return known;
    if (known !== undefined) untrack(known);
    const repo = newRepo(project, undefined);
    repos.set(project.id, repo);
    start(repo);
    return repo;
  };

  /** Follows a worktree a thread works in, as a repository of the thread's project. */
  const trackWorktree = (projectId: string, path: string): Repo => {
    const known = worktreeRepos.get(path);
    if (known !== undefined) return known;
    const repo = newRepo({ id: projectId, path }, path);
    worktreeRepos.set(path, repo);
    start(repo);
    return repo;
  };

  const newRepo = (project: ProjectRef, worktree: string | undefined): Repo => ({
    project: { id: project.id, path: project.path, scratch: project.scratch === true },
    worktree,
    location: undefined,
    git: undefined,
    status: undefined,
    ready: Promise.resolve(undefined as unknown as ProjectStatus),
    chain: Promise.resolve(),
    queued: undefined,
    watcher: undefined,
    settle: undefined,
    firstChangeAt: undefined,
    pullRequests: new Map(),
    prChain: Promise.resolve(),
    provider: null,
    forge: undefined,
    unavailableAt: undefined,
    disposed: false,
  });

  const start = (repo: Repo) => {
    repo.ready = refresh(repo);
    // A failed first read surfaces to whoever asks; nobody may be waiting now.
    repo.ready.catch((error: unknown) =>
      context.log.warn("reading a repository failed", {
        projectId: repo.project.id,
        ...(repo.worktree === undefined ? {} : { worktreePath: repo.worktree }),
        error: String(error),
      }),
    );
  };

  /** Stops following the repository on disk, a read already waiting for changes to settle included. */
  const stopWatching = (repo: Repo) => {
    repo.watcher?.dispose();
    repo.watcher = undefined;
    if (repo.settle !== undefined) clearTimeout(repo.settle);
    repo.settle = undefined;
    repo.firstChangeAt = undefined;
  };

  const untrack = (repo: Repo) => {
    repo.disposed = true;
    stopWatching(repo);
    if (repo.worktree !== undefined) {
      if (worktreeRepos.get(repo.worktree) === repo) worktreeRepos.delete(repo.worktree);
    } else if (repos.get(repo.project.id) === repo) repos.delete(repo.project.id);
  };

  /**
   * Follows the worktrees threads work in and lets go of those no thread
   * uses any more (`worktree.removed`).
   */
  const syncWorktrees = async () => {
    const used = new Map<string, string>();
    for (const dir of threadDirs.values()) {
      if (dir.worktreePath !== undefined && !used.has(dir.worktreePath)) {
        used.set(dir.worktreePath, dir.projectId);
      }
    }
    // A copy: letting go of one changes the map.
    for (const [path, repo] of Array.from(worktreeRepos)) {
      if (used.get(path) === repo.project.id) continue;
      untrack(repo);
      await append(SourceControlEvents.worktreeRemoved, { worktreePath: path });
    }
    for (const [path, projectId] of used) trackWorktree(projectId, path);
  };

  /** The repository a thread works in: its worktree's, else its project's. */
  const repoOfThread = async (threadId: string, projectId: string): Promise<Repo | undefined> => {
    const worktree = threadDirs.get(threadId)?.worktreePath;
    if (worktree !== undefined)
      return worktreeRepos.get(worktree) ?? trackWorktree(projectId, worktree);
    return repos.get(projectId) ?? (await repoOf(projectId).catch(() => undefined));
  };

  // --- Reading a repository ----------------------------------------------------------

  const startWatching = (repo: Repo) => {
    const location = repo.location;
    if (repo.watcher !== undefined || !config().watch || location?.isRepo !== true) return;
    const git = repo.git!;
    repo.watcher = watchTree({
      root: location.root,
      gitDirs: [location.gitDir, location.commonDir],
      isIgnored: async (paths) => {
        const relative = paths.map((path) => `${Path.relative(location.root, path)}/`);
        const result = await git(["check-ignore", "--stdin", "-z"], {
          ok: [0, 1],
          input: relative.join("\0"),
        });
        const ignored = new Set(result.stdout.split("\0").filter((entry) => entry !== ""));
        return new Set(paths.filter((_, index) => ignored.has(relative[index]!)));
      },
      onChange: () => changed(repo),
      onError: (error) =>
        context.log.warn("watching a repository failed", {
          projectId: repo.project.id,
          error: String(error),
        }),
    });
  };

  /** Something changed on disk: read the repository once things settle. */
  const changed = (repo: Repo) => {
    if (repo.disposed || stopped) return;
    const now = Date.now();
    if (repo.firstChangeAt === undefined) {
      repo.firstChangeAt = now;
      context.log.debug("repository changed, reading it once changes settle", {
        projectId: repo.project.id,
      });
    }
    if (repo.settle !== undefined) clearTimeout(repo.settle);
    const wait = Math.max(0, Math.min(SETTLE_MS, repo.firstChangeAt + MAX_SETTLE_MS - now));
    repo.settle = setTimeout(() => {
      repo.settle = undefined;
      repo.firstChangeAt = undefined;
      void refresh(repo).catch((error: unknown) =>
        context.log.warn("reading a repository failed", {
          projectId: repo.project.id,
          error: String(error),
        }),
      );
    }, wait);
  };

  /** The branches whose pull requests matter: the checked-out one and the threads'. */
  const branchesOfInterest = (repo: Repo, status: ProjectStatus): string[] => {
    const branches = new Set<string>();
    if (status.branch !== null) branches.add(status.branch);
    for (const thread of threads.values()) {
      if (thread.projectId === repo.project.id && thread.branch !== null) {
        branches.add(thread.branch);
      }
    }
    // The default branch has no pull request of its own.
    if (status.defaultBranch !== null) branches.delete(status.defaultBranch);
    return [...branches].toSorted();
  };

  const pullRequestsOf = (repo: Repo, status: ProjectStatus): ProjectStatus["pullRequests"] => {
    const result: Record<string, PullRequest | null> = {};
    for (const branch of branchesOfInterest(repo, status)) {
      const cached = repo.pullRequests.get(branch);
      if (cached !== undefined) result[branch] = cached.pr;
    }
    return result;
  };

  const read = async (repo: Repo): Promise<ProjectStatus> => {
    const { gitPath } = config();
    // Its folder lives in the node's home, which may well sit inside some repository.
    if (repo.project.scratch === true) {
      return nonRepository(repo.project.id, "Chats without a project have no repository");
    }
    repo.location ??= await locate(gitPath, repo.project.path);
    const location = repo.location;
    if (!location.isRepo) {
      // Not a repository yet: look again next time (a `git init` makes it one).
      repo.location = undefined;
      return nonRepository(repo.project.id, location.reason);
    }
    repo.git ??= createGit(gitPath, location.root);
    const git = repo.git;
    let local: LocalStatus;
    try {
      local = await readLocalStatus(git, location.root);
    } catch (error) {
      // The repository went away under us: start over next time.
      repo.location = undefined;
      repo.git = undefined;
      throw error;
    }
    const [remoteUrl, defaultBranch] = await Promise.all([
      readRemoteUrl(git),
      readDefaultBranch(git),
    ]);
    // The default branch has nothing to propose against itself (T3's aheadOfDefaultCount).
    const aheadOfDefault =
      local.head.branch === null || local.head.unborn
        ? undefined
        : local.head.branch === defaultBranch
          ? 0
          : await aheadOfBase(git, defaultBranch);
    // Pull requests go to `upstream` when there is one (a fork cloned as `origin`).
    const base = await baseRemoteOf(git);
    const baseUrl = base === undefined ? undefined : await remoteUrlOf(git, base);
    const host = baseUrl === undefined ? undefined : remoteHost(baseUrl);
    const kind = host === undefined ? undefined : kindOfHost(host);
    const forge = kind === undefined || baseUrl === undefined ? undefined : { kind, url: baseUrl };
    // Another forge or remote: what was read of the old one says nothing of the new.
    if (forge?.kind !== repo.forge?.kind || forge?.url !== repo.forge?.url)
      repo.pullRequests.clear();
    repo.forge = forge;
    if (kind === undefined) repo.provider = null;
    else if (repo.provider?.kind !== kind || repo.provider.name !== forgeName(kind, host!)) {
      repo.provider = { kind, name: forgeName(kind, host!), available: true };
    }
    const status: ProjectStatus = {
      projectId: repo.project.id,
      isRepo: true,
      root: location.root,
      branch: local.head.branch,
      upstream: local.head.upstream,
      ahead: local.head.ahead,
      behind: local.head.behind,
      defaultBranch,
      remoteUrl,
      workingTree: summarize(local.files),
      ...(aheadOfDefault === undefined ? {} : { aheadOfDefault }),
      hasPrimaryRemote: remoteUrl !== null,
      provider: repo.provider,
      pullRequests: {},
      checkedAt: new Date().toISOString(),
    };
    return { ...status, pullRequests: pullRequestsOf(repo, status) };
  };

  const publish = async (repo: Repo, status: ProjectStatus) => {
    if (repo.disposed) return status;
    const previous = repo.status;
    repo.status = status;
    if (sameStatus(previous, status)) return status;
    if (repo.worktree === undefined) await append(SourceControlEvents.statusChanged, status);
    else {
      await append(SourceControlEvents.worktreeChanged, { ...status, worktreePath: repo.worktree });
    }
    return status;
  };

  /**
   * Reads the repository again and publishes what changed. Reads run one at a
   * time; a read asked for while one runs is queued once, and every caller in
   * between gets that read.
   */
  const refresh = (repo: Repo): Promise<ProjectStatus> => {
    if (repo.queued !== undefined) return repo.queued;
    const next = repo.chain.then(async () => {
      repo.queued = undefined;
      const status = await read(repo);
      startWatching(repo);
      await publish(repo, status);
      // A branch seen for the first time gets its pull request looked up; a `gh` that
      // could not answer is asked again once its refresh period has passed.
      if (repo.provider !== null) void lookUpPullRequests(repo, { force: false });
      return status;
    });
    repo.queued = next;
    repo.chain = next.catch(() => undefined);
    return next;
  };

  /**
   * T3 settles a thread whose pull request merged or closed (D447): the node's
   * threads decide whether it may (`threads.auto-settle`), source control says
   * which threads work on the branch. Told once per pull request and state.
   */
  /** Threads told about a pull request in a state; a failed call is told again next lookup. */
  const announced = new Set<string>();
  /** Asks the threads plugin to settle a thread on a pull request that merged or closed. */
  const announceSettle = (
    threadId: string,
    pr: { number: number; state: "merged" | "closed"; closedAt: string },
  ) => {
    const key = JSON.stringify([threadId, pr.number, pr.state, pr.closedAt]);
    if (announced.has(key)) return;
    announced.add(key);
    context.commands
      .execute("threads.auto-settle", {
        threadId,
        reason: pr.state === "merged" ? "pull-request-merged" : "pull-request-closed",
        closedAt: pr.closedAt,
      })
      .then(
        // Not settled now (the rule off, a pin): asked again next lookup, the rule may allow it.
        (result) => {
          if ((result as { settled?: boolean }).settled !== true) announced.delete(key);
        },
        (error: unknown) => {
          announced.delete(key);
          context.log.warn("settling a thread on its pull request failed", {
            threadId,
            pullRequest: pr.number,
            error: String(error),
          });
        },
      );
  };

  /** When a pull request merged or closed: never its last update, which a comment moves. */
  const closedAtOf = (pr: PullRequest) =>
    (pr.state === "merged" ? pr.mergedAt : undefined) ?? pr.closedAt;

  /**
   * What a thread's linked pull requests say of settling it (D1133, T3's
   * `settlementPullRequestLinks`): `hold` while one is open or not read yet;
   * the latest that merged or closed; none without links. A link made after
   * its pull request had closed records work the thread did, and is left out.
   */
  const linkSettlement = async (
    threadId: string,
  ): Promise<
    "hold" | { number: number; state: "merged" | "closed"; closedAt: string } | undefined
  > => {
    let latest: { number: number; state: "merged" | "closed"; closedAt: string } | undefined;
    for (const link of await links.list(threadId)) {
      const pr = link.snapshot;
      // Never read on a host no forge here reads: it can tell nothing, so it holds nothing.
      if (pr === null && kindOfHost(link.host) === undefined) continue;
      if (pr === null || pr.state === "open") return "hold";
      const closedAt = closedAtOf(pr);
      const closedMs = Date.parse(closedAt ?? "");
      // No close time to weigh: it cannot settle anything (T3's -Infinity).
      if (closedAt === undefined || Number.isNaN(closedMs)) continue;
      const linkedMs = Date.parse(link.linkedAt);
      if (!Number.isNaN(linkedMs) && closedMs < linkedMs) continue;
      if (latest === undefined || closedMs > Date.parse(latest.closedAt)) {
        latest = { number: pr.number, state: pr.state, closedAt };
      }
    }
    return latest;
  };

  /** Threads held by an open or unread link, so the hold is told once, not each lookup. */
  const heldThreads = new Set<string>();
  /** Threads whose links settle nothing, told once until that changes. */
  const unsettledByLinks = new Set<string>();
  const noteHold = (threadId: string) => {
    unsettledByLinks.delete(threadId);
    if (heldThreads.has(threadId)) return;
    heldThreads.add(threadId);
    context.log.info("a thread waits on its open linked pull requests", { threadId });
  };

  /** Each thread's decision on its links, one at a time: a later one reads after the earlier. */
  const linkDecisions = new Map<string, Promise<void>>();
  /** A linked pull request changed: its thread may settle on its links (D1133). */
  const settleOnLinks = (threadId: string): Promise<void> => {
    const next = (linkDecisions.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => decideOnLinks(threadId));
    linkDecisions.set(threadId, next);
    void next
      .finally(() => {
        if (linkDecisions.get(threadId) === next) linkDecisions.delete(threadId);
      })
      .catch(() => undefined);
    return next;
  };
  const decideOnLinks = async (threadId: string) => {
    // The threads as the node knows them: their branches decide when the links do not.
    await loadThreads();
    const decided = await linkSettlement(threadId);
    // Removed meanwhile: its links are gone because it is, not because they closed.
    // Asked again after the read, so a removal that ended during it leaves nothing behind.
    if (removingThreads.has(threadId)) return;
    if (!threads.has(threadId) && (await links.list(threadId)).length === 0) return;
    if (decided === "hold") {
      noteHold(threadId);
    } else if (decided === undefined) {
      heldThreads.delete(threadId);
      // Its branch's pull request decides now, as read last (D447), not at the next lookup.
      const known = threads.get(threadId);
      const repo = known === undefined ? undefined : repos.get(known.projectId);
      const cached = known?.branch == null ? undefined : repo?.pullRequests.get(known.branch)?.pr;
      if (
        repo !== undefined &&
        known?.branch != null &&
        cached != null &&
        cached.state !== "open"
      ) {
        await settleOnPullRequest(repo, known.branch, cached, threadId);
      }
      // Told once the decision is over, the branch's pull request's part included.
      if (!unsettledByLinks.has(threadId)) {
        unsettledByLinks.add(threadId);
        context.log.info("no linked pull request settles the thread", { threadId });
      }
    } else {
      heldThreads.delete(threadId);
      unsettledByLinks.delete(threadId);
      announceSettle(threadId, decided);
    }
  };

  /**
   * A branch's pull request merged or closed (D447): every thread on the branch
   * may settle, unless its linked pull requests say otherwise (D1133).
   */
  const settleOnPullRequest = async (
    repo: Repo,
    branch: string,
    pr: PullRequest,
    /** Only this thread (its links changed), not every thread on the branch. */
    only?: string,
  ) => {
    const closedAt = closedAtOf(pr);
    if (closedAt === undefined || pr.state === "open") return;
    for (const thread of Array.from(threads.values())) {
      if (thread.projectId !== repo.project.id || thread.branch !== branch) continue;
      if (only !== undefined && thread.threadId !== only) continue;
      // One thread whose links cannot be read keeps none of the others from settling.
      const decided = await linkSettlement(thread.threadId).catch((error: unknown) => {
        context.log.warn("reading a thread's linked pull requests failed", {
          threadId: thread.threadId,
          error: String(error),
        });
        return "unread" as const;
      });
      // Its links could not be read: nothing to decide on now, the next lookup asks again.
      if (decided === "unread") continue;
      // Removed while its links were read: nothing to settle or note.
      if (removingThreads.has(thread.threadId) || !threads.has(thread.threadId)) continue;
      if (decided === "hold") {
        noteHold(thread.threadId);
        continue;
      }
      heldThreads.delete(thread.threadId);
      unsettledByLinks.delete(thread.threadId);
      announceSettle(thread.threadId, decided ?? { number: pr.number, state: pr.state, closedAt });
    }
  };

  /** Looks up the pull requests of the branches of interest whose answer is missing or stale. */
  const lookUpPullRequests = (repo: Repo, options: { force: boolean }): Promise<void> => {
    const next = repo.prChain.then(async () => {
      const status = repo.status;
      // A worktree's pull requests are its project's: the project looks up every thread's branch.
      if (status === undefined || repo.disposed || repo.provider === null) return;
      if (repo.worktree !== undefined) return;
      const location = repo.location;
      if (location?.isRepo !== true) return;
      const { pullRequestRefreshSeconds } = config();
      const forge =
        repo.forge === undefined
          ? undefined
          : makeForge(repo.forge.kind, location.root, repo.forge.url);
      if (forge === undefined) return;
      const ttl = pullRequestRefreshSeconds * 1000;
      // Missing, signed out or failing: asked again once per refresh period, not on every
      // change in between (with a period of 0, only when asked).
      if (repo.provider.available === false && !options.force) {
        const since = Date.now() - (repo.unavailableAt ?? 0);
        if (ttl === 0 || since < ttl) return;
      }
      const name = forgeName(forge.kind, remoteHost(repo.forge!.url) ?? "");
      let provider: PullRequestProvider = { kind: forge.kind, name, available: true };
      for (const branch of branchesOfInterest(repo, status)) {
        const cached = repo.pullRequests.get(branch);
        const stale =
          cached === undefined || (ttl > 0 && Date.now() - cached.at >= ttl) || options.force;
        if (!stale) continue;
        try {
          const pr = await forge.find(await headContextOf(repo.git!, branch));
          repo.pullRequests.set(branch, { pr, at: Date.now() });
          if (pr !== null && pr.state !== "open") {
            void settleOnPullRequest(repo, branch, pr).catch((error: unknown) =>
              context.log.warn("settling threads on a pull request failed", {
                error: String(error),
              }),
            );
          }
        } catch (error) {
          if (!(error instanceof ForgeUnavailable)) throw error;
          provider = { kind: forge.kind, name, available: false, reason: error.message };
          if (error.kind === "failed") {
            context.log.warn("reading a pull request failed", {
              projectId: repo.project.id,
              branch,
              error: error.message,
            });
          }
          break;
        }
      }
      repo.provider = provider;
      repo.unavailableAt = provider.available ? undefined : Date.now();
      const current = repo.status ?? status;
      await publish(repo, {
        ...current,
        provider,
        pullRequests: pullRequestsOf(repo, current),
        checkedAt: new Date().toISOString(),
      });
    });
    repo.prChain = next.catch((error: unknown) =>
      context.log.warn("reading pull requests failed", {
        projectId: repo.project.id,
        error: String(error),
      }),
    );
    return next;
  };

  /** A status read now, pull requests included. */
  const statusNow = async (repo: Repo): Promise<ProjectStatus> => {
    await refresh(repo);
    if (repo.provider !== null) await lookUpPullRequests(repo, { force: true });
    return repo.status!;
  };

  /**
   * The status as last read. Until one was read, the first read is awaited;
   * if that failed (a git hiccup, a repository being rewritten), it is read
   * again, so one failure never keeps the project unreadable.
   */
  const statusOf = async (repo: Repo): Promise<ProjectStatus> => {
    if (repo.status !== undefined) return repo.status;
    try {
      return await repo.ready;
    } catch {
      return refresh(repo);
    }
  };

  /** A status for `git.status`: a project that cannot be read says why instead of failing the rest. */
  const listedStatus = async (repo: Repo, reread: boolean): Promise<ProjectStatus> => {
    try {
      return await (reread ? statusNow(repo) : statusOf(repo));
    } catch (error) {
      return nonRepository(
        repo.project.id,
        `Could not read the repository: ${(error as Error).message}`,
      );
    }
  };

  const gitOf = async (repo: Repo): Promise<{ git: Git; root: string; commonDir: string }> => {
    const status = await statusOf(repo);
    const location = repo.location;
    if (!status.isRepo || location?.isRepo !== true || repo.git === undefined) {
      throw new SourceControlError(
        "NOT_A_REPOSITORY",
        status.reason ?? "The project is not a git repository",
        { projectId: repo.project.id },
      );
    }
    return { git: repo.git, root: location.root, commonDir: location.commonDir };
  };

  // --- Following the threads index ------------------------------------------------------

  /**
   * The branch a thread works on is the one checked out in its project now,
   * read again rather than taken from the last status: the watcher may not
   * have seen a checkout yet, or be off.
   */
  const recordThread = async (threadId: string, projectId: string) => {
    const repo = await repoOfThread(threadId, projectId);
    if (repo === undefined) return;
    const status = await refresh(repo);
    await setThreadBranch(threadId, projectId, status.isRepo ? status.branch : null);
  };

  const onIndexEvent = async (event: StoredEvent) => {
    const payload = event.payload as Record<string, unknown> | null;
    const id = typeof payload?.id === "string" ? payload.id : undefined;
    if (id === undefined) return;
    switch (event.type) {
      case ThreadEvents.projectCreated:
      case ThreadEvents.projectUpdated: {
        await loadProjects();
        if (typeof payload?.path === "string") {
          track({ id, path: payload.path, scratch: payload.scratch === true });
        }
        return;
      }
      case ThreadEvents.projectDeleted: {
        const repo = repos.get(id);
        if (repo !== undefined) {
          untrack(repo);
          await append(SourceControlEvents.projectRemoved, { projectId: id });
        }
        await loadThreads();
        for (const thread of threads.values()) {
          if (thread.projectId === id) await removeThread(thread.threadId);
        }
        return;
      }
      case ThreadEvents.threadCreated: {
        if (typeof payload?.projectId === "string") {
          await noteDir(id, payload);
          await recordThread(id, payload.projectId);
        }
        return;
      }
      case ThreadEvents.threadUpdated: {
        const projectId = payload?.projectId;
        // A thread moved into a worktree (or back) works on what is checked out there.
        if (typeof projectId === "string" && (await noteDir(id, payload))) {
          await recordThread(id, projectId);
        }
        // A settling is a change to settled, or to another settling: not every update of a
        // thread already settled before (a rename, a pin) runs it again.
        const settledAt =
          payload?.["settledOverride"] === "settled" && typeof payload["settledAt"] === "string"
            ? payload["settledAt"]
            : null;
        const before = settledSeen.get(id);
        settledSeen.set(id, settledAt);
        if (settledAt !== null && settledKnown && before !== settledAt) {
          void runSettleScript(id, settledAt).catch((error: unknown) =>
            context.log.warn("could not run a settle script", {
              threadId: id,
              error: String(error),
            }),
          );
        }
        const lastTurn = payload?.lastTurn as { turnId?: string; status?: string } | undefined;
        if (typeof projectId !== "string" || lastTurn?.status === undefined) return;
        const key = `${lastTurn.turnId}:${lastTurn.status}`;
        if (lastTurns.get(id) === key) return;
        lastTurns.set(id, key);
        // A turn runs on what is checked out when it starts; what it changed shows when it ends.
        if (lastTurn.status !== "waiting") await recordThread(id, projectId);
        // A watch's news that waited for the turn goes out once it ends.
        if (["completed", "interrupted", "failed"].includes(lastTurn.status)) {
          void watcher
            .idle(id)
            .catch((error: unknown) =>
              context.log.warn("waking a thread failed", { threadId: id, error: String(error) }),
            );
        }
        return;
      }
      case ThreadEvents.threadDeleted: {
        const deletedProject = threadDirs.get(id)?.projectId;
        forgetSetup(id);
        settleClaims.delete(id);
        settledSeen.delete(id);
        await kv.delete(NAMESPACE, `${SETTLE_PREFIX}${id}`).catch(() => false);
        // Bookkeeping for the cleanup never keeps the thread's own removal from running.
        await noteDeletedWorktree(id).catch((error: unknown) =>
          context.log.warn("could not note a deleted thread's worktree", {
            threadId: id,
            error: String(error),
          }),
        );
        threadDirs.delete(id);
        await syncWorktrees();
        await removeThread(id);
        // Once the thread is gone everywhere, its worktree's sweep runs (D1129).
        if (cleanupRulesOf(deletedProject).onDelete) cleanInBackground();
        return;
      }
    }
  };

  /** Records where a thread works; true when that changed. */
  const noteDir = async (threadId: string, record: Record<string, unknown> | null) => {
    const projectId = record?.["projectId"];
    if (typeof projectId !== "string") return false;
    const worktreePath =
      typeof record?.["worktreePath"] === "string" ? (record["worktreePath"] as string) : undefined;
    const known = threadDirs.get(threadId);
    if (known?.projectId === projectId && known.worktreePath === worktreePath) return false;
    threadDirs.set(threadId, { projectId, worktreePath });
    await syncWorktrees();
    return true;
  };
  context.subscriptions.add(
    log.subscribe(THREADS_STREAM, (event) => {
      indexChain = indexChain
        .then(() => onIndexEvent(event))
        .catch((error: unknown) =>
          context.log.warn("following the threads index failed", {
            type: event.type,
            error: String(error),
          }),
        );
    }),
  );

  // --- Timers and config ---------------------------------------------------------------

  let prTimer: ReturnType<typeof setInterval> | undefined;
  let linksReading = false;
  const schedulePullRequests = () => {
    if (prTimer !== undefined) clearInterval(prTimer);
    prTimer = undefined;
    const seconds = config().pullRequestRefreshSeconds;
    if (seconds === 0) return;
    prTimer = setInterval(() => {
      for (const repo of allRepos()) {
        if (repo.provider !== null) void lookUpPullRequests(repo, { force: false });
      }
      // One thread after another, and no new round while the last one still reads.
      if (linksReading) return;
      linksReading = true;
      void (async () => {
        for (const id of await links.threads()) {
          // One thread's failure is told and keeps the others' turn.
          try {
            await links.sync(id);
            // A settle the threads plugin turned down (a turn ran then) is asked again;
            // one it took is not asked twice (`announceSettle` keeps its key).
            await settleOnLinks(id);
          } catch (error) {
            context.log.warn("reading or settling a thread's linked pull requests failed", {
              threadId: id,
              error: String(error),
            });
          }
        }
      })()
        .catch((error: unknown) =>
          context.log.warn("reading linked pull requests failed", { error: String(error) }),
        )
        .finally(() => {
          linksReading = false;
        });
    }, seconds * 1000);
    prTimer.unref?.();
  };
  schedulePullRequests();
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let watchSweeping = false;
  const scheduleWatch = () => {
    if (watchTimer !== undefined) clearInterval(watchTimer);
    watchTimer = undefined;
    const seconds = config().watchSweepSeconds;
    if (seconds === 0) return;
    watchTimer = setInterval(() => {
      // No new sweep while the last one still reads.
      if (watchSweeping) return;
      watchSweeping = true;
      void watcher
        .sweep()
        .catch((error: unknown) =>
          context.log.warn("watching pull requests failed", { error: String(error) }),
        )
        .finally(() => {
          watchSweeping = false;
        });
    }, seconds * 1000);
    watchTimer.unref?.();
  };
  scheduleWatch();
  // --- Worktree cleanup (D1128–D1130) ----------------------------------------------------

  /** A deleted thread's worktree that it worked in alone, until a sweep decides it. */
  const DeletedWorktree = z.object({
    /** Its real path, as the live worktrees are compared. */
    path: z.string(),
    projectId: z.string(),
    threadId: z.string(),
    branch: z.string(),
  });
  type DeletedWorktree = z.output<typeof DeletedWorktree>;
  const DELETED_PREFIX = "cleanup/deleted/";
  /** How many orphaned folders a report lists (D1470). */
  const MAX_ORPHANS = 200;
  /** The last sweep's report (D1469). */
  const LAST_REPORT_KEY = "cleanup/last-report";

  async function noteDeletedWorktree(threadId: string) {
    // Only under the delete rule: without it the user decided at the deletion
    // (D255's question), and a later rule must not overturn that choice.
    const dir = threadDirs.get(threadId);
    if (dir === undefined || !cleanupRulesOf(dir.projectId).onDelete) return;
    const branch = threads.get(threadId)?.branch;
    if (dir.worktreePath === undefined || branch == null) return;
    const root = await realPath(worktreesRoot(config().worktreesDirectory, hostPaths.home));
    if (!isManagedWorktree(root, dir.worktreePath)) return;
    for (const [other, entry] of threadDirs) {
      if (other !== threadId && entry.worktreePath === dir.worktreePath) return;
    }
    const record: DeletedWorktree = {
      path: await realPath(dir.worktreePath),
      projectId: dir.projectId,
      threadId,
      branch,
    };
    await kv.set(NAMESPACE, `${DELETED_PREFIX}${threadId}`, record as unknown as Json);
  }

  let cleaning: Promise<CleanupReport> | undefined;
  /** Sweeps run one at a time; one asked for meanwhile runs after it. */
  let cleanAgain = false;
  function requestCleanup(): Promise<CleanupReport> {
    if (cleaning !== undefined) {
      cleanAgain = true;
      return cleaning;
    }
    // A sweep that fails rejects: the command says so; a sweep nobody asked for logs it.
    cleaning = sweepWorktrees().finally(() => {
      cleaning = undefined;
      if (cleanAgain && !stopped) {
        cleanAgain = false;
        cleanInBackground();
      }
    });
    return cleaning;
  }

  /** A sweep the node starts by itself: a failure is logged. */
  function cleanInBackground() {
    requestCleanup().catch((error: unknown) =>
      context.log.warn("cleaning up worktrees failed", { error: String(error) }),
    );
  }

  const timeOr = (value: string, fallback: number) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  };

  /** T3's `cleanWorktrees`: decides each managed worktree a thread works or worked in. */
  async function sweepWorktrees(): Promise<CleanupReport> {
    const entries: CleanupEntry[] = [];
    const report = () => ({
      entries,
      counts: {
        removed: entries.filter((entry) => entry.outcome === "removed").length,
        kept: entries.filter((entry) => entry.outcome === "kept").length,
        failed: entries.filter((entry) => entry.outcome === "failed").length,
      },
    });
    if (!anyCleanupEnabled() || stopped) return report();
    const root = await realPath(worktreesRoot(config().worktreesDirectory, hostPaths.home));
    const projects = (await context.commands.execute("projects.list", {})) as {
      id: string;
      path: string;
    }[];
    const projectPath = new Map(projects.map((project) => [project.id, project.path]));
    const listed = (await context.commands.execute("threads.list", {
      includeGenerations: true,
    })) as {
      id: string;
      projectId: string;
      worktreePath?: string;
      updatedAt?: string;
      createdAt: string;
      settledAt?: string;
      lastTurn?: { status: string };
    }[];
    const groups = new Map<string, typeof listed>();
    for (const thread of listed) {
      if (thread.worktreePath === undefined) continue;
      const key = await realPath(thread.worktreePath);
      if (!isManagedWorktree(root, key)) continue;
      groups.set(key, [...(groups.get(key) ?? []), thread]);
    }
    const candidates: CleanupCandidate[] = [];
    const deletedKeys = new Map<string, string>();
    for (const [path, group] of groups) {
      const first = group[0]!;
      const branch = threads.get(first.id)?.branch;
      const project = projectPath.get(first.projectId);
      if (branch == null || project === undefined) continue;
      const linked = await links.list(first.id);
      candidates.push({
        path,
        projectId: first.projectId,
        projectPath: project,
        branch,
        threadId: first.id,
        deleted: false,
        mergedInto: linked.flatMap((link) =>
          link.snapshot?.state === "merged" && link.snapshot.headBranch === branch
            ? [
                {
                  base: link.snapshot.baseBranch,
                  ...(link.snapshot.headSha === undefined
                    ? {}
                    : { headSha: link.snapshot.headSha }),
                },
              ]
            : [],
        ),
        threads: group.map((thread) => ({
          id: thread.id,
          running: thread.lastTurn?.status === "running" || thread.lastTurn?.status === "waiting",
          started: thread.lastTurn !== undefined,
          // A time that does not parse counts as now: the worktree reads as just used.
          activeAt: timeOr(thread.updatedAt ?? thread.createdAt, Date.now()),
          ...(Number.isNaN(Date.parse(thread.settledAt ?? ""))
            ? {}
            : { settledAt: Date.parse(thread.settledAt!) }),
        })),
      });
    }
    /** Worktrees a thread uses, or a deleted one did: no orphans (D1470). */
    const referenced = new Set(groups.keys());
    for (const { key, value } of await kv.list(NAMESPACE, { prefix: DELETED_PREFIX })) {
      const parsed = DeletedWorktree.safeParse(value);
      // A record this version cannot read decides nothing, and is kept for one that can.
      if (!parsed.success) continue;
      const record = parsed.data;
      // Real paths, as the live worktrees' are (a worktrees directory behind a link).
      referenced.add(await realPath(record.path));
      // Without its project's delete rule it decides nothing: kept for when it is on, not reported.
      if (!cleanupRulesOf(record.projectId).onDelete) continue;
      const project = projectPath.get(record.projectId);
      // Taken by a thread again, gone, or of a project that went: nothing to decide.
      // …or no longer under the worktrees directory (its setting changed): not this node's to remove.
      if (
        groups.has(await realPath(record.path)) ||
        project === undefined ||
        !isManagedWorktree(root, record.path) ||
        !(await exists(record.path))
      ) {
        await kv.delete(NAMESPACE, key);
        continue;
      }
      deletedKeys.set(record.path, key);
      candidates.push({
        path: record.path,
        projectId: record.projectId,
        projectPath: project,
        branch: record.branch,
        threadId: record.threadId,
        deleted: true,
        mergedInto: [],
        threads: [],
      });
    }
    const defaults = new Map<string, Promise<{ commit: string; branch: string } | undefined>>();
    /** The folders running terminals work in, as real paths like the worktrees'. */
    const terminalFolders = async () =>
      Promise.all(
        (context.services.tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY)?.list() ?? [])
          .filter((terminal) => terminal.status === "running")
          .map((terminal) => realPath(terminal.cwd)),
      );
    const swept = await terminalFolders();
    const inside = (folder: string, path: string) =>
      path === folder || path.startsWith(`${folder}${Path.sep}`);
    for (const candidate of candidates) {
      if (stopped) break;
      const entry = { path: candidate.path, threadId: candidate.threadId };
      try {
        if (!(await exists(candidate.path))) continue;
        const rules = cleanupRulesOf(candidate.projectId);
        const verdict = await judge(candidate, rules, {
          now: Date.now(),
          git: (cwd) => createGit(config().gitPath, cwd),
          defaults,
          hasTerminal: (path) => swept.some((folder) => inside(path, folder)),
        });
        if ("keep" in verdict) {
          entries.push({ ...entry, outcome: "kept", reason: verdict.keep });
          // A deleted thread's worktree stays on disk with nobody to see it: say why.
          if (candidate.deleted) {
            context.log.info("kept a worktree", { path: candidate.path, reason: verdict.keep });
          }
          continue;
        }
        // T3's blockedSinceCheck: under the project's worktree lock, the threads there
        // are read again, so one that started a turn or came in since is not robbed.
        const blocked = await exclusive(candidate.projectId, async () => {
          const users = await worktreeUsers({ strict: true }).catch(() => undefined);
          if (users === undefined) return "Threads could not be read.";
          const now = users.get(candidate.path) ?? [];
          const expected = candidate.threads.map((thread) => thread.id);
          if (now.length !== expected.length || now.some((id) => !expected.includes(id))) {
            return "Threads changed since the check.";
          }
          if ((await terminalFolders()).some((folder) => inside(candidate.path, folder))) {
            return "Open terminal.";
          }
          const worktreeGit = createGit(config().gitPath, candidate.path);
          const current = (
            await worktreeGit(["symbolic-ref", "--quiet", "HEAD"], { ok: [0, 1, 128] })
          ).stdout
            .trim()
            .replace(/^refs\/heads\//, "");
          if (current !== candidate.branch) return "Repository or branch changed.";
          const changes = await localChangesReason(worktreeGit, rules.keepWhen, candidate.path);
          if (changes !== null) return sentence(changes);
          for (const threadId of now) {
            const answer = (await context.commands
              .execute("threads.get", { threadId })
              .catch(() => undefined)) as
              | { thread?: { lastTurn?: { status: string } } }
              | undefined;
            // A thread that cannot be read now is not known to be idle: keep the worktree.
            if (answer?.thread === undefined) return "Thread could not be read.";
            const status = answer.thread.lastTurn?.status;
            if (status === "running" || status === "waiting") {
              return "Thread is running or has pending work.";
            }
          }
          const projectGit = createGit(config().gitPath, candidate.projectPath);
          await projectGit(["worktree", "remove", "--force", "--", candidate.path], {
            timeoutMs: 300_000,
          });
          return undefined;
        });
        if (blocked !== undefined) {
          entries.push({ ...entry, outcome: "kept", reason: blocked });
          if (candidate.deleted) {
            context.log.info("kept a worktree", { path: candidate.path, reason: blocked });
          }
          continue;
        }
        const key = deletedKeys.get(candidate.path);
        if (key !== undefined) await kv.delete(NAMESPACE, key);
        context.log.info("removed a worktree", { path: candidate.path, reason: verdict.remove });
        entries.push({ ...entry, outcome: "removed", reason: verdict.remove });
      } catch (error) {
        entries.push({ ...entry, outcome: "failed", reason: (error as Error).message });
      }
    }
    if (entries.some((entry) => entry.outcome === "removed")) await syncWorktrees();
    if (!stopped) {
      const projectRoots = await Promise.all([...projectPath.values()].map(realPath));
      // The report is kept and sent whole: a crowded worktrees directory lists its first ones.
      const orphans = await orphanEntries(root, referenced, projectRoots, Date.now());
      entries.push(...orphans.slice(0, MAX_ORPHANS));
      if (orphans.length > MAX_ORPHANS) {
        context.log.info("listed the first orphaned worktree folders", {
          listed: MAX_ORPHANS,
          found: orphans.length,
        });
      }
    }
    // T3's "Last run": kept, so a restart still shows it (D1469). A sweep cut short by the
    // plugin stopping is no last run; one that could not be kept still answers.
    const finished = { ...report(), finishedAt: new Date().toISOString() };
    if (!stopped) {
      await kv
        .set(NAMESPACE, LAST_REPORT_KEY, finished as unknown as Json)
        .catch((error: unknown) =>
          context.log.warn("could not keep the cleanup's report", { error: String(error) }),
        );
    }
    return finished;
  }

  let cleanupTimer: ReturnType<typeof setInterval> | undefined = setInterval(
    () => cleanInBackground(),
    3_600_000,
  );
  cleanupTimer.unref?.();
  // As T3 sweeps when it starts: a node restarted more often than hourly still cleans up.
  // It reads `projects.list` and `threads.list`: at once when they answer already (a
  // reload, or the plugin enabled into a running kernel), else once every plugin is up.
  // A failure is logged and the hourly sweep tries again.
  const startupSweep = () => {
    if (anyCleanupEnabled()) cleanInBackground();
    void knowSettled().catch((error: unknown) =>
      context.log.warn("could not read the settled threads", { error: String(error) }),
    );
  };
  /** The threads settled when the plugin starts: their next update is no settling (D1476). */
  async function knowSettled() {
    const listed = (await context.commands.execute("threads.list", {
      includeGenerations: true,
    })) as { id: string; settledOverride?: string; settledAt?: string }[];
    for (const thread of listed) {
      if (settledSeen.has(thread.id)) continue;
      settledSeen.set(
        thread.id,
        thread.settledOverride === "settled" ? (thread.settledAt ?? null) : null,
      );
    }
    settledKnown = true;
  }
  const answering = () => {
    const names = new Set(context.commands.list().map((command) => command.name));
    return names.has("projects.list") && names.has("threads.list");
  };
  if (context.state.get<boolean>("kernelStarted") === true || answering()) {
    queueMicrotask(startupSweep);
  } else {
    const started = context.subscriptions.add(
      context.events.on("kernel.started", () => {
        started.dispose();
        context.state.set("kernelStarted", true);
        startupSweep();
      }),
    );
  }
  /** Every rule a sweep reads: the node's and each project's. */
  const allRules = () =>
    JSON.stringify([
      config().worktreeCleanup,
      Object.entries(config().projects).map(([id, entry]) => [id, entry.worktreeCleanup]),
    ]);
  let lastRules = allRules();
  context.subscriptions.add({
    dispose() {
      if (cleanupTimer !== undefined) clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    },
  });

  context.subscriptions.add(
    context.config.onDidChange(CONFIG_SECTION, () => {
      // New rules apply at once, as T3 sweeps when its settings change.
      const rules = allRules();
      if (rules !== lastRules) {
        lastRules = rules;
        cleanInBackground();
      }
      schedulePullRequests();
      scheduleWatch();
      for (const repo of allRepos()) {
        if (config().watch) startWatching(repo);
        else stopWatching(repo);
      }
    }),
  );
  context.subscriptions.add({
    dispose() {
      stopped = true;
      links.dispose();
      if (prTimer !== undefined) clearInterval(prTimer);
      if (watchTimer !== undefined) clearInterval(watchTimer);
      for (const repo of repos.values()) untrack(repo);
      for (const repo of allRepos()) untrack(repo);
    },
  });

  // The threads plugin may come up after this one: then the first request reads the projects.
  queueMicrotask(() => {
    void Promise.all([loadThreads(), loadProjects()]).catch((error: unknown) =>
      context.log.warn("reading the projects failed", { error: String(error) }),
    );
  });

  // --- The service --------------------------------------------------------------------------

  const threadProject = async (threadId: string): Promise<string> => {
    await loadThreads();
    const known = threads.get(threadId);
    if (known !== undefined) return known.projectId;
    try {
      const answer = (await context.commands.execute("threads.get", { threadId })) as {
        thread: { projectId: string };
      };
      return answer.thread.projectId;
    } catch {
      throw new SourceControlError("THREAD_NOT_FOUND", `No thread ${threadId} on this node`, {
        threadId,
      });
    }
  };

  const service: SourceControl = {
    status: async (projectId, options = {}) => {
      const repo = await repoOf(projectId);
      return options.refresh === true ? statusNow(repo) : statusOf(repo);
    },
    diff: async (projectId, options = {}) => {
      const repo = await repoFor(projectId, options.threadId);
      const status = await statusOf(repo);
      const { git, root } = await gitOf(repo);
      const scope = options.scope ?? "uncommitted";
      const local = await readLocalStatus(git, root);
      const patch = await readPatch(git, root, local, {
        scope,
        base: options.base ?? status.defaultBranch,
        ignoreWhitespace: options.ignoreWhitespace === true,
      });
      const totals = summarize(patch.files);
      return {
        projectId,
        scope,
        baseRef: patch.baseRef,
        headRef: patch.headRef,
        patch: patch.patch,
        truncated: patch.truncated,
        files: patch.files,
        insertions: totals.insertions,
        deletions: totals.deletions,
      };
    },
    branches: async (projectId, options = {}) => {
      const repo = await repoFor(projectId, options.threadId);
      const status = await statusOf(repo);
      const { git } = await gitOf(repo);
      return readBranches(git, status.defaultBranch);
    },
    checkout: async (projectId, branch, options = {}) => {
      // A thread moves with the checkout only within its own project.
      if (options.threadId !== undefined) {
        const owner = await threadProject(options.threadId);
        if (owner !== projectId) {
          throw new SourceControlError(
            "THREAD_PROJECT_MISMATCH",
            `Thread ${options.threadId} belongs to another project`,
            { threadId: options.threadId, projectId, threadProjectId: owner },
          );
        }
      }
      // In the thread's worktree when it has one.
      const repo = await repoFor(projectId, options.threadId);
      return exclusive(projectId, async () => {
        const { git } = await gitOf(repo);
        const remotes = (await git(["remote"])).stdout.split("\n").filter((line) => line !== "");
        await checkout(git, branch, { create: options.create === true, remotes });
        const status = await refresh(repo);
        if (options.threadId !== undefined) {
          await setThreadBranch(options.threadId, projectId, status.branch);
        }
        return status;
      });
    },
    threadBranch: async (threadId) => {
      await loadThreads();
      return threads.get(threadId);
    },
    runAction: async (projectId, options) => {
      const input = GitActionOptions.parse(options);
      // A worktree thread's actions commit and push in its worktree (D251).
      const repo = await repoFor(projectId, input.threadId);
      if (input.threadId !== undefined) {
        const owner = await threadProject(input.threadId);
        if (owner !== projectId) {
          throw new SourceControlError(
            "THREAD_PROJECT_MISMATCH",
            `Thread ${input.threadId} belongs to another project`,
            { threadId: input.threadId, projectId, threadProjectId: owner },
          );
        }
      }
      const actionId = input.actionId ?? randomUUID();
      /** The action's progress ended (finished or failed): every later failure must say so. */
      let ended = false;
      const progress = (
        event: Parameters<Parameters<typeof runStackedAction>[0]["progress"]>[0],
      ) => {
        if (event.kind === "action_finished" || event.kind === "action_failed") ended = true;
        publishProgress({
          ...event,
          ...(event.kind === "action_finished" ? { result: { ...event.result, actionId } } : {}),
          actionId,
          projectId,
          action: input.action,
        } as GitActionProgress);
      };
      return exclusive(projectId, async () => {
        try {
          const status = await refresh(repo);
          const { git, root } = await gitOf(repo);
          const location = repo.location;
          if (location?.isRepo !== true) {
            throw new SourceControlError("NOT_A_REPOSITORY", "The project is not a git repository");
          }
          try {
            const result = await runStackedAction({
              git,
              root,
              gitDir: location.gitDir,
              action: input.action,
              commitMessage: input.commitMessage,
              featureBranch: input.featureBranch,
              filePaths: input.filePaths,
              defaultBranch: status.defaultBranch,
              forge: forgeOf(repo, root),
              writer: writerFor(projectId, input.threadId),
              progress,
            });
            // The pull request the action created or opened is linked to its thread (T3's
            // linkCreatedPullRequest); a failure to link never fails the action.
            const created = result.pr.pullRequest;
            if (input.threadId !== undefined && created !== undefined) {
              await links
                .link(input.threadId, { url: created.url }, "created", created)
                .catch((error: unknown) =>
                  context.log.warn("failed to link created pull request to thread", {
                    threadId: input.threadId,
                    error: String(error),
                  }),
                );
            }
            return { ...result, actionId };
          } finally {
            const after = await refresh(repo).catch(() => undefined);
            if (after !== undefined && input.threadId !== undefined && after.isRepo) {
              await setThreadBranch(input.threadId, projectId, after.branch);
            }
            if (repo.provider !== null) void lookUpPullRequests(repo, { force: true });
          }
        } catch (error) {
          // Failed before its steps began (no repository, a read that failed): still said.
          if (!ended)
            progress({ kind: "action_failed", phase: null, message: (error as Error).message });
          throw error;
        }
      });
    },
    pull: async (projectId) => {
      const repo = await repoOf(projectId);
      return exclusive(projectId, async () => {
        const { git } = await gitOf(repo);
        try {
          return await pull(git);
        } finally {
          await refresh(repo).catch(() => undefined);
        }
      });
    },
    turnDiff: (threadId, turn, options = {}) => turns.diff(threadId, turn, options),
    diffFile: async (target, file, options = {}) => {
      if (options.scope === "turn") {
        if (target.threadId === undefined || options.turn === undefined) {
          throw new SourceControlError(
            "CHECKPOINT_UNAVAILABLE",
            "The turn scope takes a thread and a turn",
          );
        }
        return turns.diffFile(
          target.threadId,
          options.turn,
          file,
          options.fromTurn === undefined ? {} : { fromTurn: options.fromTurn },
        );
      }
      const projectId = target.projectId ?? (await threadProject(target.threadId!));
      const repo = await repoFor(projectId, target.threadId);
      const status = await statusOf(repo);
      const { git, root } = await gitOf(repo);
      return readDiffFile(
        git,
        root,
        { scope: options.scope ?? "uncommitted", base: options.base ?? status.defaultBranch },
        file,
      );
    },
    checkpoints: (threadId) => turns.list(threadId),
    // Worktrees are made, attached and removed one at a time per project.
    createWorktree: (projectId, options) =>
      exclusive(projectId, () => createWorktreeNow(projectId, options)),
    worktreeSetup: (threadId) => setups.get(threadId),
    cancelWorktreeSetup: (threadId) => cancelSetup(threadId),
    removeWorktree: (projectId, path, options = {}) =>
      exclusive(projectId, () => removeWorktreeNow(projectId, path, options)),
    worktrees: async (projectId) => {
      const repo = await repoOf(projectId);
      const { git } = await gitOf(repo);
      const root = worktreesRoot(config().worktreesDirectory, hostPaths.home);
      const users = await worktreeUsers();
      return Promise.all(
        (await listWorktrees(git)).map(async (entry) => ({
          path: entry.path,
          branch: entry.branch,
          main: entry.main,
          managed: isManagedWorktree(root, entry.path),
          threadIds: users.get(await realPath(entry.path)) ?? [],
        })),
      );
    },
    // One handoff of a thread at a time: a second finds it in its worktree (T3's "in progress").
    handoff: (threadId, options = {}) =>
      handoffLocked(threadId, () => handoffNow(threadId, options)),
  };

  /** A folder by its real path: a link or an unnormalised path names the same folder. */
  const realPath = (value: string) => Fs.realpath(value).catch(() => Path.resolve(value));

  /** The threads working in each worktree, by real path, as the threads plugin has them now. */
  async function worktreeUsers(options: { strict?: boolean } = {}): Promise<Map<string, string[]>> {
    // A worktree an agent's generation works in is in use as well (D745).
    const listing = context.commands.execute("threads.list", { includeGenerations: true });
    // Strict: a list that cannot be read is an error, never "nobody works there".
    const listed = (await (options.strict === true ? listing : listing.catch(() => []))) as {
      id: string;
      worktreePath?: string;
    }[];
    const users = new Map<string, string[]>();
    for (const thread of listed) {
      if (thread.worktreePath === undefined) continue;
      const key = await realPath(thread.worktreePath);
      users.set(key, [...(users.get(key) ?? []), thread.id]);
    }
    return users;
  }

  async function createWorktreeNow(
    projectId: string,
    options: Parameters<SourceControl["createWorktree"]>[1],
  ) {
    const { threadId } = options;
    // Only a thread that is still to be made gets a setup: an existing one (or one
    // being set up) is never taken over through this id.
    if (threadId !== undefined) {
      // Only "no such thread" means it is still to be made; any other failure is no answer.
      const existing = await context.commands.execute("threads.get", { threadId }).then(
        () => true,
        (error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === "THREAD_NOT_FOUND") return false;
          throw error;
        },
      );
      if (existing || setups.get(threadId)?.phase === "running") {
        throw new SourceControlError(
          "WORKTREE_INVALID",
          `Thread ${threadId} exists already: only a new thread's worktree is set up`,
          { threadId },
        );
      }
    }
    // A new thread's worktree: its setup is tracked from here (D1122, T3's launch).
    if (threadId !== undefined) {
      setups.begin({
        threadId,
        branch: options.branch ?? null,
        baseRef: options.baseRef,
        stages: ["fetch", "checkout", "setup-script", "agent"],
      });
    }
    let created: CreatedWorktree;
    try {
      const repo = await repoOf(projectId);
      const { git, root } = await gitOf(repo);
      created = await createWorktree(git, {
        repository: root,
        root: worktreesRoot(config().worktreesDirectory, hostPaths.home),
        baseRef: options.baseRef,
        submodules: submodulesOf(projectId),
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        ...(options.startFromOrigin === undefined
          ? {}
          : { startFromOrigin: options.startFromOrigin }),
        ...(threadId === undefined
          ? {}
          : {
              onStage: (stage, status, detail) =>
                setups.stageStatus(threadId, stage, status, detail),
            }),
      });
    } catch (error) {
      if (threadId !== undefined) setups.finish(threadId, "failed", (error as Error).message);
      throw error;
    }
    if (threadId !== undefined) {
      setups.update(threadId, (snapshot) => ({
        ...snapshot,
        branch: created.branch,
        worktreePath: created.path,
      }));
      beginSetupScript(threadId, projectId, created.path);
    }
    return created;
  }

  /** Starts the project's setup script for a thread's new worktree, in the background. */
  function beginSetupScript(threadId: string, projectId: string, worktreePath: string) {
    const starting = Promise.withResolvers<void>();
    setupStarts.set(threadId, starting.promise);
    void startSetupScript(threadId, projectId, worktreePath, starting.resolve)
      .catch((error: unknown) => {
        setups.stage(threadId, "setup-script", {
          status: "failed",
          endedAt: new Date().toISOString(),
          detail: (error as Error).message,
        });
        settleSetup(threadId);
      })
      .finally(() => {
        starting.resolve();
        if (setupStarts.get(threadId) === starting.promise) setupStarts.delete(threadId);
      });
  }

  /**
   * T3's Retry of a failed preparation (D1478): the worktree made again from its branch
   * when it is gone, the setup script run again, then the turn's message sent again.
   */
  const retrying = new Set<string>();
  async function retryPreparation(threadId: string): Promise<{ turnId: string }> {
    if (retrying.has(threadId) || setups.get(threadId)?.phase === "running") {
      throw new SourceControlError("WORKSPACE_RETRY_INVALID", "The thread is being set up", {
        threadId,
      });
    }
    retrying.add(threadId);
    try {
      const { thread } = (await context.commands.execute("threads.get", { threadId })) as {
        thread: {
          projectId: string;
          worktreePath?: string;
          lastTurn?: { status: string; failure?: { class: string } };
        };
      };
      if (
        thread.lastTurn?.status !== "failed" ||
        thread.lastTurn.failure?.class !== "workspace_preparation"
      ) {
        throw new SourceControlError(
          "WORKSPACE_RETRY_INVALID",
          "The thread's latest turn is no failed workspace preparation",
          { threadId },
        );
      }
      const previous = await setupOf(threadId);
      const path = thread.worktreePath ?? previous?.worktreePath ?? undefined;
      const branch = previous?.branch ?? threads.get(threadId)?.branch ?? undefined;
      if (path === undefined) {
        throw new SourceControlError("WORKSPACE_RETRY_INVALID", "The thread had no worktree", {
          threadId,
        });
      }
      setups.begin({
        threadId,
        branch: branch ?? null,
        baseRef: previous?.baseRef ?? "",
        stages: ["checkout", "setup-script", "agent"],
      });
      try {
        if (await exists(path)) {
          setups.stageStatus(threadId, "checkout", "skipped");
        } else {
          if (branch == null) throw new Error("its branch is unknown");
          setups.stageStatus(threadId, "checkout", "running");
          const repo = await repoOf(thread.projectId);
          const { git } = await gitOf(repo);
          const warning = await recreateWorktree(git, path, branch, submodulesOf(thread.projectId));
          setups.stageStatus(
            threadId,
            "checkout",
            warning === undefined ? "done" : "warning",
            warning,
          );
        }
        if (thread.worktreePath !== path) {
          await context.commands.execute("threads.update", { threadId, worktreePath: path });
        }
      } catch (error) {
        setups.finish(threadId, "failed", (error as Error).message);
        throw error;
      }
      setups.update(threadId, (snapshot) => ({ ...snapshot, worktreePath: path }));
      beginSetupScript(threadId, thread.projectId, path);
      // The failed turn's message again: its start hook waits for the script as the first did.
      try {
        const { turnId } = (await context.commands.execute("threads.regenerate", {
          threadId,
        })) as { turnId: string };
        return { turnId };
      } catch (error) {
        // Refused before its turn took the setup (busy, deleted): the script stops with it, so
        // nothing is left running and a later Retry is not refused as "being set up".
        if (setups.get(threadId)?.phase === "running") {
          const run = setupRuns.get(threadId);
          setupRuns.delete(threadId);
          run?.cancel();
          if (run?.terminalId !== undefined) {
            await context.services
              .tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY)
              ?.close({ threadId, terminalId: run.terminalId })
              .catch(() => undefined);
          }
          setups.finish(threadId, "failed", (error as Error).message);
        }
        throw error;
      }
    } finally {
      retrying.delete(threadId);
    }
  }

  async function removeWorktreeNow(
    projectId: string,
    path: string,
    options: { force?: boolean; deleteBranch?: boolean },
  ) {
    const repo = await repoOf(projectId);
    const { git } = await gitOf(repo);
    const wanted = await realPath(path);
    const listed = await listWorktrees(git);
    let known: (typeof listed)[number] | undefined;
    for (const entry of listed) if ((await realPath(entry.path)) === wanted) known = entry;
    if (known === undefined) {
      throw new SourceControlError(
        "WORKTREE_INVALID",
        `${path} is not a worktree of this project's repository`,
        { path },
      );
    }
    if (known.main) {
      throw new SourceControlError(
        "WORKTREE_INVALID",
        "A repository's own checkout is no worktree to remove",
        { path },
      );
    }
    // Read from the threads plugin now, not from the index followed so far.
    const users = (await worktreeUsers()).get(wanted) ?? [];
    if (users.length > 0) {
      throw new SourceControlError(
        "WORKTREE_IN_USE",
        `Threads still work in ${path}: ${users.join(", ")}`,
        { path, threadIds: users },
      );
    }
    // Refused before anything else stops: an unforced removal git would turn down
    // leaves the setup and its terminal as they are (D1134).
    if (options.force !== true && (await hasCheckedOutSubmodules(git, known.path))) {
      throw submodulesNeedForce(path);
    }
    // Its setup stops with it (D1124), and a setup that ended (a failed script)
    // leaves no terminal or run behind.
    for (const [threadId, run] of Array.from(setupRuns)) {
      if (run.worktreePath === wanted || (await realPath(run.worktreePath)) === wanted) {
        if (!(await cancelSetup(threadId))) {
          setupRuns.delete(threadId);
          run.cancel();
        }
      }
    }
    for (const [threadId, terminal] of Array.from(setupTerminals)) {
      if (terminal.worktreePath === wanted || (await realPath(terminal.worktreePath)) === wanted) {
        setupTerminals.delete(threadId);
        await context.services
          .tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY)
          ?.close({ threadId, terminalId: terminal.terminalId })
          .catch(() => undefined);
      }
    }
    await removeWorktree(git, known.path, options);
    // A locked worktree survives a prune: still listed, it was not removed.
    for (const entry of await listWorktrees(git)) {
      if ((await realPath(entry.path)) === wanted) {
        throw new SourceControlError(
          "GIT_FAILED",
          `git still lists ${path} as a worktree (is it locked?)`,
          { path },
        );
      }
    }
    if (options.deleteBranch === true && known.branch !== null) {
      await git(["branch", "-D", "--", known.branch], { ok: [0, 1] });
    }
    await refresh(repo);
  }

  const handoffs = new Map<string, Promise<unknown>>();
  function handoffLocked<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const result = (handoffs.get(threadId) ?? Promise.resolve()).then(task, task);
    const settled = result.catch(() => undefined);
    handoffs.set(threadId, settled);
    void settled.then(() => {
      if (handoffs.get(threadId) === settled) handoffs.delete(threadId);
    });
    return result;
  }

  async function handoffNow(
    threadId: string,
    options: Parameters<SourceControl["handoff"]>[1] = {},
  ): Promise<CreatedWorktree> {
    {
      const { thread } = (await context.commands.execute("threads.get", { threadId }).catch(() => {
        throw new SourceControlError("THREAD_NOT_FOUND", `No thread ${threadId} on this node`, {
          threadId,
        });
      })) as {
        thread: { projectId: string; worktreePath?: string; archivedAt?: string };
      };
      if (thread.worktreePath !== undefined) {
        throw new SourceControlError(
          "ALREADY_IN_WORKTREE",
          `Thread '${threadId}' is already attached to worktree '${thread.worktreePath}'.`,
          { threadId, worktreePath: thread.worktreePath },
        );
      }
      if (thread.archivedAt !== undefined) {
        throw new SourceControlError(
          "THREAD_ARCHIVED",
          "The thread is archived: unarchive it to continue",
          {
            threadId,
          },
        );
      }
      const repo = await repoOf(thread.projectId);
      const status = await refresh(repo);
      if (!status.isRepo) {
        throw new SourceControlError(
          "NOT_A_REPOSITORY",
          `Project workspace '${repo.project.path}' is not a git repository.`,
          { projectId: thread.projectId },
        );
      }
      const baseRef = options.baseRef ?? status.branch;
      if (baseRef === null) {
        throw new SourceControlError(
          "BRANCH_NOT_FOUND",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
          { projectId: thread.projectId },
        );
      }
      // Made and attached under the project's lock, so no removal lands in between.
      return exclusive(thread.projectId, () => attach(thread.projectId, baseRef));
    }

    async function attach(projectId: string, baseRef: string): Promise<CreatedWorktree> {
      const repo = await repoOf(projectId);
      const created = await createWorktreeNow(projectId, {
        baseRef,
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        ...(options.startFromOrigin === undefined
          ? {}
          : { startFromOrigin: options.startFromOrigin }),
      });
      try {
        await context.commands.execute("threads.update", {
          threadId,
          worktreePath: created.path,
        });
      } catch (error) {
        // Not moved after all: the half-made worktree and its branch go again (T3's
        // rollback); a failing clean-up never hides why the move failed.
        await gitOf(repo)
          .then(async ({ git }) => {
            await removeWorktree(git, created.path, { force: true });
            await git(["branch", "-D", "--", created.branch], { ok: [0, 1] });
          })
          .catch((cleanup: unknown) =>
            context.log.warn("a handoff's worktree could not be removed again", {
              threadId,
              error: String(cleanup),
            }),
          );
        throw error;
      }
      return created;
    }
  }

  /** Which forge a host is: a configured one, a GitHub host of `githubHosts`, else by its name. */
  function kindOfHost(host: string): ForgeKind | undefined {
    // As D275 orders them: configured hosts, then GitHub hosts, then what the name says.
    const { forgeHosts, githubHosts } = config();
    const name = host.toLowerCase().replace(/:\d+$/, "");
    const configured = Object.entries(forgeHosts).find(([key]) => key.toLowerCase() === name)?.[1];
    if (configured !== undefined) return configured;
    if (githubHosts.map((item) => item.toLowerCase()).includes(name)) return "github";
    return forgeKindOf(host);
  }

  /** A forge's driver working in `cwd`; `remoteUrl` names the repository pull requests go to. */
  function makeForge(
    kind: ForgeKind,
    cwd: string,
    remoteUrl: string | undefined,
  ): Forge | undefined {
    const tool = (key: "ghPath" | "glabPath" | "azPath" | "teaPath") => () => config()[key];
    if (kind === "github") return githubForge(tool("ghPath"), cwd, viewers);
    const site =
      remoteUrl === undefined ? { cwd, host: "", repository: "" } : siteOf(cwd, remoteUrl);
    if (site === undefined) return undefined;
    if (kind === "azure-devops") return azureForge(tool("azPath"), site, viewers);
    if (kind === "gitlab") return gitlabForge(tool("glabPath"), site, viewers);
    if (kind === "bitbucket") {
      return bitbucketForge(
        site,
        () => {
          const current = config();
          return bitbucketCredentials(
            {
              ...(current.bitbucketAccessToken === undefined
                ? {}
                : { accessToken: current.bitbucketAccessToken }),
              ...(current.bitbucketEmail === undefined ? {} : { email: current.bitbucketEmail }),
              ...(current.bitbucketApiToken === undefined
                ? {}
                : { apiToken: current.bitbucketApiToken }),
              ...(current.bitbucketApiBaseUrl === undefined
                ? {}
                : { apiBaseUrl: current.bitbucketApiBaseUrl }),
            },
            process.env,
          );
        },
        viewers,
      );
    }
    return forgejoForge(tool("teaPath"), site, viewers);
  }

  /** Where the repository's pull requests are created: its remote's forge, when it has one. */
  function forgeOf(repo: Repo, root: string): PullRequestCreator | undefined {
    if (repo.forge === undefined) return undefined;
    const forge = makeForge(repo.forge.kind, root, repo.forge.url);
    if (forge === undefined) return undefined;
    const git = repo.git!;
    return {
      terminology: forge.terminology,
      find: async (branch) => forge.find(await headContextOf(git, branch)),
      create: async (request) => {
        try {
          return await forge.create({ ...request, head: await headContextOf(git, request.head) });
        } catch (error) {
          throw new SourceControlError("PULL_REQUEST_FAILED", (error as Error).message);
        }
      },
      template: async (ref) => {
        for (const path of forge.templatePaths) {
          const shown = await git(["show", `${ref}:${path}`], { ok: [0, 128] });
          if (shown.code === 0 && shown.stdout.trim() !== "") return shown.stdout;
        }
        return undefined;
      },
    };
  }

  /** The agent that writes messages: the configured one, the thread's, else the first available. */
  async function writerRuntime(threadId: string | undefined): Promise<AgentRuntime | undefined> {
    const registry = context.services.tryGet<AgentRegistry>(AGENT_REGISTRY_CAPABILITY);
    if (registry === undefined) return undefined;
    const configured = config().writerAgent;
    if (configured !== undefined) return registry.get(configured);
    if (threadId !== undefined) {
      const answer = (await context.commands
        .execute("threads.get", { threadId })
        .catch(() => undefined)) as { thread?: { agentId?: string } } | undefined;
      const agentId = answer?.thread?.agentId;
      const runtime = agentId === undefined ? undefined : registry.get(agentId);
      if (runtime !== undefined) return runtime;
    }
    for (const runtime of registry.list()) {
      const status = await runtime.status?.().catch(() => ({ available: false }));
      if (status === undefined || status.available) return runtime;
    }
    return undefined;
  }

  /** The writer of a project's commit messages, pull requests and branch names (D266). */
  const writerFor = (projectId: string, threadId: string | undefined) =>
    agentWriter({
      runtime: () => writerRuntime(threadId),
      deadline: () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reached = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, config().writerTimeoutSeconds * 1000);
        });
        return { reached, dispose: () => clearTimeout(timer) };
      },
      warn: (message, fields) => context.log.warn(message, { projectId, ...fields }),
    });

  /** The repository a command acts on: the thread's (its worktree's) when named, else the project's. */
  async function repoFor(projectId: string, threadId: string | undefined): Promise<Repo> {
    if (threadId === undefined) return repoOf(projectId);
    await repoOf(projectId);
    return (await repoOfThread(threadId, projectId)) ?? repoOf(projectId);
  }

  // A managed worktree that went missing is made again from its branch before the
  // agent starts, ahead of the checkpoint of the turn's start (T3's turn start).
  context.subscriptions.add(
    context.hooks.before<TurnHookInput>(
      ThreadHooks.turnStart,
      async (input) => {
        const worktree = threadDirs.get(input.threadId)?.worktreePath;
        if (worktree === undefined || worktree !== input.cwd) return input;
        const missing = await Fs.stat(worktree).then(
          () => false,
          () => true,
        );
        // The stored path is a real path (D242): the root is compared as one too, so a
        // linked home or worktrees directory still counts as this node's.
        const root = await realPath(worktreesRoot(config().worktreesDirectory, hostPaths.home));
        if (!missing || !isManagedWorktree(root, worktree)) return input;
        try {
          const repo = await repoOf(input.projectId);
          const { git } = await gitOf(repo);
          // Its branch as git still lists the gone worktree; the recorded one went to
          // null once the folder could not be read.
          const branch =
            (await listWorktrees(git)).find(
              (entry) => entry.path === worktree || Path.resolve(entry.path) === worktree,
            )?.branch ?? threads.get(input.threadId)?.branch;
          if (branch == null) throw new Error("its branch is unknown");
          context.log.info("recreating a thread's missing worktree", {
            threadId: input.threadId,
            worktreePath: worktree,
            branch,
          });
          const warning = await recreateWorktree(
            git,
            worktree,
            branch,
            submodulesOf(input.projectId),
          );
          if (warning !== undefined) {
            context.log.warn("a recreated worktree's submodules", {
              worktreePath: worktree,
              warning,
            });
          }
        } catch (error) {
          // The turn fails saying why, instead of starting nowhere.
          throw new SourceControlError(
            "WORKTREE_MISSING",
            `The thread's worktree ${worktree} is gone and could not be made again: ${(error as Error).message}`,
            { threadId: input.threadId, worktreePath: worktree },
          );
        }
        return input;
      },
      { order: -10 },
    ),
  );

  /**
   * T3's rename of a new worktree's temporary branch after its thread's first
   * message (D901): beside the turn, never holding it up or failing it.
   */
  const renameFromFirstMessage = async (input: TurnHookInput) => {
    const git = createGit(config().gitPath, input.cwd);
    const branch = (await git(["branch", "--show-current"])).stdout.trim();
    if (stopped || !isTemporaryBranch(branch)) return;
    // All of them: a rollback far down the log still hands the naming to a later turn.
    const events: StoredEvent[] = [];
    for (;;) {
      const page = (await context.commands.execute("threads.events", {
        threadId: input.threadId,
        after: events.at(-1)?.sequence ?? 0,
        limit: 1000,
      })) as StoredEvent[];
      events.push(...page);
      if (page.length < 1000) break;
    }
    const first = firstMessageInputOf(events, input.turnId);
    if (first === undefined) return;
    const { branchNamingMode, branchNamePrefix, branchNameInstructions } = projectConfig(
      input.projectId,
    );
    const naming = {
      mode: branchNamingMode,
      prefix: branchNamePrefix,
      instructions: branchNameInstructions,
    };
    const fragment = await writerFor(input.projectId, input.threadId).branchName({
      message: first.text,
      attachments: first.attachments,
      naming,
    });
    // A plugin stopped while its writer ran leaves the repository alone, and so does a
    // branch switched or renamed meanwhile.
    if (fragment === undefined || stopped) return;
    if ((await git(["branch", "--show-current"])).stdout.trim() !== branch) return;
    const renamed = await renameTemporaryBranch(git, branch, fragment, naming);
    context.log.info("renamed a worktree's temporary branch", {
      threadId: input.threadId,
      from: branch,
      to: renamed,
    });
    // Every thread working in that worktree follows the new name.
    for (const [threadId, dir] of threadDirs) {
      if (stopped) return;
      if (dir.worktreePath === input.cwd) await recordThread(threadId, dir.projectId);
    }
  };

  context.subscriptions.add(
    context.hooks.before<TurnHookInput>(ThreadHooks.turnStart, async (input) => {
      if (threadDirs.get(input.threadId)?.worktreePath === input.cwd) {
        void renameFromFirstMessage(input).catch((error: unknown) =>
          context.log.warn("could not rename a worktree's temporary branch", {
            threadId: input.threadId,
            error: String(error),
          }),
        );
      }
      return input;
    }),
  );

  // --- Worktree setup (D1122–D1124) -------------------------------------------------------

  // Each thread's setup has a live stream that keeps only its latest snapshot.
  const setupStreams = createMemoryStreams({ log: context.log });
  if (live !== undefined) {
    context.subscriptions.add(
      // The script's command and output are a terminal's: reading them takes what that takes.
      live.serve(WORKTREE_SETUP_STREAM_PREFIX, setupStreams, {
        permissions: ["git.read", "terminals.read"],
      }),
    );
  }
  /** A thread's setup as last kept: a finished one, so a restart still shows it (D1479). */
  const SETUP_PREFIX = "setup/";
  const kept = new Map<string, string>();
  const keepSetup = (snapshot: WorktreeSetupSnapshot) => {
    // Its start (with its worktree once made) and its end: what a restart needs.
    const mark = `${snapshot.phase}|${snapshot.worktreePath ?? ""}`;
    if (kept.get(snapshot.threadId) === mark) return;
    kept.set(snapshot.threadId, mark);
    keepInOrder(snapshot.threadId, () =>
      kv.set(NAMESPACE, `${SETUP_PREFIX}${snapshot.threadId}`, snapshot as unknown as Json),
    );
  };
  /** A thread's writes of its kept setup, one after another: a later one never lands first. */
  const keeping = new Map<string, Promise<unknown>>();
  const keepInOrder = (threadId: string, write: () => Promise<unknown>) => {
    const next = (keeping.get(threadId) ?? Promise.resolve())
      .then(write)
      .catch((error: unknown) =>
        context.log.warn("could not keep a worktree setup", { threadId, error: String(error) }),
      );
    keeping.set(threadId, next);
    void next.then(() => {
      if (keeping.get(threadId) === next) keeping.delete(threadId);
    });
  };
  const setups = createSetupTracker({
    publish: (snapshot) => {
      const stream = worktreeSetupStream(snapshot.threadId);
      const earlier = setupStreams.events(stream).length;
      setupStreams.append(stream, WORKTREE_SETUP_CHANGED, snapshot as never);
      if (earlier > 0) setupStreams.drop(stream, earlier);
      keepSetup(snapshot);
    },
  });
  /**
   * A thread's setup: this run's, else the one kept (D1479); one kept as running was cut
   * short by a restart, and reads as failed.
   */
  async function setupOf(threadId: string): Promise<WorktreeSetupSnapshot | null> {
    const live = setups.get(threadId);
    if (live !== null) return live;
    const parsed = WorktreeSetupSnapshot.safeParse(
      await kv.get(NAMESPACE, `${SETUP_PREFIX}${threadId}`),
    );
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    if (snapshot.phase !== "running") return snapshot;
    const endedAt = new Date().toISOString();
    return {
      ...snapshot,
      phase: "failed",
      endedAt,
      error: "The node restarted during the setup.",
      stages: snapshot.stages.map((stage) =>
        stage.status === "running" ? { ...stage, status: "failed", endedAt } : stage,
      ),
    };
  }

  /** The terminal plugin's configured shell, when it has one (`jhin.terminal.shell`). */
  const terminalShell = (): string | undefined => {
    try {
      const shell = (context.config.get("jhin.terminal") as { shell?: unknown } | undefined)?.shell;
      return typeof shell === "string" && shell !== "" ? shell : undefined;
    } catch {
      return undefined;
    }
  };

  /** A thread's setup script, from its start until its first turn reads how it ended. */
  interface SetupRun {
    readonly worktreePath: string;
    terminalId: string | undefined;
    /** Holds the agent until it exits (T3's `async: false`). */
    holdsAgent: boolean;
    /** The exit code, null without one, "cancelled" when stopped. */
    readonly exited: Promise<number | null | "cancelled">;
    readonly cancel: () => void;
  }
  const setupRuns = new Map<string, SetupRun>();
  /** The terminal a thread's setup script ran in, kept open after a failure (for "Open terminal"). */
  const setupTerminals = new Map<string, { worktreePath: string; terminalId: string }>();
  /** Setups whose script is being looked up: the first turn waits until its run is known. */
  const setupStarts = new Map<string, Promise<void>>();

  /** The terminal sessions' live stream of one session, as the terminal plugin serves it. */
  const followTerminal: FollowTerminal = (threadId, terminalId, listener) => {
    const stream = terminalStream(threadId, terminalId);
    const served = live?.sourceOf(stream);
    if (served === undefined) return undefined;
    return served.source.subscribe(stream, (event) => listener(event));
  };

  /** Ends a setup whose agent has started and whose script is over (T3's `finish(done)`). */
  function settleSetup(threadId: string) {
    const snapshot = setups.get(threadId);
    if (snapshot?.phase !== "running") return;
    const stage = (id: string) => snapshot.stages.find((entry) => entry.id === id);
    const script = stage("setup-script");
    const agent = stage("agent");
    const over = (status: string | undefined) =>
      status === undefined || (status !== "pending" && status !== "running");
    if (over(script?.status) && over(agent?.status)) setups.finish(threadId, "done");
  }

  /** Runs the project's setup script for a thread; `registered` once its run is known (or none). */
  async function startSetupScript(
    threadId: string,
    projectId: string,
    worktreePath: string,
    registered: () => void,
  ) {
    // Known before anything is awaited, so a cancel from now on finds it.
    const cancelled = Promise.withResolvers<"cancelled">();
    const exitCode = Promise.withResolvers<number | null>();
    const run: SetupRun = {
      worktreePath,
      terminalId: undefined,
      holdsAgent: false,
      exited: Promise.race([cancelled.promise, exitCode.promise]),
      cancel: () => cancelled.resolve("cancelled"),
    };
    // Read by the agent's hook, if at all: a failed start is reported below.
    run.exited.catch(() => undefined);
    setupRuns.set(threadId, run);
    const wanted = () => setups.get(threadId)?.phase === "running";
    const forget = () => {
      if (setupRuns.get(threadId) === run) setupRuns.delete(threadId);
    };

    const projects = (await context.commands.execute("projects.list", {})) as {
      id: string;
      path: string;
      scripts?: unknown[];
    }[];
    const project = projects.find((entry) => entry.id === projectId);
    const scripts = (project?.scripts ?? []).flatMap((entry) => {
      const parsed = ProjectScript.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const script = setupProjectScript(scripts);
    const terminals = context.services.tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY);
    if (!wanted() || project === undefined || script === undefined || terminals === undefined) {
      forget();
      if (!wanted()) return;
      setups.stageStatus(
        threadId,
        "setup-script",
        "skipped",
        script !== undefined && terminals === undefined ? "no terminals" : undefined,
      );
      settleSetup(threadId);
      return;
    }
    run.holdsAgent = script.async === false;
    registered();
    setups.stageStatus(threadId, "setup-script", "running");
    let started: { terminalId: string; completion: Promise<number | null> } | undefined;
    try {
      started = await runSetupScript({
        terminals,
        follow: followTerminal,
        threadId,
        script,
        projectRoot: project.path,
        worktreePath,
        // The shell the terminal starts: the terminal plugin's setting, else $SHELL.
        shell: completionShellOf(process.platform, terminalShell() ?? process.env.SHELL),
        onLine: (line) => setups.appendTail(threadId, "setup-script", line),
        // Checked once the terminal is open, right before the script is typed.
        wanted,
      });
    } catch (error) {
      exitCode.reject(error);
      // A script that holds the agent and could not start fails the first turn: its hook
      // reads the run, so the run stays for it.
      if (!run.holdsAgent) forget();
      throw error;
    }
    if (started === undefined) {
      // Cancelled while its terminal opened: nothing was typed, and nothing closed it yet.
      forget();
      await terminals
        .close({ threadId, terminalId: setupTerminalId(script) })
        .catch(() => undefined);
      context.log.info("closed a cancelled setup's terminal", { threadId });
      return;
    }
    const terminalId = started.terminalId;
    run.terminalId = terminalId;
    setupTerminals.set(threadId, { worktreePath, terminalId });
    setups.update(threadId, (snapshot) => ({
      ...snapshot,
      setupScript: { name: script.name, command: script.command, terminalId },
    }));
    started.completion.then(exitCode.resolve, exitCode.reject);
    const outcome = await run.exited;
    // Stopped by a cancel that removes the worktree: its exit is no failure of its own.
    if (outcome === "cancelled" || cancelOutcomes.has(threadId)) return;
    // The first turn's hook reads how it ended; once that hook ran, nobody needs the run.
    const agent = setups.get(threadId)?.stages.find((entry) => entry.id === "agent");
    if (agent?.status !== "pending") forget();
    setups.stage(threadId, "setup-script", {
      status: outcome === 0 ? "done" : "failed",
      endedAt: new Date().toISOString(),
      detail: `exited with ${outcome ?? "no exit code"}`,
    });
    // A script that worked leaves nothing to look at; a failed one keeps its terminal.
    if (outcome === 0) {
      setupTerminals.delete(threadId);
      await terminals.close({ threadId, terminalId }).catch(() => undefined);
    }
    settleSetup(threadId);
  }

  /** A deleted thread's setup goes with it: its run, snapshot and stream. */
  function forgetSetup(threadId: string) {
    setupRuns.get(threadId)?.cancel();
    setupRuns.delete(threadId);
    const terminal = setupTerminals.get(threadId);
    setupTerminals.delete(threadId);
    if (terminal !== undefined) {
      void context.services
        .tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY)
        ?.close({ threadId, terminalId: terminal.terminalId })
        .catch(() => undefined);
    }
    setups.forget(threadId);
    setupStreams.delete(worktreeSetupStream(threadId));
    cancelOutcomes.delete(threadId);
    kept.delete(threadId);
    keepInOrder(threadId, () => kv.delete(NAMESPACE, `${SETUP_PREFIX}${threadId}`));
  }

  /**
   * How a first turn waiting for a cancelled setup goes on (D1477): it fails ("cancelled",
   * T3's "Worktree setup cancelled."), or starts in the project's checkout ("local").
   */
  const cancelOutcomes = new Map<string, "cancelled" | "local">();

  /**
   * T3's cancelled preparation: the new worktree goes (force; its branch stays) and the
   * thread works in the project's checkout. A removal that fails leaves both as they are.
   */
  async function abandonWorktree(threadId: string, worktreePath: string): Promise<boolean> {
    try {
      const projectId = await threadProject(threadId);
      const repo = await repoOf(projectId);
      const { git } = await gitOf(repo);
      await git(["worktree", "remove", "--force", "--", worktreePath], { timeoutMs: 300_000 });
      await context.commands.execute("threads.update", { threadId, worktreePath: null });
      context.log.info("removed a cancelled setup's worktree", { threadId, worktreePath });
      return true;
    } catch (error) {
      context.log.warn("could not remove a cancelled setup's worktree", {
        threadId,
        worktreePath,
        error: String(error),
      });
      return false;
    }
  }

  /** Cancels under way, by thread: a first turn waiting for its setup waits for them too. */
  const cancelling = new Map<string, Promise<boolean>>();
  function cancelSetup(
    threadId: string,
    options: { readonly workLocally?: boolean } = {},
  ): Promise<boolean> {
    const running = cancelling.get(threadId);
    if (running !== undefined) return running.then(() => false);
    const cancel = cancelSetupNow(threadId, options).finally(() => {
      if (cancelling.get(threadId) === cancel) cancelling.delete(threadId);
    });
    cancelling.set(threadId, cancel);
    return cancel;
  }

  async function cancelSetupNow(
    threadId: string,
    options: { readonly workLocally?: boolean },
  ): Promise<boolean> {
    const snapshot = setups.get(threadId);
    if (snapshot?.phase !== "running") return false;
    // Before the agent starts, T3 removes the new worktree: the turn then fails, or works
    // in the project's checkout ("Work locally"). Once it started, only the script stops.
    const agent = snapshot.stages.find((stage) => stage.id === "agent")?.status;
    const run = setupRuns.get(threadId);
    // A first turn not sent yet, or one the script holds: an `async` script's turn has its
    // agent already, and keeps its worktree.
    const held = agent === "running" && run?.holdsAgent === true;
    const before = agent === "pending" || held;
    if (before && snapshot.worktreePath !== null) {
      // Only a first turn held by the script is decided: one not sent yet starts in the
      // checkout the thread works in from now on.
      if (held) {
        cancelOutcomes.set(threadId, options.workLocally === true ? "local" : "cancelled");
      }
      // Its script stops first: nothing runs in the folder that goes.
      if (run?.terminalId !== undefined) {
        const terminalId = run.terminalId;
        run.terminalId = undefined;
        await context.services
          .tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY)
          ?.close({ threadId, terminalId })
          .catch(() => undefined);
      }
      // A worktree that could not go stays the thread's: its turn starts there (D1124).
      if (!(await abandonWorktree(threadId, snapshot.worktreePath))) {
        cancelOutcomes.delete(threadId);
      }
    }
    if (setups.get(threadId)?.phase !== "running") return false;
    setupRuns.delete(threadId);
    setupTerminals.delete(threadId);
    run?.cancel();
    if (run?.terminalId !== undefined) {
      await context.services
        .tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY)
        ?.close({ threadId, terminalId: run.terminalId })
        .catch(() => undefined);
    }
    setups.finish(threadId, "cancelled");
    return true;
  }

  /** A project's folder on this node. */
  async function projectPathOf(projectId: string): Promise<string> {
    const projects = (await context.commands.execute("projects.list", {})) as {
      id: string;
      path: string;
    }[];
    const project = projects.find((entry) => entry.id === projectId);
    if (project === undefined) {
      throw new SourceControlError("PROJECT_NOT_FOUND", `No project ${projectId} on this node`, {
        projectId,
      });
    }
    return project.path;
  }

  /** A first turn whose workspace could not be prepared: T3's Retry offers it again (D1478). */
  const workspaceFailure = (threadId: string, message: string) =>
    Object.assign(new SourceControlError("WORKTREE_SETUP_FAILED", message, { threadId }), {
      failure: { class: "workspace_preparation" as const },
    });

  // The first turn of a thread being set up starts its agent: a script with
  // `async: false` holds it until it exits (T3's release of the prepared run).
  context.subscriptions.add(
    context.hooks.before<TurnHookInput>(
      ThreadHooks.turnStart,
      async (input) => {
        const snapshot = setups.get(input.threadId);
        const agent = snapshot?.stages.find((stage) => stage.id === "agent");
        if (snapshot?.phase !== "running" || agent?.status !== "pending") return input;
        setups.stageStatus(input.threadId, "agent", "running");
        await setupStarts.get(input.threadId);
        const run = setupRuns.get(input.threadId);
        if (run?.holdsAgent === true) {
          const outcome = await run.exited.catch(() => null);
          // A cancel under way (its script stopped first) is waited for: it decides the turn.
          await cancelling.get(input.threadId)?.catch(() => false);
          if (setupRuns.get(input.threadId) === run) setupRuns.delete(input.threadId);
          // Cancelled while the turn waited: the setup is over as cancelled, and stays so; the
          // turn fails, or works in the project's checkout (D1477).
          if (setups.get(input.threadId)?.phase !== "running") {
            const how = cancelOutcomes.get(input.threadId);
            cancelOutcomes.delete(input.threadId);
            if (how === "cancelled") {
              throw workspaceFailure(input.threadId, "Worktree setup cancelled.");
            }
            // "Work locally": the hooks after this one, and the turn, work in the checkout.
            if (how === "local") return { ...input, cwd: await projectPathOf(input.projectId) };
            return input;
          }
          if (outcome !== "cancelled" && outcome !== 0) {
            const message = `Setup script exited with ${outcome ?? "no exit code"}.`;
            setups.finish(input.threadId, "failed", message);
            throw workspaceFailure(input.threadId, message);
          }
        }
        // A script that is over is read no more; one still running stays cancellable.
        const script = setups
          .get(input.threadId)
          ?.stages.find((stage) => stage.id === "setup-script");
        if (run !== undefined && script?.status !== "running" && script?.status !== "pending") {
          if (setupRuns.get(input.threadId) === run) setupRuns.delete(input.threadId);
        }
        setups.stageStatus(input.threadId, "agent", "done");
        settleSetup(input.threadId);
        return input;
      },
      { order: -20 },
    ),
  );

  // --- Commands ---------------------------------------------------------------------------

  const TargetFields = z.object({
    projectId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
  });
  const oneTarget = (input: z.infer<typeof TargetFields>) =>
    (input.projectId === undefined) !== (input.threadId === undefined);
  const Target = TargetFields.refine(oneTarget, { message: "Name a projectId or a threadId" });
  const projectOf = async (input: {
    projectId?: string | undefined;
    threadId?: string | undefined;
  }) => input.projectId ?? (await threadProject(input.threadId!));

  // The titles of this plugin's permissions (security.md D961).
  describePermissions(context, {
    "git.read": {
      title: "View source control",
      description: "Read status, branches, diffs, checkpoints and pull requests.",
    },
    "git.write": {
      title: "Change source control",
      description: "Commit, push, manage branches and repositories, and change pull requests.",
      // A repository's hooks run on commit, checkout and push (security.md D1517).
      shellAccess: true,
      shellAccessReason: "a repository's hooks run on this machine as the node's user",
    },
  });
  context.commands.register({
    name: "git.status",
    description:
      "Git status of this node's projects (branch, ahead/behind, uncommitted changes, pull requests) and each thread's branch, with the head of the `source-control` stream they reflect: follow the stream after `head` to keep them current",
    input: z.object({
      projectId: z.string().min(1).optional(),
      refresh: z.boolean().optional().meta({
        description: "Read the repositories and their pull requests again now",
      }),
    }),
    output: StatusSnapshot,
    permissions: ["git.read"],
    handler: async ({ projectId, refresh: reread }) => {
      await started;
      // The head first: a change made while the statuses are read is also delivered after it.
      const head = await log.head(SOURCE_CONTROL_STREAM);
      await Promise.all([loadProjects(), loadThreads()]);
      const chosen = projectId === undefined ? [...repos.values()] : [await repoOf(projectId)];
      const projects = await Promise.all(chosen.map((repo) => listedStatus(repo, reread === true)));
      const listed = [...threads.values()].filter(
        (thread) => projectId === undefined || thread.projectId === projectId,
      );
      const ids = new Set(listed.map((thread) => thread.threadId));
      return {
        head,
        projects,
        threads: listed,
        links: (await links.all()).filter(
          (entry) => projectId === undefined || ids.has(entry.threadId),
        ),
        checkpoints: (await turns.latest()).filter(
          (checkpoint) => projectId === undefined || ids.has(checkpoint.threadId),
        ),
        worktrees: await Promise.all(
          [...worktreeRepos.values()]
            .filter((repo) => projectId === undefined || repo.project.id === projectId)
            .map(async (repo) => ({
              ...(await listedStatus(repo, reread === true)),
              worktreePath: repo.worktree!,
            })),
        ),
      };
    },
  });

  context.commands.register({
    name: "git.thread.status",
    description:
      "A thread's branch, whether it is checked out, its pull request and the git status of where it works (its worktree, else its project)",
    input: z.object({ threadId: z.string().min(1), refresh: z.boolean().optional() }),
    output: z.object({
      thread: ThreadBranch.nullable(),
      checkedOut: z.boolean(),
      pullRequest: PullRequest.nullable(),
      status: ProjectStatus,
    }),
    permissions: ["git.read"],
    handler: async ({ threadId, refresh: reread }) => {
      const projectId = await threadProject(threadId);
      const project = await service.status(projectId, { refresh: reread === true });
      const repo = await repoFor(projectId, threadId);
      const status = repo.worktree === undefined ? project : await statusOf(repo);
      const thread = (await service.threadBranch(threadId)) ?? null;
      const branch = thread?.branch ?? null;
      return {
        thread,
        checkedOut: branch !== null && branch === status.branch,
        // Pull requests are looked up by the project, for every thread's branch.
        pullRequest: branch === null ? null : (project.pullRequests[branch] ?? null),
        status,
      };
    },
  });

  /** The target and scope of `git.diff`, which `git.diff.file` takes too. */
  const DiffInput = z.object({
    projectId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    scope: DiffScope.optional(),
    base: z.string().min(1).optional().meta({
      description:
        "For the branch scope: the branch to compare with (the default branch otherwise)",
    }),
    ignoreWhitespace: z.boolean().optional(),
    turn: z.number().int().positive().optional().meta({
      description: "For the turn scope: the thread's turn count after the turn (1 is its first)",
    }),
    fromTurn: z.number().int().nonnegative().optional().meta({
      description:
        "For the turn scope: the turn count to compare from (the turn before by default; 0 is before the first turn)",
    }),
  });
  const diffInputRules = (input: z.output<typeof DiffInput>, check: z.RefinementCtx) => {
    if ((input.projectId === undefined) === (input.threadId === undefined)) {
      check.addIssue({ code: "custom", message: "Name a projectId or a threadId" });
    }
    if (input.scope === "turn" && (input.threadId === undefined || input.turn === undefined)) {
      check.addIssue({ code: "custom", message: "The turn scope takes a threadId and a turn" });
    }
  };

  context.commands.register({
    name: "git.diff",
    description:
      "The diff of a project (or a thread's project): uncommitted changes against HEAD, the branch's changes against its base (untracked files count as added), or what a thread's turn changed (`turn` scope: between its checkpoints)",
    input: DiffInput.superRefine(diffInputRules),
    output: Diff,
    permissions: ["git.read"],
    handler: async (input) =>
      input.scope === "turn"
        ? service.turnDiff(input.threadId!, input.turn!, {
            ...(input.fromTurn === undefined ? {} : { fromTurn: input.fromTurn }),
            ...(input.ignoreWhitespace === undefined
              ? {}
              : { ignoreWhitespace: input.ignoreWhitespace }),
          })
        : service.diff(await projectOf(input), {
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.base === undefined ? {} : { base: input.base }),
            ...(input.ignoreWhitespace === undefined
              ? {}
              : { ignoreWhitespace: input.ignoreWhitespace }),
          }),
  });

  context.commands.register({
    name: "git.diff.file",
    description:
      "One file of a `git.diff`, both sides whole, to show the unchanged lines between its hunks: the same target and scope as the diff, and one of the files it lists (at most 1 MB a side, no binary files)",
    input: DiffInput.omit({ ignoreWhitespace: true })
      .extend({
        path: z.string().min(1),
        previousPath: z
          .string()
          .min(1)
          .optional()
          .meta({ description: "The path before a rename" }),
      })
      .superRefine(diffInputRules),
    output: DiffFileContents,
    permissions: ["git.read"],
    handler: async ({ path, previousPath, ...input }) =>
      service.diffFile(
        // A turn's file is read from its thread alone, as `git.diff` reads a turn's diff.
        {
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        },
        { path, ...(previousPath === undefined ? {} : { previousPath }) },
        {
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.base === undefined ? {} : { base: input.base }),
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.fromTurn === undefined ? {} : { fromTurn: input.fromTurn }),
        },
      ),
  });

  context.commands.register({
    name: "git.checkpoints",
    description:
      "A thread's checkpoints, oldest first: for each turn that completed or was stopped, its turn count, status and the files it changed",
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ checkpoints: z.array(TurnCheckpoint) }),
    permissions: ["git.read"],
    handler: async ({ threadId }) => ({ checkpoints: await service.checkpoints(threadId) }),
  });

  context.commands.register({
    name: "git.tree",
    description:
      "The git tree of the files where a thread works (its worktree, else its project) or of a project, committed or not (untracked in, ignored out): the same content has the same tree, so a different tree means the files changed. `exclude` names folders left out wherever they are, committed or not",
    input: TargetFields.extend({
      exclude: z
        .array(
          z
            .string()
            .regex(/^[\w.-]+(\/[\w.-]+)*$/, "A relative folder path, without globs")
            .refine(
              (folder) => folder.split("/").every((part) => part !== "." && part !== ".."),
              "No `.` or `..` in a folder path",
            ),
        )
        .optional()
        .meta({ description: "Folders left out of the tree at any depth (D1261)" }),
    }).refine(oneTarget, { message: "Name a projectId or a threadId" }),
    output: z.object({ projectId: z.string(), path: z.string(), tree: z.string() }),
    permissions: ["git.read"],
    handler: async (input) => {
      const projectId = await projectOf(input);
      const repo = await repoFor(projectId, input.threadId);
      const { git, root, commonDir } = await gitOf(repo);
      return {
        projectId,
        path: root,
        tree: await writeWorkingTree(git, commonDir, input.exclude ?? []),
      };
    },
  });

  context.commands.register({
    name: "git.branches",
    description:
      "Local and remote branches of a project (or a thread's project), the current one first",
    input: Target,
    output: z.object({ branches: z.array(Branch) }),
    permissions: ["git.read"],
    handler: async (input) => ({
      branches: await service.branches(
        await projectOf(input),
        input.threadId === undefined ? {} : { threadId: input.threadId },
      ),
    }),
  });

  context.commands.register({
    name: "git.checkout",
    title: "Check out a branch",
    description:
      "Checks a branch out in a project (a remote branch as a local one following it; `create` makes a new branch from HEAD); `threadId` moves that thread to the branch",
    input: z.object({
      projectId: z.string().min(1),
      branch: z.string().min(1),
      create: z.boolean().optional(),
      threadId: z.string().min(1).optional(),
    }),
    output: ProjectStatus,
    permissions: ["git.write"],
    handler: async ({ projectId, branch, create, threadId }) =>
      service.checkout(projectId, branch, {
        ...(create === undefined ? {} : { create }),
        ...(threadId === undefined ? {} : { threadId }),
      }),
  });

  context.commands.register({
    name: "git.action.run",
    title: "Run a git action",
    description:
      "Commits, pushes and creates a pull request in a project (or a thread's project), as T3 Code's git actions do: `commit`, `push`, `create_pr`, `commit_push` or `commit_push_pr`. Without `commitMessage` the node's agent writes it; `featureBranch` commits on a new branch named after the changes. Progress goes to the `source-control/actions` live stream under `actionId`",
    input: z
      .object({
        projectId: z.string().min(1).optional(),
        ...GitActionOptions.shape,
      })
      .refine((input) => input.projectId !== undefined || input.threadId !== undefined, {
        message: "Name a projectId or a threadId",
      }),
    output: GitActionResult,
    permissions: ["git.write"],
    handler: async ({ projectId, ...options }) =>
      service.runAction(projectId ?? (await threadProject(options.threadId!)), options),
  });

  const LinkInput = z.object({
    threadId: z.string().min(1),
    url: z.string().min(1).optional().meta({ description: "The pull request's URL" }),
    repository: z
      .string()
      .min(1)
      .optional()
      .meta({ description: "owner/repo, with number, when no url is given" }),
    number: z.number().int().positive().optional(),
    host: z
      .string()
      .min(1)
      .optional()
      .meta({ description: "The forge's host; the project's remote's when absent" }),
  });
  const target = (input: z.output<typeof LinkInput>): LinkTarget => ({
    url: input.url,
    repository: input.repository,
    number: input.number,
    host: input.host,
  });
  const ensureThread = async (threadId: string) => {
    await threadProject(threadId);
  };

  context.commands.register({
    name: "git.pr.link",
    title: "Link pull request",
    description:
      "Register every pull request you open for this thread, including each layer of a stack, right after creating it. Links a pull request to a thread so its state shows beside the thread. Pass the url, or repository plus number. Linking an already-linked pull request succeeds with alreadyLinked=true",
    input: LinkInput.extend({
      source: z.enum(["manual", "agent"]).optional().meta({
        description: "Who links it: `manual` from a person, `agent` (the default) from an agent",
      }),
    }),
    output: z.object({ pullRequest: ThreadPullRequest, alreadyLinked: z.boolean() }),
    permissions: ["git.write"],
    handler: async ({ source, ...input }) => {
      await ensureThread(input.threadId);
      return links.link(input.threadId, target(input), source ?? "agent");
    },
  });

  /** The forge that checks a project's pull requests out, its repository and git (D902). */
  const checkoutForge = async (projectId: string) => {
    const repo = await repoOf(projectId);
    const { git, root } = await gitOf(repo);
    const forge =
      repo.forge === undefined ? undefined : makeForge(repo.forge.kind, root, repo.forge.url);
    if (forge?.resolve === undefined) {
      throw new SourceControlError(
        "ACTION_UNAVAILABLE",
        forge === undefined
          ? "This repository has no remote on a known forge."
          : `Checking out a ${forge.terminology.singular} of ${forge.name} is not supported yet.`,
        { projectId },
      );
    }
    const resolve = forge.resolve.bind(forge);
    // A forge was made, so the repository has one, with its remote's URL.
    const forgeUrl = repo.forge!.url;
    const lookUp = async (reference: string) => {
      const normalized = normalizeReference(reference);
      if (normalized === "") {
        throw new SourceControlError("PULL_REQUEST_INVALID", "Name a pull request");
      }
      let found;
      try {
        found = await resolve(normalized);
      } catch (error) {
        throw new SourceControlError("PULL_REQUEST_FAILED", (error as Error).message, {
          reference: normalized,
        });
      }
      // A URL may name another repository's pull request: its refs are not this one's. A
      // number or branch is looked up in this repository (a renamed one answers its new URL).
      if (/^https?:\/\//i.test(normalized) && !isPullRequestOf(forgeUrl, found.pr.url)) {
        throw new SourceControlError(
          "PULL_REQUEST_INVALID",
          `${found.pr.url} is not a pull request of this project's repository.`,
          { reference: normalized },
        );
      }
      return found;
    };
    return { repo, git, root, lookUp };
  };

  const PullRequestReference = z.object({
    projectId: z.string().min(1),
    reference: z.string().min(1).meta({
      description: "The pull request's number (`42`, `#42`), URL or head branch",
    }),
  });

  context.commands.register({
    name: "git.pr.resolve",
    title: "Resolve pull request",
    description: "Looks a pull request of a project's repository up by number, URL or head branch",
    input: PullRequestReference,
    output: z.object({ pullRequest: PullRequest }),
    permissions: ["git.read"],
    handler: async ({ projectId, reference }) => {
      const { lookUp } = await checkoutForge(projectId);
      return { pullRequest: (await lookUp(reference)).pr };
    },
  });

  context.commands.register({
    name: "git.pr.search",
    title: "Search pull requests",
    description:
      "A project's repository's pull requests, any state, most recently updated first; `query` is searched on the forge (the composer's `#` menu)",
    input: z.object({
      projectId: z.string().min(1),
      query: z.string().max(200).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    output: z.object({ pullRequests: z.array(PullRequest) }),
    permissions: ["git.read"],
    handler: async ({ projectId, query, limit }) => {
      const repo = await repoOf(projectId);
      const { root } = await gitOf(repo);
      const forge =
        repo.forge === undefined ? undefined : makeForge(repo.forge.kind, root, repo.forge.url);
      if (forge?.list === undefined) {
        throw new SourceControlError(
          "ACTION_UNAVAILABLE",
          forge === undefined
            ? "This repository has no remote on a known forge."
            : `Listing the ${forge.terminology.singular}s of ${forge.name} is not supported yet.`,
          { projectId },
        );
      }
      try {
        return {
          pullRequests: await forge.list({
            ...(query === undefined ? {} : { query }),
            limit: limit ?? 30,
          }),
        };
      } catch (error) {
        // A missing or signed-out CLI will not answer the next `#` either.
        const unavailable = error instanceof ForgeUnavailable && error.kind !== "failed";
        throw new SourceControlError(
          unavailable ? "ACTION_UNAVAILABLE" : "PULL_REQUEST_FAILED",
          (error as Error).message,
          { projectId },
        );
      }
    },
  });

  /** The forge of a pull request's URL, working in its project's repository (D1450, D1451). */
  const forgeOfUrl = async (projectId: string, url: string) => {
    const parsed = parsePullRequestUrl(url);
    if (parsed === undefined) {
      throw new SourceControlError(
        "PULL_REQUEST_INVALID",
        "This is not a recognised pull request URL. Pass repository and number instead.",
        { url },
      );
    }
    const repo = await repoOf(projectId);
    const { git, root } = await gitOf(repo);
    const key = pullRequestKey(parsed);
    // Only the project's own pull requests (of any of its remotes) and the ones its threads
    // link: a caller allowed this project acts on nothing else through the node's account.
    const remotes = (await git(["remote"])).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    let ours = false;
    for (const remote of remotes) {
      const remoteUrl = await git(["config", "--get", `remote.${remote}.url`], { ok: [0, 1] });
      if (remoteUrl.code === 0 && isPullRequestOf(remoteUrl.stdout, url)) ours = true;
    }
    if (!ours) {
      for (const entry of await links.all()) {
        if (!entry.pullRequests.some((link) => link.key === key)) continue;
        if ((await projectRepoOfThread(entry.threadId))?.project.id === projectId) ours = true;
      }
    }
    if (!ours) {
      throw new SourceControlError(
        "PULL_REQUEST_INVALID",
        `${url} is not a pull request of this project's repository or of its threads.`,
        { url },
      );
    }
    const kind = kindOfHost(parsed.host);
    const forge = kind === undefined ? undefined : makeForge(kind, root, undefined);
    if (forge === undefined) {
      throw new SourceControlError("ACTION_UNAVAILABLE", `${parsed.host} is not a known forge.`, {
        url,
      });
    }
    return { forge, key };
  };
  /** A forge's failure as the commands report it: unavailable, or failed with its words. */
  const forgeFailure = (error: unknown, fields: Record<string, unknown>) => {
    if (error instanceof SourceControlError) return error;
    const unavailable = error instanceof ForgeUnavailable && error.kind !== "failed";
    return new SourceControlError(
      unavailable ? "ACTION_UNAVAILABLE" : "PULL_REQUEST_FAILED",
      (error as Error).message,
      fields,
    );
  };

  context.commands.register({
    name: "git.pr.detail",
    title: "Pull request detail",
    description:
      "A pull request's details by URL: its snapshot with author, diff stat, review decision and mergeability, its head's checks one by one, the merge methods its repository allows and the actions its forge has",
    input: z.object({ projectId: z.string().min(1), url: z.string().min(1) }),
    output: PullRequestDetail,
    permissions: ["git.read"],
    handler: async ({ projectId, url }) => {
      const { forge } = await forgeOfUrl(projectId, url);
      try {
        const [pullRequest, checks, mergeMethods] = await Promise.all([
          forge.at(url),
          forge.checks !== undefined
            ? forge.checks(url)
            : // A watch read that fails leaves the checks unknown, as a failed merge-methods read.
              (forge.watch?.(url) ?? Promise.resolve(undefined))
                .catch(() => undefined)
                .then((watched) =>
                  (watched?.checks ?? []).map((check) => ({
                    name: check.name,
                    status: check.status,
                    description: null,
                    url: check.url ?? null,
                    ...(check.required === undefined ? {} : { required: check.required }),
                  })),
                ),
          // Without them only Merge is missing; the rest of the detail stands.
          forge.mergeMethods(url).catch((): PullRequestMergeMethod[] => []),
        ]);
        return { pullRequest, checks, mergeMethods, actions: [...forge.actions] };
      } catch (error) {
        throw forgeFailure(error, { url });
      }
    },
  });

  context.commands.register({
    name: "git.pr.action",
    title: "Act on pull request",
    description:
      "Merges a pull request (with mergeMethod, `merge` by default), marks a draft ready for review, closes or reopens it, by URL; every thread that links it gets its new state",
    input: z.object({
      projectId: z.string().min(1),
      url: z.string().min(1),
      action: PullRequestAction,
      mergeMethod: PullRequestMergeMethod.optional(),
    }),
    output: z.object({
      /** `null` when the pull request could not be read again after the action, which was done. */
      pullRequest: PullRequest.nullable(),
    }),
    permissions: ["git.write"],
    handler: async ({ projectId, url, action, mergeMethod }) => {
      const { forge, key } = await forgeOfUrl(projectId, url);
      if (!forge.actions.includes(action)) {
        throw new SourceControlError(
          "ACTION_UNAVAILABLE",
          `${forge.name} does not expose ${action} through its API.`,
          { url },
        );
      }
      // A merge takes a method the repository allows: the one asked for, refused when not
      // allowed, else "merge" when allowed, else the first allowed (T3's
      // resolveSelectedMergeMethod).
      let method = mergeMethod ?? "merge";
      if (action === "merge") {
        const allowed = await forge.mergeMethods(url).catch(() => undefined);
        if (allowed !== undefined && !allowed.includes(method)) {
          if (mergeMethod !== undefined || allowed.length === 0) {
            throw new SourceControlError(
              "ACTION_UNAVAILABLE",
              `This repository does not allow the ${method} merge method (it allows: ${allowed.join(", ") || "none"}).`,
              { url },
            );
          }
          method = allowed[0]!;
        }
      }
      try {
        await forge.act(url, action, method);
      } catch (error) {
        throw forgeFailure(error, { url, action });
      }
      // Done on the forge: a read that fails now answers null, and the next sync reads it.
      const pullRequest = await forge.at(url).catch((error: unknown) => {
        context.log.warn("reading a pull request after its action failed", {
          url,
          error: String(error),
        });
        return null;
      });
      if (pullRequest === null) return { pullRequest };
      // Done on the forge: a link that cannot be updated now is read again by the next sync.
      const syncedAt = new Date().toISOString();
      for (const entry of await links.all()) {
        if (!entry.pullRequests.some((link) => link.key === key)) continue;
        await links
          .modify(entry.threadId, key, (link) => ({ ...link, snapshot: pullRequest, syncedAt }))
          .catch((error: unknown) =>
            context.log.warn("updating a link after a pull request action failed", {
              threadId: entry.threadId,
              error: String(error),
            }),
          );
      }
      return { pullRequest };
    },
  });

  context.commands.register({
    name: "git.pr.checkout",
    title: "Checkout pull request",
    description:
      "Checks a pull request out for a new thread: in the project's own checkout (`local`) or in a worktree (`worktree`, reused when one has its branch)",
    input: PullRequestReference.extend({ mode: z.enum(["local", "worktree"]) }),
    output: PreparedPullRequest,
    permissions: ["git.write"],
    handler: async ({ projectId, reference, mode }) => {
      const { repo, git, root, lookUp } = await checkoutForge(projectId);
      const found = await lookUp(reference);
      const warn = (message: string, fields: Record<string, unknown>) =>
        context.log.warn(message, { projectId, ...fields });
      // One at a time per project, as worktrees are made.
      const prepared = await exclusive(projectId, () =>
        mode === "local"
          ? checkoutLocal(git, found, warn)
          : checkoutWorktree(git, found, {
              repository: root,
              root: worktreesRoot(config().worktreesDirectory, hostPaths.home),
              createGit: (cwd) => createGit(config().gitPath, cwd),
              warn,
            }),
      );
      void refresh(repo).catch(() => undefined);
      return prepared;
    },
  });

  context.commands.register({
    name: "git.pr.unlink",
    title: "Unlink pull request",
    description: "Unlinks a pull request from a thread, by url or by repository plus number",
    input: LinkInput,
    output: z.object({ key: z.string(), wasLinked: z.boolean() }),
    permissions: ["git.write"],
    handler: async (input) => {
      await ensureThread(input.threadId);
      return links.unlink(input.threadId, target(input));
    },
  });

  context.commands.register({
    name: "git.pr.list",
    description:
      "The pull requests linked to a thread with their last known state, and how they chain into stacks (bottom to top); `refresh` reads them from the forge again",
    input: z.object({ threadId: z.string().min(1), refresh: z.boolean().optional() }),
    output: z.object({
      pullRequests: z.array(ThreadPullRequest),
      chains: z.array(z.object({ numbers: z.array(z.number()), keys: z.array(z.string()) })),
    }),
    permissions: ["git.read"],
    handler: async ({ threadId, refresh: reread }) => {
      await ensureThread(threadId);
      if (reread === true) await links.sync(threadId, { all: true });
      const pullRequests = await links.list(threadId);
      const byKey = new Map(pullRequests.map((link) => [link.key, link]));
      return {
        pullRequests,
        chains: pullRequestChains(pullRequests).map((chain) => ({
          keys: [...chain.keys],
          numbers: chain.keys.map((key) => byKey.get(key)!.number),
        })),
      };
    },
  });

  const watchOutput = z.object({
    pullRequest: ThreadPullRequest,
    watching: z.boolean(),
    wasWatching: z.boolean(),
  });
  context.commands.register({
    name: "git.pr.watch",
    title: "Watch pull request",
    description:
      "Watches a pull request for the thread (linking it first): when its checks finish, someone else comments or the branch conflicts with its base, a message wakes the thread. Watching stops when it merges or closes, or with git.pr.unwatch; call that before handing the work back",
    input: LinkInput,
    output: watchOutput,
    permissions: ["git.write"],
    handler: async (input) => {
      await ensureThread(input.threadId);
      // An archived thread is refused before anything is linked.
      const thread = (await context.commands
        .execute("threads.get", { threadId: input.threadId })
        .catch(() => undefined)) as { thread?: { archivedAt?: string } } | undefined;
      if (thread?.thread?.archivedAt !== undefined) {
        throw new SourceControlError(
          "ACTION_UNAVAILABLE",
          `Thread ${input.threadId} is archived and cannot watch pull requests`,
        );
      }
      const { pullRequest, alreadyLinked } = await links.link(
        input.threadId,
        target(input),
        "agent",
      );
      // Only a forge whose pull requests a watch can read is watched (every known one, D1442).
      const forge = await forgeOfLink(input.threadId, pullRequest.host);
      if (forge?.watch === undefined) {
        if (!alreadyLinked) await links.unlink(input.threadId, target(input));
        throw new SourceControlError(
          "ACTION_UNAVAILABLE",
          `Watching pull requests on ${forge?.name ?? pullRequest.host} is not supported on this node yet.`,
        );
      }
      let result: Awaited<ReturnType<typeof watcher.watch>>;
      try {
        result = await watcher.watch(input.threadId, pullRequest);
      } catch (error) {
        // A refused watch leaves no link it made behind.
        if (!alreadyLinked) await links.unlink(input.threadId, target(input));
        throw error;
      }
      const current = (await links.find(input.threadId, target(input))) ?? pullRequest;
      return { pullRequest: current, ...result };
    },
  });
  context.commands.register({
    name: "git.pr.unwatch",
    title: "Stop watching pull request",
    description: "Stops watching a pull request for the thread; it stays linked",
    input: LinkInput,
    output: watchOutput,
    permissions: ["git.write"],
    handler: async (input) => {
      await ensureThread(input.threadId);
      const link = await links.find(input.threadId, target(input));
      if (link === undefined) {
        throw new SourceControlError(
          "PULL_REQUEST_INVALID",
          "The pull request is not linked to the thread.",
        );
      }
      const result = await watcher.unwatch(input.threadId, link);
      return { pullRequest: (await links.find(input.threadId, target(input)))!, ...result };
    },
  });
  context.commands.register({
    name: "git.pr.watch.check",
    title: "Check watched pull requests",
    description:
      "Reads the watched pull requests (of one thread, or all) now instead of at the next sweep, and wakes the threads that have news",
    input: z.object({ threadId: z.string().min(1).optional() }),
    output: z.object({ checked: z.number().int(), woken: z.number().int() }),
    permissions: ["git.write"],
    handler: async ({ threadId }) => watcher.sweep(threadId),
  });

  const WorktreeOptions = {
    branch: z.string().min(1).optional().meta({
      description: "The new branch of the worktree (a temporary jhin/<hex> name when absent)",
    }),
    startFromOrigin: z.boolean().optional().meta({
      description:
        "Fetch the base from origin and start from origin/<baseRef> when it exists there",
    }),
  };

  context.commands.register({
    name: "git.worktree.create",
    title: "Create a worktree",
    description:
      "Makes a new git worktree of a project's repository, on a new branch from `baseRef`, under the node's worktrees directory",
    input: z.object({
      projectId: z.string().min(1),
      baseRef: z.string().min(1),
      ...WorktreeOptions,
      threadId: z.string().min(1).optional().meta({
        description:
          "The new thread that will work there: its setup is tracked and the project's setup script runs in it",
      }),
    }),
    output: CreatedWorktree,
    permissions: ["git.write"],
    handler: ({ projectId, ...options }) => service.createWorktree(projectId, options),
  });

  context.commands.register({
    name: "git.worktree.setup.get",
    description:
      "The setup of a thread's new worktree as it stands (T3's worktree setup snapshot), or null",
    input: z.object({ threadId: z.string().min(1) }),
    output: WorktreeSetupSnapshot.nullable(),
    permissions: ["git.read", "terminals.read"],
    handler: async ({ threadId }) => setupOf(threadId),
  });

  /** Runs of `scripts.run` under way, by thread and script. */
  const scriptRuns = new Map<string, Promise<{ terminalId: string }>>();

  /** Types a script into a thread's terminal, its variables exported before it (D1472). */
  async function typeScript(
    terminals: TerminalSessions,
    input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly cwd: string;
      readonly command: string;
      readonly projectRoot: string;
      readonly worktreePath: string | undefined;
    },
  ) {
    await terminals.open({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
    });
    terminals.write({
      threadId: input.threadId,
      terminalId: input.terminalId,
      data: `${scriptCommandLine(
        input.command,
        completionShellOf(process.platform, terminalShell() ?? process.env.SHELL),
        {
          JHIN_PROJECT_ROOT: input.projectRoot,
          ...(input.worktreePath === undefined ? {} : { JHIN_WORKTREE_PATH: input.worktreePath }),
        },
      )}\r`,
    });
  }

  // T3's cleanUpSettledThread (D1476): the settle script, once per settling, in the
  // thread's own worktree; a thread in the project's checkout runs none.
  const SETTLE_PREFIX = "settle-script/";
  /** Each thread's settling as last seen, and whether the settled threads were read at start. */
  const settledSeen = new Map<string, string | null>();
  let settledKnown = false;
  /** The settling each thread's script was claimed for, before anything is awaited. */
  const settleClaims = new Map<string, string>();
  async function runSettleScript(threadId: string, settledAt: string) {
    if (settleClaims.get(threadId) === settledAt) return;
    settleClaims.set(threadId, settledAt);
    try {
      await settleScriptNow(threadId, settledAt);
    } finally {
      // A settling it did not get to keep may be tried again by its thread's next update.
      if ((await kv.get(NAMESPACE, `${SETTLE_PREFIX}${threadId}`)) !== settledAt) {
        if (settleClaims.get(threadId) === settledAt) settleClaims.delete(threadId);
      }
    }
  }
  async function settleScriptNow(threadId: string, settledAt: string) {
    if ((await kv.get(NAMESPACE, `${SETTLE_PREFIX}${threadId}`)) === settledAt) return;
    const terminals = context.services.tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY);
    if (terminals === undefined || stopped) return;
    const { thread } = (await context.commands.execute("threads.get", { threadId })) as {
      thread: {
        projectId: string;
        worktreePath?: string;
        settledOverride?: string;
        settledAt?: string;
      };
    };
    // Taken back up meanwhile, or settled again since: not this settling's to clean.
    if (thread.settledOverride !== "settled" || thread.settledAt !== settledAt) return;
    const worktree = thread.worktreePath;
    if (worktree === undefined || !(await exists(worktree))) return;
    const projects = (await context.commands.execute("projects.list", {})) as {
      id: string;
      path: string;
      scripts?: unknown[];
    }[];
    const project = projects.find((entry) => entry.id === thread.projectId);
    // The project's own checkout is shared with other threads: no cleanup there.
    if (project === undefined || Path.resolve(project.path) === Path.resolve(worktree)) return;
    const script = settleProjectScript(
      (project.scripts ?? []).flatMap((entry) => {
        const parsed = ProjectScript.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    );
    await kv.set(NAMESPACE, `${SETTLE_PREFIX}${threadId}`, settledAt);
    if (script === undefined) return;
    // A settle shell of an earlier settling may still be busy: a terminal of its own.
    const terminalId = `settle-${script.id}-${randomUUID().slice(0, 8)}`.slice(0, 128);
    await typeScript(terminals, {
      threadId,
      terminalId,
      cwd: worktree,
      command: script.command,
      projectRoot: project.path,
      worktreePath: worktree,
    });
    context.log.info("ran a settle script", { threadId, terminalId, script: script.id });
  }

  // T3's runProjectScript (D1472): the scripts menu, a script's shortcut, an agent.
  context.commands.register({
    name: "scripts.run",
    title: "Run project script",
    description:
      "Runs one of a project's scripts in a terminal of a thread (T3's scripts menu): typed into the thread's terminal script-<id> in the thread's worktree or the project's folder, a new one when that terminal still runs a program; answers the terminal",
    input: z.object({ threadId: z.string().min(1), scriptId: z.string().min(1) }),
    output: z.object({ terminalId: z.string() }),
    permissions: ["terminals.write"],
    // One run of a thread's script at a time: two quick runs never type into one free shell.
    handler: ({ threadId, scriptId }) => {
      const key = `${threadId}\u0000${scriptId}`;
      const run = (scriptRuns.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => runScript(threadId, scriptId));
      scriptRuns.set(key, run);
      // The caller hears the run's failure; the bookkeeping only lets go of it.
      void run
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (scriptRuns.get(key) === run) scriptRuns.delete(key);
        });
      return run;
    },
  });

  async function runScript(threadId: string, scriptId: string): Promise<{ terminalId: string }> {
    const terminals = context.services.tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY);
    if (terminals === undefined) {
      throw new SourceControlError("TERMINALS_UNAVAILABLE", "This node runs no terminals");
    }
    const { thread } = (await context.commands.execute("threads.get", { threadId })) as {
      thread: { projectId: string; worktreePath?: string };
    };
    const projects = (await context.commands.execute("projects.list", {})) as {
      id: string;
      path: string;
      scripts?: unknown[];
    }[];
    const project = projects.find((entry) => entry.id === thread.projectId);
    const script = (project?.scripts ?? [])
      .map((entry) => ProjectScript.safeParse(entry))
      .find((parsed) => parsed.success && parsed.data.id === scriptId)?.data;
    if (project === undefined || script === undefined) {
      throw new SourceControlError("SCRIPT_NOT_FOUND", `The project has no script ${scriptId}`, {
        threadId,
        scriptId,
      });
    }
    const cwd = thread.worktreePath ?? project.path;
    const realCwd = await realPath(cwd);
    const running = await Promise.all(
      terminals
        .list(threadId)
        .filter((entry) => entry.status === "running")
        .map(async (entry) => ({ entry, cwd: await realPath(entry.cwd) })),
    );
    // A terminal still running a program is left alone, as T3 opens another; so is one in
    // another folder (the thread moved), which would refuse this one. Two runs typed into one
    // idle shell before its program shows run one after the other, as the shell reads them.
    const terminalId = scriptTerminalId(script.id, (id) =>
      running.some(
        ({ entry, cwd: folder }) =>
          entry.terminalId === id && (entry.hasRunningSubprocess || folder !== realCwd),
      ),
    );
    await typeScript(terminals, {
      threadId,
      terminalId,
      cwd,
      command: script.command,
      projectRoot: project.path,
      worktreePath: thread.worktreePath,
    });
    return { terminalId };
  }

  context.commands.register({
    name: "git.worktree.setup.cancel",
    title: "Cancel worktree setup",
    description:
      "Stops the running setup of a thread's new worktree: its setup script's terminal is closed and the agent no longer waits for it. Before the agent started, the new worktree is removed (its branch stays) and the thread works in the project's checkout; its first turn then fails, or with workLocally starts there (T3's Work locally)",
    input: z.object({
      threadId: z.string().min(1),
      workLocally: z.boolean().optional().meta({
        description: "The first turn starts in the project's checkout instead of failing",
      }),
    }),
    output: z.object({ cancelled: z.boolean() }),
    permissions: ["git.write"],
    handler: async ({ threadId, workLocally }) => ({
      cancelled: await cancelSetup(threadId, workLocally === undefined ? {} : { workLocally }),
    }),
  });

  context.commands.register({
    name: "git.worktree.setup.retry",
    title: "Retry worktree setup",
    description:
      "T3's Retry of a thread whose first turn failed because its worktree could not be prepared (a setup script that held the agent failed, or the setup was cancelled): makes the worktree again from its branch when it is gone, runs the setup script again and sends the turn's message again",
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ turnId: z.string() }),
    permissions: ["git.write", "threads.write"],
    handler: async ({ threadId }) => retryPreparation(threadId),
  });

  context.commands.register({
    name: "git.worktree.remove",
    title: "Remove a worktree",
    description:
      "Removes a worktree of a project's repository that no thread works in (`force`: with its changes, and with checked-out submodules, which git removes only forced; `deleteBranch`: its branch too); one listed but gone from disk is pruned",
    input: z.object({
      projectId: z.string().min(1),
      path: z.string().min(1),
      force: z.boolean().optional(),
      deleteBranch: z.boolean().optional().meta({ description: "Delete its branch too" }),
    }),
    output: z.object({ removed: z.boolean() }),
    permissions: ["git.write"],
    handler: async ({ projectId, path, force, deleteBranch }) => {
      await service.removeWorktree(projectId, path, {
        ...(force === undefined ? {} : { force }),
        ...(deleteBranch === undefined ? {} : { deleteBranch }),
      });
      return { removed: true };
    },
  });

  context.commands.register({
    name: "git.worktree.list",
    description:
      "The worktrees of a project's repository with their branches, whether this node made them and the threads working in each",
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({
      worktrees: z.array(Worktree),
      cleanupOnDelete: z.boolean().optional().meta({
        description:
          "A deleted thread's worktree is removed by the cleanup rules (T3's worktreeOnDelete), so a client asks nothing",
      }),
    }),
    permissions: ["git.read"],
    handler: async ({ projectId }) => ({
      worktrees: await service.worktrees(projectId),
      cleanupOnDelete: cleanupRulesOf(projectId).onDelete,
    }),
  });

  context.commands.register({
    name: "git.worktree.cleanup",
    title: "Clean up worktrees",
    description:
      "Applies the worktree cleanup rules now (T3's storage cleanup of worktrees): removes the managed worktrees they allow, keeping branches and threads, and reports each one it looked at",
    input: z.object({}),
    output: CleanupReport,
    permissions: ["git.write"],
    // After a sweep already under way, so the answer reflects the rules as they are now.
    handler: async () => {
      // A sweep asked for meanwhile may start as the running one ends: wait for it too.
      while (cleaning !== undefined) await cleaning.catch(() => undefined);
      return requestCleanup();
    },
  });

  context.commands.register({
    name: "git.worktree.cleanup.report",
    title: "Last worktree cleanup",
    description:
      'The last worktree cleanup\'s report (T3\'s "Last run"), or null before the first; rulesOn says whether a rule of the node or a project is on, which "Delete now" needs',
    input: z.object({}),
    output: z.object({ report: CleanupReport.nullable(), rulesOn: z.boolean() }),
    permissions: ["git.read"],
    handler: async () => {
      const parsed = CleanupReport.safeParse(await kv.get(NAMESPACE, LAST_REPORT_KEY));
      return { report: parsed.success ? parsed.data : null, rulesOn: anyCleanupEnabled() };
    },
  });

  context.commands.register({
    name: "git.worktree.handoff",
    title: "Hand off thread to a git worktree",
    description:
      "Moves a thread into a new git worktree: creates the worktree branch (optionally from origin) from `baseRef` (the project's checked-out branch by default) and points the thread at it. A turn running now finishes where it started; the next one runs in the worktree. Fails if the thread is already attached to a worktree. The worktree is not removed automatically when the thread is deleted.",
    input: z.object({
      threadId: z.string().min(1),
      baseRef: z.string().min(1).optional(),
      ...WorktreeOptions,
    }),
    output: CreatedWorktree,
    permissions: ["git.write", "threads.write"],
    handler: ({ threadId, ...options }) => service.handoff(threadId, options),
  });

  context.commands.register({
    name: "git.init",
    title: "Initialize Git",
    description: "Makes a project that is no git repository one (`git init` in its folder)",
    input: z.object({ projectId: z.string().min(1) }),
    output: ProjectStatus,
    permissions: ["git.write"],
    handler: async ({ projectId }) => {
      const repo = await repoOf(projectId);
      if (repo.project.scratch === true) {
        throw new SourceControlError(
          "NOT_A_REPOSITORY",
          "Chats without a project have no repository",
          { projectId },
        );
      }
      return exclusive(projectId, async () => {
        const status = await statusOf(repo);
        if (!status.isRepo) {
          await createGit(config().gitPath, repo.project.path)(["init", "--quiet"]);
        }
        return refresh(repo);
      });
    },
  });

  context.commands.register({
    name: "git.pull",
    title: "Pull",
    description:
      "Pulls the checked-out branch of a project (or a thread's project) from its upstream, fast-forward only",
    input: Target,
    output: PullResult,
    permissions: ["git.write"],
    handler: async (input) => service.pull(await projectOf(input)),
  });

  context.services.provide(SOURCE_CONTROL_CAPABILITY, service);
  // What settling needs of a thread's pull requests (t3-parity.md D1171).
  context.services.provide<ThreadPullRequestStates>(PULL_REQUESTS_CAPABILITY, {
    async pullRequestsOf(threadId) {
      const linked = (await links.list(threadId)).map((link) => ({
        state: link.snapshot?.state ?? ("unknown" as const),
        linked: true,
      }));
      const thread = threads.get(threadId);
      const repo = thread === undefined ? undefined : repos.get(thread.projectId);
      // The default branch has no pull request of its own.
      if (
        thread?.branch == null ||
        repo === undefined ||
        thread.branch === repo.status?.defaultBranch
      ) {
        return linked;
      }
      const cached = repo.pullRequests.get(thread.branch);
      // Not looked up yet: whether it has one is not known.
      if (cached === undefined) return [...linked, { state: "unknown" as const, linked: false }];
      return cached.pr === null ? linked : [...linked, { state: cached.pr.state, linked: false }];
    },
  });
  return service;
}

export default definePlugin({
  activate(context) {
    activateSourceControl(context);
  },
});
