import type { Connections } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { SCHEDULER_STREAM, SchedulerEvents, type ScheduledTask } from "@jhin/scheduler-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** What a client knows of one node's scheduled tasks. */
export interface SchedulerView {
  /** `unavailable`: the node has no scheduler (`scheduler.tasks.list` is not a command there). */
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly error?: string;
  /** In creation order. */
  readonly tasks: readonly ScheduledTask[];
  /**
   * Webhook tasks whose URL is being read again (`loading`: the stream said
   * the task changed, maybe its URL was rotated) or could not be
   * (`failed`). Neither is a matter of rights.
   */
  readonly urls?: ReadonlyMap<string, "loading" | "failed">;
}

const withUrlState = (
  view: SchedulerView,
  id: string,
  state: "loading" | "failed" | undefined,
): ReadonlyMap<string, "loading" | "failed"> => {
  const urls = new Map(view.urls);
  if (state === undefined) urls.delete(id);
  else urls.set(id, state);
  return urls;
};

const LOADING: SchedulerView = { status: "loading", tasks: [] };

/** Applies one event of a node's `scheduler` stream to a view. */
export function applySchedulerEvent(
  view: SchedulerView,
  event: { type: string; payload: unknown },
): SchedulerView {
  if (event.type === SchedulerEvents.taskUpdated) {
    const task = event.payload as ScheduledTask;
    if (typeof task?.id !== "string") return view;
    const index = view.tasks.findIndex((item) => item.id === task.id);
    const tasks =
      index === -1
        ? [...view.tasks, task]
        : view.tasks.map((item, at) => (at === index ? task : item));
    // The stream never carries the URL: it is unknown until the task is read
    // again, never the old one a rotation may have killed.
    if (task.webhook?.path !== null) return { ...view, tasks };
    return { ...view, tasks, urls: withUrlState(view, task.id, "loading") };
  }
  if (event.type === SchedulerEvents.taskDeleted) {
    const id = (event.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return view;
    // A deleted task keeps no URL state; a read of it still in flight finds no task.
    return {
      ...view,
      tasks: view.tasks.filter((item) => item.id !== id),
      urls: withUrlState(view, id, undefined),
    };
  }
  return view;
}

/**
 * Puts the webhook URL a task was read with into the view's task, and only
 * that: whatever came on the stream meanwhile is newer than the read.
 */
export function withWebhookUrl(view: SchedulerView, read: ScheduledTask): SchedulerView {
  const webhook = read.webhook;
  if (webhook === undefined || !view.tasks.some((item) => item.id === read.id)) return view;
  const tasks = view.tasks.map((item) =>
    item.id !== read.id || item.webhook === undefined
      ? item
      : { ...item, webhook: { ...item.webhook, path: webhook.path, url: webhook.url } },
  );
  return { ...view, tasks, urls: withUrlState(view, read.id, undefined) };
}

/**
 * Drops a webhook task's URL from the view: a read of it failed, so the URL
 * shown may be one a rotation already killed.
 */
function withoutWebhookUrl(view: SchedulerView, id: string): SchedulerView {
  const tasks = view.tasks.map((item) =>
    item.id !== id || item.webhook === undefined || item.webhook.path === null
      ? item
      : { ...item, webhook: { ...item.webhook, path: null, url: null } },
  );
  return { ...view, tasks, urls: withUrlState(view, id, "failed") };
}

/** The longest wait before a feed that keeps failing starts over. */
const MAX_RETRY_MS = 30_000;

export interface SchedulerStore {
  /** The view of a connection's node; the same object until it changes. */
  view(connection: string): SchedulerView;
  /** Follows the connection's node while subscribed; `listener` fires whenever its view changes. */
  subscribe(connection: string, listener: () => void): Disposable;
  /**
   * `subscribe` as `useSyncExternalStore` takes it: the same function for a
   * connection every time, so a render never resubscribes.
   */
  watch(connection: string): (listener: () => void) => () => void;
}

interface Feed {
  readonly connection: string;
  readonly listeners: Set<() => void>;
  view: SchedulerView;
  client: RpcClient | undefined;
  stop: (() => void) | undefined;
  /**
   * Whether the node gives this client webhook URLs at all: false for a token
   * without the right (its tasks list with no URL), so nothing is read again
   * for one. Unknown until a webhook task was listed or read.
   */
  seesUrls: boolean | undefined;
  /**
   * Starts over since the stream last delivered an event: the first is
   * immediate, later ones back off. Only an event proves the stream works; a
   * list that answers does not (a stream refused right after it would loop),
   * so on a quiet node a later failure may wait a little before starting over.
   */
  retries: number;
}

/**
 * The scheduled tasks of every connected node somebody looks at:
 * `scheduler.tasks.list`, then the node's `scheduler` stream after the head it
 * reflects. A feed starts over whenever its connection opens again.
 */
export function createSchedulerStore(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  /** Runs `run` after `ms`; returns a cancel. Tests run it themselves. */
  delay: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
): SchedulerStore & Disposable {
  const feeds = new Map<string, Feed>();

  const set = (feed: Feed, view: SchedulerView) => {
    if (view === feed.view) return;
    feed.view = view;
    for (const listener of Array.from(feed.listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("a scheduler listener failed", { error: String(error) });
      }
    }
  };

  const start = (feed: Feed, client: RpcClient): (() => void) => {
    let stopped = false;
    let subscription: Disposable | undefined;
    let cancelRetry: (() => void) | undefined;
    /** The latest read of each webhook task, by number. */
    const reads = new Map<string, number>();
    /**
     * A failed list or a broken stream: shown, then the feed starts over, at
     * once the first time and backing off while it keeps failing. A node
     * without the scheduler is not asked again.
     */
    const failed = (error: unknown) => {
      if (stopped) return;
      // A rejection may be anything, not only an Error.
      if ((error as { code?: unknown } | null)?.code === "COMMAND_NOT_FOUND") {
        set(feed, { ...LOADING, status: "unavailable" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      set(feed, { ...feed.view, status: "error", error: message });
      const again = () => {
        if (stopped || feed.client !== client) return;
        feed.stop?.();
        feed.stop = start(feed, client);
      };
      const attempt = feed.retries++;
      if (attempt === 0) queueMicrotask(again);
      else cancelRetry = delay(again, Math.min(MAX_RETRY_MS, 1000 * 2 ** (attempt - 1)));
    };
    void client
      .call<{ tasks: ScheduledTask[]; head: number }>("scheduler.tasks.list", {})
      .then(({ tasks, head }) => {
        if (stopped) return;
        const hooks = tasks.filter((task) => task.webhook !== undefined);
        if (hooks.length > 0) feed.seesUrls = hooks.some((task) => task.webhook?.path !== null);
        set(feed, { status: "ready", tasks });
        subscription = client.subscribe(
          SCHEDULER_STREAM,
          { after: head, onError: failed },
          (event) => {
            if (stopped) return;
            // The stream works: the next failure starts over at once again.
            feed.retries = 0;
            const task = event.payload as ScheduledTask | null;
            const next = applySchedulerEvent(feed.view, event);
            // A client the node shows no URLs to has nothing to read again.
            if (
              feed.seesUrls === false &&
              task?.webhook !== undefined &&
              typeof task.id === "string"
            ) {
              set(feed, { ...next, urls: withUrlState(next, task.id, undefined) });
              return;
            }
            set(feed, next);
            // The stream never carries a webhook's URL token: the task is read again for it.
            if (event.type !== SchedulerEvents.taskUpdated || task?.webhook?.path !== null) return;
            // Only the latest read of a task counts: an older one may hold a rotated-away URL.
            const read = (reads.get(task.id) ?? 0) + 1;
            reads.set(task.id, read);
            const latest = () => !stopped && reads.get(task.id) === read;
            void client
              .call<ScheduledTask>("scheduler.tasks.get", { id: task.id })
              .then((full) => {
                if (!latest()) return;
                if (full.webhook !== undefined) feed.seesUrls = full.webhook.path !== null;
                set(feed, withWebhookUrl(feed.view, full));
              })
              .catch((error: unknown) => {
                log.warn("could not read a scheduled task", { error: String(error) });
                if (latest()) set(feed, withoutWebhookUrl(feed.view, task.id));
              });
          },
        );
      })
      .catch(failed);
    return () => {
      stopped = true;
      cancelRetry?.();
      subscription?.dispose();
    };
  };

  const sync = (feed: Feed) => {
    const node = connections.get(feed.connection);
    const client = node?.state === "open" ? node.client : undefined;
    if (client === feed.client) return;
    feed.stop?.();
    feed.stop = undefined;
    feed.client = client;
    feed.retries = 0;
    feed.seesUrls = undefined;
    // What the old connection showed is not live any more.
    set(feed, LOADING);
    if (client !== undefined) feed.stop = start(feed, client);
  };

  const following = connections.subscribe(() => {
    for (const feed of feeds.values()) sync(feed);
  });

  const watchers = new Map<string, (listener: () => void) => () => void>();
  const store: SchedulerStore & Disposable = {
    view: (connection) => feeds.get(connection)?.view ?? LOADING,
    watch(connection) {
      let watch = watchers.get(connection);
      if (watch === undefined) {
        watch = (listener) => {
          const subscription = store.subscribe(connection, listener);
          return () => subscription.dispose();
        };
        watchers.set(connection, watch);
      }
      return watch;
    },
    subscribe(connection, listener) {
      let feed = feeds.get(connection);
      if (feed === undefined) {
        feed = {
          connection,
          listeners: new Set(),
          view: LOADING,
          client: undefined,
          stop: undefined,
          retries: 0,
          seesUrls: undefined,
        };
        feeds.set(connection, feed);
        sync(feed);
      }
      const owned = feed;
      const entry = () => listener();
      owned.listeners.add(entry);
      return toDisposable(() => {
        owned.listeners.delete(entry);
        // A subscriber back within the same tick (a re-render) keeps the feed.
        queueMicrotask(() => {
          if (owned.listeners.size > 0 || feeds.get(connection) !== owned) return;
          owned.stop?.();
          feeds.delete(connection);
        });
      });
    },
    dispose() {
      following.dispose();
      for (const feed of feeds.values()) feed.stop?.();
      feeds.clear();
      watchers.clear();
    },
  };
  return store;
}
