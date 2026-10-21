import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
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
import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import {
  Branch,
  Diff,
  DiffScope,
  GIT_ACTION_PROGRESS,
  GitActionOptions,
  GitActionResult,
  ProjectStatus,
  PullRequest,
  PullResult,
  SOURCE_CONTROL_ACTIONS_STREAM,
  SOURCE_CONTROL_CAPABILITY,
  SOURCE_CONTROL_STREAM,
  SourceControlEvents,
  StatusSnapshot,
  CreatedWorktree,
  ThreadBranch,
  ThreadPullRequest,
  pullRequestChains,
  type GitActionProgress,
  TurnCheckpoint,
  Worktree,
  type PullRequestProvider,
  type SourceControl,
} from "@jhin/source-control-api";
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
import { FORGE_KINDS, ForgeUnavailable, forgeKindOf, type Forge, type ForgeKind } from "./forge.ts";
import { azureForge, bitbucketForge, forgejoForge, gitlabForge, siteOf } from "./forges.ts";
import { githubForge, remoteHost } from "./github.ts";
import type { Viewers } from "./github.ts";
import { createLinks, type LinkTarget } from "./links.ts";
import { createWatcher } from "./watcher.ts";
import { followTurns } from "./turns.ts";
import {
  createWorktree,
  isManagedWorktree,
  isTemporaryBranch,
  listWorktrees,
  recreateWorktree,
  removeWorktree,
  renameTemporaryBranch,
  worktreesRoot,
} from "./worktrees.ts";
import { watchTree, type TreeWatcher } from "./watch.ts";
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
  (error as { code?: unknown }).code === "COMMAND_NOT_FOUND";

