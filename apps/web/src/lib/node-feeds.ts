// A record of every open connection kept current from one of its streams:
// what the inbox (agents.md D630) and health (D731) follow on each node.
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** One node's state of a feed. */
export interface NodeFeed<S> {
  /** `unsupported`: the node lacks the command, or this client may not read it. */
  readonly status: "loading" | "ready" | "unsupported" | "error";
  readonly value: S;
  readonly error?: string;
}

export interface NodeFeeds<S> {
  /** Every connection's feed, by connection id: the same map until one changes. */
  snapshot(): ReadonlyMap<string, NodeFeed<S>>;
  subscribe(listener: () => void): Disposable;
  /**
   * Applies a change this client made and knows succeeded to a feed whose
   * stream is not live, so what it shows does not wait for an event that will
   * not come. A live feed is left to its stream.
   */
  apply(id: string, event: { type: string; payload: unknown }): void;
}

/** The connections whose feed was read and then failed: what they show may be out of date. */
export function notLive<S>(nodes: ReadonlyMap<string, NodeFeed<S>>): string[] {
  return [...nodes].filter(([, feed]) => feed.status === "error").map(([node]) => node);
}

export interface NodeFeedSource<S> {
  /** What a feed holds before its node answers, and when it cannot. */
  readonly empty: S;
  /** The stream to follow after the head `load` returns. */
  readonly stream: string;
  /** Reads a node's state and the head of `stream` it reflects. */
  load(client: NodeConnection["client"]): Promise<{ head: number; state: S }>;
  /** Applies one event of the stream; the same state when nothing changed. */
  apply(state: S, event: { type: string; payload: unknown }): S;
  /** Hears every event that came after the load, with the states around it. */
  seen?(
    connection: NodeConnection,
    event: { type: string; payload: unknown },
    before: S,
    after: S,
  ): void;
  /**
   * Hears a read again after the stream dropped, with what the feed held
   * before it and what the node holds now: what came meanwhile is new.
   */
  reread?(connection: NodeConnection, before: S, after: S): void;
}

const NOT_THERE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/** Follows `source` on every open connection for as long as it is not disposed. */
export function createNodeFeeds<S>(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  source: NodeFeedSource<S>,
): NodeFeeds<S> & Disposable {
  const states = new Map<string, NodeFeed<S>>();
  const feeds = new Map<string, { client: NodeConnection["client"]; stop: () => void }>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, NodeFeed<S>> = new Map();
  const changed = () => {
    snapshot = new Map(states);
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("a feed listener failed", { stream: source.stream, error: String(error) });
      }
    }
  };
  const set = (id: string, update: (feed: NodeFeed<S>) => NodeFeed<S>) => {
    const known = states.get(id);
    if (known === undefined) return;
    const next = update(known);
    if (next === known) return;
    states.set(id, next);
    changed();
  };

  const start = (connection: NodeConnection) => {
    const { id, client } = connection;
    const subscriptions: Disposable[] = [];
    let stopped = false;
    feeds.set(id, {
      client,
      stop: () => {
        stopped = true;
        for (const subscription of subscriptions) subscription.dispose();
      },
    });
    states.set(id, { status: "loading", value: source.empty });
    changed();
    /** One more read after a stream that failed once it was read (D731). */
    let retried = false;
    const failed = (error: unknown) => {
      if (stopped) return;
      const code = String((error as { code?: unknown } | null)?.code);
      const message = error instanceof Error ? error.message : String(error);
      const wasRead = states.get(id)?.status === "ready";
      // A node that never answered has nothing to show; a feed that failed
      // after it was read (even a permission taken back) keeps what it showed,
      // marked not live.
      set(id, (feed) =>
        feed.status === "loading" && NOT_THERE.has(code)
          ? { status: "unsupported", value: source.empty }
          : {
              status: "error",
              value: feed.value,
              // A permission taken back is not a dropped stream: say which.
              error:
                code === "PERMISSION_DENIED"
                  ? `this client may no longer read it (${message})`
                  : message,
            },
      );
      // A stream that dropped is read and followed once more, so one hiccup
      // does not silence what is told; a second failure stays not live until
      // the connection is replaced. A permission taken back is not retried.
      if (wasRead && !retried && code !== "PERMISSION_DENIED") {
        retried = true;
        for (const subscription of subscriptions.splice(0)) subscription.dispose();
        follow(true);
      }
    };
    const follow = (again = false) =>
      void source
        .load(client)
        .then(({ head, state }) => {
          if (stopped) return;
          const before = states.get(id)?.value ?? source.empty;
          set(id, () => ({ status: "ready", value: state }));
          // What arrived while the stream was down is told now, not lost.
          if (again) {
            try {
              source.reread?.(connection, before, state);
            } catch (error) {
              log.warn("a feed's listener failed", { stream: source.stream, error: String(error) });
            }
          }
          subscriptions.push(
            client.subscribe(source.stream, { after: head, onError: failed }, (event) => {
              if (stopped) return;
              // The stream works again: a later drop may be retried once more.
              retried = false;
              const before = states.get(id)?.value ?? source.empty;
              const after = source.apply(before, event);
              if (after !== before) set(id, (feed) => ({ ...feed, value: after }));
              // What hears the events (a notification) never breaks the feed.
              try {
                source.seen?.(connection, event, before, after);
              } catch (error) {
                log.warn("a feed's listener failed", {
                  stream: source.stream,
                  error: String(error),
                });
              }
            }),
          );
        })
        .catch(failed);
    follow();
  };

  const stop = (id: string) => {
    feeds.get(id)?.stop();
    feeds.delete(id);
    if (states.delete(id)) changed();
  };
  const sync = () => {
    const open = connections.list().filter((connection) => connection.state === "open");
    for (const [id, feed] of feeds) {
      const connection = open.find((item) => item.id === id);
      // What a closed or replaced connection showed is not live any more.
      if (connection === undefined || connection.client !== feed.client) stop(id);
    }
    for (const connection of open) if (!feeds.has(connection.id)) start(connection);
  };
  const watching = connections.subscribe(sync);
  sync();

  return {
    snapshot: () => snapshot,
    apply(id, event) {
      set(id, (feed) => {
        if (feed.status !== "error") return feed;
        const value = source.apply(feed.value, event);
        return value === feed.value ? feed : { ...feed, value };
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose() {
      watching.dispose();
      listeners.clear();
      for (const id of Array.from(feeds.keys())) stop(id);
    },
  };
}
