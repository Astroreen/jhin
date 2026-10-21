import {
  targetKey,
  type Connections,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";
import {
  SOURCE_CONTROL_STREAM,
  SourceControlEvents,
  type ProjectStatus,
  type StatusSnapshot,
  type ThreadBranch,
  type ThreadPullRequest,
  type TurnCheckpoint,
} from "@jhin/source-control-api";

/** What a client knows of one node's repositories and threads' branches. */
export interface SourceControlView {
  /**
   * `unavailable`: the node has no source control plugin (`git.status` is
   * not a command there), so nothing shows.
   */
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly error?: string;
  readonly projects: ReadonlyMap<string, ProjectStatus>;
  readonly threads: ReadonlyMap<string, ThreadBranch>;
  /** The pull requests linked to each thread that has any (D267). */
  readonly links: ReadonlyMap<string, readonly ThreadPullRequest[]>;
  /** Each thread's latest checkpoint (D245); none from a node before 1.1. */
  readonly checkpoints: ReadonlyMap<string, TurnCheckpoint>;
}

const LOADING: SourceControlView = {
  status: "loading",
  projects: new Map(),
  threads: new Map(),
  links: new Map(),
  checkpoints: new Map(),
};

const withLinks = (
  view: SourceControlView,
  threadId: string,
  change: (list: readonly ThreadPullRequest[]) => readonly ThreadPullRequest[],
): SourceControlView => {
  const links = new Map(view.links);
  const next = change(links.get(threadId) ?? []);
  if (next.length === 0) links.delete(threadId);
  else links.set(threadId, next);
  return { ...view, links };
};

/** Applies one event of a node's `source-control` stream to a view. */
export function applySourceControlEvent(
  view: SourceControlView,
  event: { type: string; payload: unknown },
): SourceControlView {
  const payload = event.payload as Record<string, unknown> | null;
  switch (event.type) {
    case SourceControlEvents.statusChanged: {
      const status = payload as unknown as ProjectStatus;
      if (typeof status?.projectId !== "string") return view;
      return { ...view, projects: new Map(view.projects).set(status.projectId, status) };
    }
    case SourceControlEvents.projectRemoved: {
      const projects = new Map(view.projects);
      projects.delete(String(payload?.["projectId"]));
      return { ...view, projects };
    }
    case SourceControlEvents.threadChanged: {
      const thread = payload as unknown as ThreadBranch;
      if (typeof thread?.threadId !== "string") return view;
      return { ...view, threads: new Map(view.threads).set(thread.threadId, thread) };
    }
    case SourceControlEvents.threadRemoved: {
      const threads = new Map(view.threads);
      const checkpoints = new Map(view.checkpoints);
      threads.delete(String(payload?.["threadId"]));
      checkpoints.delete(String(payload?.["threadId"]));
      const links = new Map(view.links);
      links.delete(String(payload?.["threadId"]));
      return { ...view, threads, links, checkpoints };
    }
    case SourceControlEvents.pullRequestLinked:
    case SourceControlEvents.pullRequestUpdated: {
      const threadId = payload?.["threadId"];
      const link = payload?.["pullRequest"] as ThreadPullRequest | undefined;
      if (typeof threadId !== "string" || typeof link?.key !== "string") return view;
      return withLinks(view, threadId, (list) =>
        list.some((item) => item.key === link.key)
          ? list.map((item) => (item.key === link.key ? link : item))
          : [...list, link],
      );
    }
    case SourceControlEvents.pullRequestUnlinked: {
      const threadId = payload?.["threadId"];
      const key = payload?.["key"];
      if (typeof threadId !== "string" || typeof key !== "string") return view;
      return withLinks(view, threadId, (list) => list.filter((item) => item.key !== key));
    }
    case SourceControlEvents.checkpointChanged: {
      const checkpoint = payload as unknown as TurnCheckpoint;
      if (typeof checkpoint?.threadId !== "string") return view;
      // The latest one stays: a change to an earlier turn (one reverted past) is not it.
      const known = view.checkpoints.get(checkpoint.threadId);
      if (known !== undefined && known.turn > checkpoint.turn) return view;
      return {
        ...view,
        checkpoints: new Map(view.checkpoints).set(checkpoint.threadId, checkpoint),
      };
    }
    default:
      return view;
  }
}

function viewOf(snapshot: StatusSnapshot): SourceControlView {
  return {
    status: "ready",
    projects: new Map(snapshot.projects.map((project) => [project.projectId, project])),
    threads: new Map(snapshot.threads.map((thread) => [thread.threadId, thread])),
    links: new Map((snapshot.links ?? []).map((entry) => [entry.threadId, entry.pullRequests])),
    checkpoints: new Map(
      (snapshot.checkpoints ?? []).map((checkpoint) => [checkpoint.threadId, checkpoint]),
    ),
  };
}

export interface SourceControlStore {
  view(target: NodeTarget): SourceControlView;
  /** Follows the target while subscribed; `listener` fires whenever its view changes. */
  subscribe(target: NodeTarget, listener: () => void): Disposable;
  /** Reads a project again on its node (git and pull requests) and applies the answer. */
  refresh(target: NodeTarget, projectId: string): Promise<void>;
}

interface Feed {
  readonly target: NodeTarget;
  readonly listeners: Set<() => void>;
  view: SourceControlView;
  client: RpcClient | undefined;
  stop: (() => void) | undefined;
  /** Bumped on every (re)start, so answers of an older start are dropped. */
  generation: number;
  /** Starts over since the last load that worked: the first is immediate, later ones back off. */
  retries: number;
}

/** The longest wait before a feed that keeps failing starts over. */
const MAX_RETRY_MS = 30_000;

/**
 * The source control of every node a view looks at: `git.status`, then the
 * node's `source-control` stream after the head it reflects. A mesh member
 * reached through a connection shares no such stream (only threads are
 * mirrored, D26), so its view is read again whenever its thread catalog
 * changes: a turn that ends, a thread created.
 */
export function createSourceControlStore(
  connections: Connections,
  threads: ThreadsCatalog,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): SourceControlStore & Disposable {
  const feeds = new Map<string, Feed>();

  const set = (feed: Feed, view: SourceControlView) => {
    if (view === feed.view) return;
    feed.view = view;
    for (const listener of Array.from(feed.listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("a source control listener failed", { error: String(error) });
      }
    }
  };

  const fail = (feed: Feed, error: unknown) => {
    const code = (error as { code?: unknown }).code;
    if (code === "COMMAND_NOT_FOUND") set(feed, { ...LOADING, status: "unavailable" });
    else set(feed, { ...feed.view, status: "error", error: (error as Error).message });
  };

  const start = (feed: Feed, client: RpcClient): (() => void) => {
    const generation = ++feed.generation;
    const current = () => feed.generation === generation;
    let subscription: Disposable | undefined;
    let catalog: Disposable | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const snapshot = await threads.call<StatusSnapshot>(feed.target, "git.status");
      if (current()) {
        feed.retries = 0;
        set(feed, viewOf(snapshot));
      }
      return snapshot;
    };
    /**
     * A refused subscription or a failed load: shown, then the feed starts
     * over (`git.status`, then the stream after its head), at once the first
     * time and backing off while it keeps failing. A node without the plugin
     * is not asked again.
     */
    const failed = (error: unknown) => {
      if (!current()) return;
      fail(feed, error);
      if ((error as { code?: unknown }).code === "COMMAND_NOT_FOUND") return;
      const again = () => {
        if (!current() || feed.client !== client) return;
        feed.stop?.();
        feed.stop = start(feed, client);
      };
      const attempt = feed.retries++;
      if (attempt === 0) queueMicrotask(again);
      else retry = setTimeout(again, Math.min(MAX_RETRY_MS, 1000 * 2 ** (attempt - 1)));
    };
    /** `git.status` again, then the stream after its head; the view stays meanwhile. */
    const restart = () =>
      queueMicrotask(() => {
        if (!current() || feed.client !== client) return;
        feed.stop?.();
        feed.stop = start(feed, client);
      });
    if (feed.target.remote === undefined) {
      void load()
        .then((snapshot) => {
          if (!current()) return;
          let last = snapshot.head;
          /** A gap was seen: nothing more is applied until the feed has started over. */
          let restarting = false;
          subscription = client.subscribe(
            SOURCE_CONTROL_STREAM,
            { after: snapshot.head, onError: failed },
            (event) => {
              if (!current() || restarting) return;
              // A gap: the stream was trimmed past where it resumed (D498). Start over, once.
              if (event.sequence > last + 1) {
                restarting = true;
                restart();
                return;
              }
              last = event.sequence;
              set(feed, applySourceControlEvent(feed.view, event));
            },
          );
        })
        .catch(failed);
    } else {
      // Read again on every change of the member's catalog; one read at a time, the last wins.
      let running = false;
      let again = false;
      const reload = () => {
        if (running) {
          again = true;
          return;
        }
        running = true;
        void load()
          .catch((error: unknown) => current() && fail(feed, error))
          .finally(() => {
            running = false;
            if (again && current()) {
              again = false;
              reload();
            }
          });
      };
      reload();
      let last = threads.catalog(feed.target);
      catalog = threads.subscribe(feed.target, () => {
        const next = threads.catalog(feed.target);
        if (next === last) return;
        last = next;
        reload();
      });
    }
    return () => {
      feed.generation += 1;
      if (retry !== undefined) clearTimeout(retry);
      subscription?.dispose();
      catalog?.dispose();
    };
  };

  /** (Re)starts a feed when its connection opens or changes; a stopped feed keeps its view. */
  const sync = (feed: Feed) => {
    const node = connections.get(feed.target.node);
    const client = node?.state === "open" ? node.client : undefined;
    if (client === feed.client) return;
    feed.stop?.();
    feed.stop = undefined;
    feed.client = client;
    if (client !== undefined) feed.stop = start(feed, client);
  };

  const following = connections.subscribe(() => {
    for (const feed of feeds.values()) sync(feed);
  });

  return {
    view: (target) => feeds.get(targetKey(target))?.view ?? LOADING,
    subscribe(target, listener) {
      const key = targetKey(target);
      let feed = feeds.get(key);
      if (feed === undefined) {
        feed = {
          target: {
            node: target.node,
            ...(target.remote === undefined ? {} : { remote: target.remote }),
          },
          listeners: new Set(),
          view: LOADING,
          client: undefined,
          stop: undefined,
          generation: 0,
          retries: 0,
        };
        feeds.set(key, feed);
        sync(feed);
      }
      const owned = feed;
      const entry = () => listener();
      owned.listeners.add(entry);
      return toDisposable(() => {
        owned.listeners.delete(entry);
        // A subscriber back within the same tick (a re-render) keeps the feed: no refetch.
        queueMicrotask(() => {
          if (owned.listeners.size > 0 || feeds.get(key) !== owned) return;
          owned.stop?.();
          feeds.delete(key);
        });
      });
    },
    async refresh(target, projectId) {
      const snapshot = await threads.call<StatusSnapshot>(target, "git.status", {
        projectId,
        refresh: true,
      });
      const feed = feeds.get(targetKey(target));
      const status = snapshot.projects[0];
      if (feed === undefined || status === undefined) return;
      set(feed, { ...feed.view, projects: new Map(feed.view.projects).set(projectId, status) });
    },
    dispose() {
      following.dispose();
      for (const feed of feeds.values()) feed.stop?.();
      feeds.clear();
    },
  };
}