export function activateSourceControl(context: PluginContext): SourceControl {
  const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
  const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
  const hostPaths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
  context.subscriptions.add(context.config.define(CONFIG_SECTION, Config));
  // D501: members relay the stream to their clients (D503).
  const mesh = context.services.tryGet<MeshStreams>(MESH_STREAMS_CAPABILITY);
  if (mesh !== undefined) context.subscriptions.add(mesh.share(SOURCE_CONTROL_STREAM));
  const config = () => context.config.get<Config>(CONFIG_SECTION);
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
    append,
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

  const removeThread = async (threadId: string) => {
    await loadThreads();
    await links.remove(threadId);
    await turns.remove(threadId);
    if (!threads.delete(threadId)) return;
    lastTurns.delete(threadId);
    await kv.delete(NAMESPACE, `thread/${threadId}`);
    await append(SourceControlEvents.threadRemoved, { threadId });
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
        const listed = (await context.commands.execute("threads.list", {})) as Record<
          string,
          unknown
        >[];
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
    else if (repo.provider?.kind !== kind) repo.provider = { kind, available: true };
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
  const settleOnPullRequest = (repo: Repo, branch: string, pr: PullRequest) => {
    // The time it merged or closed, never its last update (a later comment moves that);
    // without one there is nothing to weigh against the user's last message.
    const closedAt = (pr.state === "merged" ? pr.mergedAt : undefined) ?? pr.closedAt;
    if (closedAt === undefined) return;
    for (const thread of threads.values()) {
      if (thread.projectId !== repo.project.id || thread.branch !== branch) continue;
      const key = JSON.stringify([repo.project.id, thread.threadId, pr.number, pr.state, closedAt]);
      if (announced.has(key)) continue;
      announced.add(key);
      context.commands
        .execute("threads.auto-settle", {
          threadId: thread.threadId,
          reason: pr.state === "merged" ? "pull-request-merged" : "pull-request-closed",
          closedAt,
        })
        .then(
          // Not settled now (the rule off, a pin): asked again next lookup, the rule may allow it.
          (result) => {
            if ((result as { settled?: boolean }).settled !== true) announced.delete(key);
          },
          (error: unknown) => {
            announced.delete(key);
            context.log.warn("settling a thread on its pull request failed", {
              threadId: thread.threadId,
              pullRequest: pr.number,
              error: String(error),
            });
          },
        );
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
      let provider: PullRequestProvider = { kind: forge.kind, available: true };
      for (const branch of branchesOfInterest(repo, status)) {
        const cached = repo.pullRequests.get(branch);
        const stale =
          cached === undefined || (ttl > 0 && Date.now() - cached.at >= ttl) || options.force;
        if (!stale) continue;
        try {
          const pr = await forge.find(await headContextOf(repo.git!, branch));
          repo.pullRequests.set(branch, { pr, at: Date.now() });
          if (pr !== null && pr.state !== "open") settleOnPullRequest(repo, branch, pr);
        } catch (error) {
          if (!(error instanceof ForgeUnavailable)) throw error;
          provider = { kind: forge.kind, available: false, reason: error.message };
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

  const gitOf = async (repo: Repo): Promise<{ git: Git; root: string }> => {
    const status = await statusOf(repo);
    const location = repo.location;
    if (!status.isRepo || location?.isRepo !== true || repo.git === undefined) {
      throw new SourceControlError(
        "NOT_A_REPOSITORY",
        status.reason ?? "The project is not a git repository",
        { projectId: repo.project.id },
      );
    }
    return { git: repo.git, root: location.root };
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
      case ThreadEvents.threadDeleted:
        threadDirs.delete(id);
        await syncWorktrees();
        await removeThread(id);
        return;
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
        for (const id of await links.threads()) await links.sync(id);
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
  context.subscriptions.add(
    context.config.onDidChange(CONFIG_SECTION, () => {
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
    checkpoints: (threadId) => turns.list(threadId),
    // Worktrees are made, attached and removed one at a time per project.
    createWorktree: (projectId, options) =>
      exclusive(projectId, () => createWorktreeNow(projectId, options)),
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
  async function worktreeUsers(): Promise<Map<string, string[]>> {
    const listed = (await context.commands.execute("threads.list", {}).catch(() => [])) as {
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
    const repo = await repoOf(projectId);
    const { git, root } = await gitOf(repo);
    return createWorktree(git, {
      repository: root,
      root: worktreesRoot(config().worktreesDirectory, hostPaths.home),
      baseRef: options.baseRef,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.startFromOrigin === undefined
        ? {}
        : { startFromOrigin: options.startFromOrigin }),
    });
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
    if (kind === "azure-devops") return azureForge(tool("azPath"), site);
    if (kind === "gitlab") return gitlabForge(tool("glabPath"), site);
    if (kind === "bitbucket") return bitbucketForge(site);
    return forgejoForge(tool("teaPath"), site);
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
          await recreateWorktree(git, worktree, branch);
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
    if (!isTemporaryBranch(branch)) return;
    // The thread's own first turn only: a fork's first one follows its parent's.
    const events = (await context.commands.execute("threads.events", {
      threadId: input.threadId,
      limit: 1000,
    })) as StoredEvent[];
    const first = events.find((event) => event.type === ThreadEvents.turnStarted)?.payload as
      | { turnId?: string; input?: { text?: string } }
      | undefined;
    const text = first?.input?.text?.trim();
    if (first?.turnId !== input.turnId || !text) return;
    const fragment = await writerFor(input.projectId, input.threadId).branchName({
      message: text,
    });
    if (fragment === undefined) return;
    const renamed = await renameTemporaryBranch(git, branch, fragment);
    context.log.info("renamed a worktree's temporary branch", {
      threadId: input.threadId,
      from: branch,
      to: renamed,
    });
    // Every thread working in that worktree follows the new name.
    for (const [threadId, dir] of threadDirs) {
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

  // --- Commands ---------------------------------------------------------------------------

  const Target = z
    .object({
      projectId: z.string().min(1).optional(),
      threadId: z.string().min(1).optional(),
    })
    .refine((input) => (input.projectId === undefined) !== (input.threadId === undefined), {
      message: "Name a projectId or a threadId",
    });
  const projectOf = async (input: {
    projectId?: string | undefined;
    threadId?: string | undefined;
  }) => input.projectId ?? (await threadProject(input.threadId!));

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

  context.commands.register({
    name: "git.diff",
    description:
      "The diff of a project (or a thread's project): uncommitted changes against HEAD, the branch's changes against its base (untracked files count as added), or what a thread's turn changed (`turn` scope: between its checkpoints)",
    input: z
      .object({
        projectId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional(),
        scope: DiffScope.optional(),
        base: z.string().min(1).optional().meta({
          description:
            "For the branch scope: the branch to compare with (the default branch otherwise)",
        }),
        ignoreWhitespace: z.boolean().optional(),
        turn: z.number().int().positive().optional().meta({
          description:
            "For the turn scope: the thread's turn count after the turn (1 is its first)",
        }),
        fromTurn: z.number().int().nonnegative().optional().meta({
          description:
            "For the turn scope: the turn count to compare from (the turn before by default; 0 is before the first turn)",
        }),
      })
      .refine((input) => (input.projectId === undefined) !== (input.threadId === undefined), {
        message: "Name a projectId or a threadId",
      })
      .refine(
        (input) =>
          input.scope !== "turn" || (input.threadId !== undefined && input.turn !== undefined),
        { message: "The turn scope takes a threadId and a turn" },
      ),
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
    name: "git.checkpoints",
    description:
      "A thread's checkpoints, oldest first: for each turn that completed or was stopped, its turn count, status and the files it changed",
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ checkpoints: z.array(TurnCheckpoint) }),
    permissions: ["git.read"],
    handler: async ({ threadId }) => ({ checkpoints: await service.checkpoints(threadId) }),
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
      // Only a forge whose pull requests a watch can read is watched (GitHub, D279).
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
    }),
    output: CreatedWorktree,
    permissions: ["git.write"],
    handler: ({ projectId, ...options }) => service.createWorktree(projectId, options),
  });

  context.commands.register({
    name: "git.worktree.remove",
    title: "Remove a worktree",
    description:
      "Removes a worktree of a project's repository that no thread works in (`force`: with its changes; `deleteBranch`: its branch too); one listed but gone from disk is pruned",
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
    output: z.object({ worktrees: z.array(Worktree) }),
    permissions: ["git.read"],
    handler: async ({ projectId }) => ({ worktrees: await service.worktrees(projectId) }),
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
  return service;
}

export default definePlugin({
  activate(context) {
    activateSourceControl(context);
  },
});
