import {
  ORCHESTRATION_STREAM,
  OrchestrationEvents,
  applyWorkflowPatch,
  type WorkflowPatch,
} from "@jhin/agent-api";
import {
  targetKey,
  type Connections,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";

export type TaskStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

/** A delegated task as the `orchestration` stream carries it: the fields the chat shows. */
export interface TaskRecord {
  readonly taskId: string;
  readonly parentThreadId: string;
  readonly childThreadId: string;
  /** The mesh node the child runs on, when it is not the parent's (D1507). */
  readonly node?: string;
  readonly title: string;
  readonly agentId: string;
  readonly model?: string;
  readonly status: TaskStatus;
  readonly summary?: string;
  readonly workflowId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
}

export interface WorkflowRecord {
  readonly workflowId: string;
  readonly parentThreadId: string;
  readonly name: string;
  readonly description: string;
  readonly phases: readonly { readonly title: string; readonly detail?: string }[];
  readonly status: "running" | "completed" | "failed" | "stopped";
  readonly agents: readonly {
    readonly index: number;
    readonly taskId?: string;
    readonly childThreadId?: string;
    readonly label?: string;
    readonly phase?: string;
    readonly status: TaskStatus | "starting";
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
}

/** What a client knows of one thread's delegated work. */
export interface DelegationView {
  /** `unavailable`: the node has no orchestration plugin. */
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly tasks: ReadonlyMap<string, TaskRecord>;
  readonly workflows: ReadonlyMap<string, WorkflowRecord>;
}

const LOADING: DelegationView = { status: "loading", tasks: new Map(), workflows: new Map() };

/** A record replaces the one known only when it is not older: a snapshot and the stream overlap. */
function put<R extends { updatedAt: string }>(
  records: ReadonlyMap<string, R>,
  id: string,
  record: R,
): ReadonlyMap<string, R> {
  const known = records.get(id);
  if (known !== undefined && known.updatedAt > record.updatedAt) return records;
  return new Map(records).set(id, record);
}

/** Applies one event of the `orchestration` stream to a thread's view. */
export function applyOrchestrationEvent(
  view: DelegationView,
  threadId: string,
  event: { type: string; payload: unknown },
): DelegationView {
  const record = event.payload as { parentThreadId?: unknown } | null;
  if (record?.parentThreadId !== threadId) return view;
  if (event.type === OrchestrationEvents.taskUpdated) {
    const task = record as TaskRecord;
    const tasks = put(view.tasks, task.taskId, task);
    return tasks === view.tasks ? view : { ...view, tasks };
  }
  if (event.type === OrchestrationEvents.workflowUpdated) {
    const workflow = record as WorkflowRecord;
    const workflows = put(view.workflows, workflow.workflowId, workflow);
    return workflows === view.workflows ? view : { ...view, workflows };
  }
  if (event.type === OrchestrationEvents.workflowPatched) {
    // A patch of a run this view has not read yet is nothing to fold into (D1504).
    const patch = record as WorkflowPatch;
    const known = view.workflows.get(patch.workflowId);
    if (known === undefined) return view;
    const workflows = put(view.workflows, patch.workflowId, applyWorkflowPatch(known, patch));
    return workflows === view.workflows ? view : { ...view, workflows };
  }
  if (event.type === OrchestrationEvents.taskRemoved) {
    const { taskId } = record as { taskId: string };
    if (!view.tasks.has(taskId)) return view;
    const tasks = new Map(view.tasks);
    tasks.delete(taskId);
    return { ...view, tasks };
  }
  if (event.type === OrchestrationEvents.workflowRemoved) {
    const { workflowId } = record as { workflowId: string };
    if (!view.workflows.has(workflowId)) return view;
    const workflows = new Map(view.workflows);
    workflows.delete(workflowId);
    return { ...view, workflows };
  }
  return view;
}

/** What `orchestration.thread` answers (D863). */
interface ThreadSnapshot {
  readonly tasks: readonly TaskRecord[];
  readonly workflows: readonly WorkflowRecord[];
  readonly head: number;
}

function snapshotView(view: DelegationView, threadId: string, snapshot: ThreadSnapshot) {
  let next: DelegationView = { ...view, status: "ready" };
  for (const task of snapshot.tasks) {
    next = applyOrchestrationEvent(next, threadId, {
      type: OrchestrationEvents.taskUpdated,
      payload: task,
    });
  }
  for (const workflow of snapshot.workflows) {
    next = applyOrchestrationEvent(next, threadId, {
      type: OrchestrationEvents.workflowUpdated,
      payload: workflow,
    });
  }
  return next;
}

export interface DelegationStore {
  /** The view of a thread; the same object until it changes. */
  view(target: NodeTarget, threadId: string): DelegationView;
  /** `subscribe` as `useSyncExternalStore` takes it: the same function for a thread every time. */
  watch(target: NodeTarget, threadId: string): (listener: () => void) => () => void;
}

interface Feed {
  readonly target: NodeTarget;
  readonly threadId: string;
  readonly listeners: Set<() => void>;
  view: DelegationView;
  client: RpcClient | undefined;
  stop: (() => void) | undefined;
  /** Starts over since the feed last read or heard anything: later ones back off. */
  retries: number;
}

/** The longest wait before a feed that keeps failing starts over. */
const MAX_RETRY_MS = 30_000;

/**
 * The delegated work of every thread somebody looks at (D864):
 * `orchestration.thread`, then the node's `orchestration` stream after the
 * head it reflects. A thread on a mesh member is read again whenever the
 * member's threads change.
 */
export function createDelegationStore(
  connections: Connections,
  threads: Pick<ThreadsCatalog, "call" | "subscribe">,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  /** Runs `run` after `ms`; returns a cancel. Tests run it themselves. */
  delay: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
): DelegationStore & Disposable {
  const feeds = new Map<string, Feed>();
  const watchers = new Map<string, (listener: () => void) => () => void>();

  const set = (feed: Feed, view: DelegationView) => {
    if (view === feed.view) return;
    feed.view = view;
    for (const listener of Array.from(feed.listeners)) listener();
  };

  const start = (feed: Feed, client: RpcClient): (() => void) => {
    let stopped = false;
    let subscription: Disposable | undefined;
    let cancelRetry: (() => void) | undefined;
    /** A failed read or a broken stream: shown, then the feed starts over, backing off. */
    let failedOnce = false;
    const failed = (error: unknown) => {
      // One start fails once: a read and its stream never both schedule a restart.
      if (stopped || failedOnce) return;
      failedOnce = true;
      if ((error as { code?: unknown } | null)?.code === "COMMAND_NOT_FOUND") {
        set(feed, { ...LOADING, status: "unavailable" });
        return;
      }
      log.warn("could not follow a thread's delegated work", { error: String(error) });
      set(feed, { ...feed.view, status: "error" });
      const ms = Math.min(MAX_RETRY_MS, 1000 * 2 ** feed.retries++);
      cancelRetry = delay(() => {
        if (stopped || feed.client !== client) return;
        feed.stop?.();
        feed.stop = start(feed, client);
      }, ms);
    };
    const remote = feed.target.remote !== undefined;
    const read = () =>
      remote
        ? threads.call<ThreadSnapshot>(feed.target, "orchestration.thread", {
            threadId: feed.threadId,
          })
        : client.call<ThreadSnapshot>("orchestration.thread", { threadId: feed.threadId });
    let memberThreads: Disposable | undefined;
    /**
     * A mesh member's `orchestration` stream is not mirrored here, but its
     * threads are: whenever one of them changes (a child's turn ended), the
     * records are read again, one read at a time.
     */
    let reading = false;
    let readAgain = false;
    const reread = () => {
      if (stopped) return;
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      void read()
        .then((snapshot) => {
          if (!stopped) set(feed, snapshotView(feed.view, feed.threadId, snapshot));
        })
        .catch(failed)
        .finally(() => {
          reading = false;
          if (readAgain) {
            readAgain = false;
            reread();
          }
        });
    };
    void read()
      .then((snapshot) => {
        if (stopped) return;
        set(feed, snapshotView(feed.view, feed.threadId, snapshot));
        if (remote) {
          // A member is only read: an answer proves the feed works.
          feed.retries = 0;
          memberThreads = threads.subscribe(feed.target, reread);
          return;
        }
        subscription = client.subscribe(
          ORCHESTRATION_STREAM,
          { after: snapshot.head, onError: failed },
          (event) => {
            if (stopped) return;
            // Only an event proves the stream works: a read that answers does not, so a stream
            // refused right after it keeps backing off.
            feed.retries = 0;
            set(feed, applyOrchestrationEvent(feed.view, feed.threadId, event));
          },
        );
      })
      .catch(failed);
    return () => {
      stopped = true;
      cancelRetry?.();
      subscription?.dispose();
      memberThreads?.dispose();
    };
  };

  const sync = (feed: Feed) => {
    const node = connections.get(feed.target.node);
    const client = node?.state === "open" ? node.client : undefined;
    if (client === feed.client) return;
    feed.stop?.();
    feed.stop = undefined;
    feed.client = client;
    feed.retries = 0;
    if (client !== undefined) feed.stop = start(feed, client);
  };

  const following = connections.subscribe(() => {
    for (const feed of feeds.values()) sync(feed);
  });

  const subscribe = (target: NodeTarget, threadId: string, listener: () => void): Disposable => {
    const key = `${targetKey(target)}\0${threadId}`;
    let feed = feeds.get(key);
    if (feed === undefined) {
      feed = {
        target,
        threadId,
        listeners: new Set(),
        view: LOADING,
        client: undefined,
        stop: undefined,
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
      // A subscriber back within the same tick (a re-render) keeps the feed.
      queueMicrotask(() => {
        if (owned.listeners.size > 0 || feeds.get(key) !== owned) return;
        owned.stop?.();
        feeds.delete(key);
        watchers.delete(key);
      });
    });
  };

  return {
    view: (target, threadId) => feeds.get(`${targetKey(target)}\0${threadId}`)?.view ?? LOADING,
    watch(target, threadId) {
      const key = `${targetKey(target)}\0${threadId}`;
      let watch = watchers.get(key);
      if (watch === undefined) {
        watch = (listener) => {
          const subscription = subscribe(target, threadId, listener);
          return () => subscription.dispose();
        };
        watchers.set(key, watch);
      }
      return watch;
    },
    dispose() {
      following.dispose();
      for (const feed of feeds.values()) feed.stop?.();
      feeds.clear();
      watchers.clear();
    },
  };
}
