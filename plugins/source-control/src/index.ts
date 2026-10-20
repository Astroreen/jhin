import * as Path from "node:path";

import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import {
  Branch,
  Diff,
  DiffScope,
  ProjectStatus,
  PullRequest,
  SOURCE_CONTROL_CAPABILITY,
  SOURCE_CONTROL_STREAM,
  SourceControlEvents,
  StatusSnapshot,
  ThreadBranch,
  type PullRequestProvider,
  type SourceControl,
} from "@jhin/source-control-api";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
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
import { GitHubUnavailable, pullRequestFor, remoteHost } from "./github.ts";
import { watchTree, type TreeWatcher } from "./watch.ts";

export { parseNumstat, parseStatus } from "./git.ts";
export { remoteHost, rollupChecks } from "./github.ts";

export const CONFIG_SECTION = "jhin.source-control";
const NAMESPACE = "jhin.source-control";

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
      description: "Remote hosts whose pull requests are read with the GitHub CLI (gh)",
      advanced: true,
    }),
    gitPath: z
      .string()
      .default("git")
      .meta({ title: "git executable", description: "Path to git", advanced: true }),
    ghPath: z.string().default("gh").meta({
      title: "GitHub CLI executable",
      description: "Path to gh, the GitHub CLI",
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

/** One project followed by the plugin. */
interface Repo {
  project: ProjectRef;
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
  context.subscriptions.add(context.config.define(CONFIG_SECTION, Config));
  const config = () => context.config.get<Config>(CONFIG_SECTION);
  // Its events name repositories and branches: reading them takes git.read (security.md D415).
  const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
  if (live?.guard !== undefined) {
    context.subscriptions.add(live.guard(SOURCE_CONTROL_STREAM, ["git.read"]));
  }

  const repos = new Map<string, Repo>();
  const threads = new Map<string, ThreadBranch>();
  /** The last turn state seen per thread (`turnId:status`), so each change is handled once. */
  const lastTurns = new Map<string, string>();
  let stopped = false;
  let projectsLoaded: Promise<void> | undefined;
  /** Events of the `threads` index are handled one at a time, in order. */
  let indexChain: Promise<unknown> = Promise.resolve();
  let threadsLoaded: Promise<void> | undefined;

  const append = async (type: string, payload: unknown) => {
    if (stopped) return;
    await log.append(SOURCE_CONTROL_STREAM, [{ type, payload: payload as Json }]);
  };

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
    if (!threads.delete(threadId)) return;
    lastTurns.delete(threadId);
    await kv.delete(NAMESPACE, `thread/${threadId}`);
    await append(SourceControlEvents.threadRemoved, { threadId });
  };

  // --- Projects ------------------------------------------------------------------

  /** Reads the projects from `projects.list` once; until a threads plugin answers, again each time. */
  const loadProjects = () =>
    (projectsLoaded ??= (async () => {
      try {
        const projects = (await context.commands.execute("projects.list", {})) as ProjectRef[];
        for (const project of projects) track(project);
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
    const repo: Repo = {
      project: { id: project.id, path: project.path, scratch: project.scratch === true },
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
      unavailableAt: undefined,
      disposed: false,
    };
    repos.set(project.id, repo);
    repo.ready = refresh(repo);
    // A failed first read surfaces to whoever asks; nobody may be waiting now.
    repo.ready.catch((error: unknown) =>
      context.log.warn("reading a repository failed", {
        projectId: project.id,
        error: String(error),
      }),
    );
    return repo;
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
    if (repos.get(repo.project.id) === repo) repos.delete(repo.project.id);
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
    const { gitPath, githubHosts } = config();
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
    const host = remoteUrl === null ? undefined : remoteHost(remoteUrl);
    const github =
      host !== undefined && githubHosts.map((item) => item.toLowerCase()).includes(host);
    if (!github) repo.provider = null;
    else repo.provider ??= { kind: "github", available: true };
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
    if (!sameStatus(previous, status)) await append(SourceControlEvents.statusChanged, status);
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

  /** Looks up the pull requests of the branches of interest whose answer is missing or stale. */
  const lookUpPullRequests = (repo: Repo, options: { force: boolean }): Promise<void> => {
    const next = repo.prChain.then(async () => {
      const status = repo.status;
      if (status === undefined || repo.disposed || repo.provider === null) return;
      const location = repo.location;
      if (location?.isRepo !== true) return;
      const { ghPath, pullRequestRefreshSeconds } = config();
      const ttl = pullRequestRefreshSeconds * 1000;
      // Missing, signed out or failing: asked again once per refresh period, not on every
      // change in between (with a period of 0, only when asked).
      if (repo.provider.available === false && !options.force) {
        const since = Date.now() - (repo.unavailableAt ?? 0);
        if (ttl === 0 || since < ttl) return;
      }
      let provider: PullRequestProvider = { kind: "github", available: true };
      for (const branch of branchesOfInterest(repo, status)) {
        const cached = repo.pullRequests.get(branch);
        const stale =
          cached === undefined || (ttl > 0 && Date.now() - cached.at >= ttl) || options.force;
        if (!stale) continue;
        try {
          const pr = await pullRequestFor(ghPath, location.root, branch);
          repo.pullRequests.set(branch, { pr, at: Date.now() });
        } catch (error) {
          if (!(error instanceof GitHubUnavailable)) throw error;
          provider = { kind: "github", available: false, reason: error.message };
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
    const repo = repos.get(projectId) ?? (await repoOf(projectId).catch(() => undefined));
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
          await recordThread(id, payload.projectId);
        }
        return;
      }
      case ThreadEvents.threadUpdated: {
        const projectId = payload?.projectId;
        const lastTurn = payload?.lastTurn as { turnId?: string; status?: string } | undefined;
        if (typeof projectId !== "string" || lastTurn?.status === undefined) return;
        const key = `${lastTurn.turnId}:${lastTurn.status}`;
        if (lastTurns.get(id) === key) return;
        lastTurns.set(id, key);
        // A turn runs on what is checked out when it starts; what it changed shows when it ends.
        if (lastTurn.status !== "waiting") await recordThread(id, projectId);
        return;
      }
      case ThreadEvents.threadDeleted:
        await removeThread(id);
        return;
    }
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
  const schedulePullRequests = () => {
    if (prTimer !== undefined) clearInterval(prTimer);
    prTimer = undefined;
    const seconds = config().pullRequestRefreshSeconds;
    if (seconds === 0) return;
    prTimer = setInterval(() => {
      for (const repo of repos.values()) {
        if (repo.provider !== null) void lookUpPullRequests(repo, { force: false });
      }
    }, seconds * 1000);
    prTimer.unref?.();
  };
  schedulePullRequests();
  context.subscriptions.add(
    context.config.onDidChange(CONFIG_SECTION, () => {
      schedulePullRequests();
      for (const repo of repos.values()) {
        if (config().watch) startWatching(repo);
        else stopWatching(repo);
      }
    }),
  );
  context.subscriptions.add({
    dispose() {
      stopped = true;
      if (prTimer !== undefined) clearInterval(prTimer);
      for (const repo of repos.values()) untrack(repo);
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
      const repo = await repoOf(projectId);
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
    branches: async (projectId) => {
      const repo = await repoOf(projectId);
      const status = await statusOf(repo);
      const { git } = await gitOf(repo);
      return readBranches(git, status.defaultBranch);
    },
    checkout: async (projectId, branch, options = {}) => {
      const repo = await repoOf(projectId);
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
      const { git } = await gitOf(repo);
      const remotes = (await git(["remote"])).stdout.split("\n").filter((line) => line !== "");
      await checkout(git, branch, { create: options.create === true, remotes });
      const status = await refresh(repo);
      if (options.threadId !== undefined) {
        await setThreadBranch(options.threadId, projectId, status.branch);
      }
      return status;
    },
    threadBranch: async (threadId) => {
      await loadThreads();
      return threads.get(threadId);
    },
  };

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
      // The head first: a change made while the statuses are read is also delivered after it.
      const head = await log.head(SOURCE_CONTROL_STREAM);
      await Promise.all([loadProjects(), loadThreads()]);
      const chosen = projectId === undefined ? [...repos.values()] : [await repoOf(projectId)];
      const projects = await Promise.all(chosen.map((repo) => listedStatus(repo, reread === true)));
      return {
        head,
        projects,
        threads: [...threads.values()].filter(
          (thread) => projectId === undefined || thread.projectId === projectId,
        ),
      };
    },
  });

  context.commands.register({
    name: "git.thread.status",
    description:
      "A thread's branch, whether it is checked out, its pull request and its project's git status",
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
      const status = await service.status(projectId, { refresh: reread === true });
      const thread = (await service.threadBranch(threadId)) ?? null;
      const branch = thread?.branch ?? null;
      return {
        thread,
        checkedOut: branch !== null && branch === status.branch,
        pullRequest: branch === null ? null : (status.pullRequests[branch] ?? null),
        status,
      };
    },
  });

  context.commands.register({
    name: "git.diff",
    description:
      "The diff of a project (or a thread's project): uncommitted changes against HEAD, or the branch's changes against its base; untracked files count as added",
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
      })
      .refine((input) => (input.projectId === undefined) !== (input.threadId === undefined), {
        message: "Name a projectId or a threadId",
      }),
    output: Diff,
    permissions: ["git.read"],
    handler: async (input) =>
      service.diff(await projectOf(input), {
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.base === undefined ? {} : { base: input.base }),
        ...(input.ignoreWhitespace === undefined
          ? {}
          : { ignoreWhitespace: input.ignoreWhitespace }),
      }),
  });

  context.commands.register({
    name: "git.branches",
    description:
      "Local and remote branches of a project (or a thread's project), the current one first",
    input: Target,
    output: z.object({ branches: z.array(Branch) }),
    permissions: ["git.read"],
    handler: async (input) => ({ branches: await service.branches(await projectOf(input)) }),
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

  context.services.provide(SOURCE_CONTROL_CAPABILITY, service);
  return service;
}

export default definePlugin({
  activate(context) {
    activateSourceControl(context);
  },
});
