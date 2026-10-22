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
  /** Whether the node was read once: a feed in `error` then still holds what it read. */
  readonly read?: boolean;
  /** For a feed in `error`: whether it is read again (not after a permission taken back). */
  readonly retrying?: boolean;
}

/** A feed that holds what its node answered: live, or failed after it was read. */
export const holdsRead = <S>(feed: NodeFeed<S> | undefined): boolean =>
  feed?.status === "ready" || (feed?.status === "error" && feed.read === true);

export interface NodeFeeds<S> {
  /** Every connection's feed, by connection id: the same map until one changes. */
  snapshot(): ReadonlyMap<string, NodeFeed<S>>;
  subscribe(listener: () => void): Disposable;
  /**
   * Applies a change this client made and knows succeeded to a feed, live
   * or not, and keeps it for a read under way, so what it shows does not wait
   * for an event that may not come. The stream may still bring the same
   * change: the source's `apply` takes it twice as once (idempotent).
   */
  apply(id: string, event: { type: string; payload: unknown }): void;
}

/** The connections whose feed was read and then failed: what they show may be out of date. */
export function notLive<S>(nodes: ReadonlyMap<string, NodeFeed<S>>): string[] {
  // A feed never read shows nothing that could be out of date.
  return [...nodes]
    .filter(([, feed]) => feed.status === "error" && feed.read === true)
    .map(([node]) => node);
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

/**
 * The most a re-read tells, newest first: after a long outage the rest is in
 * the sidebar, not a burst of notifications.
 */
const MAX_TOLD_ON_REREAD = 3;

/**
 * What a re-read tells of `fresh` (newest first): at most
 * `MAX_TOLD_ON_REREAD`, the count of the rest logged, so the cap is seen.
 */
export function newestToTell<T>(
  fresh: readonly T[],
  log: { info(message: string, fields?: Record<string, unknown>): void },
  stream: string,
): readonly T[] {
  if (fresh.length > MAX_TOLD_ON_REREAD) {
    log.info("a re-read told only the newest", {
      stream,
      told: MAX_TOLD_ON_REREAD,
      untold: fresh.length - MAX_TOLD_ON_REREAD,
    });
  }
  return fresh.slice(0, MAX_TOLD_ON_REREAD);
}

/** The least time between two retries of one feed. */
const RETRY_GAP_MS = 60_000;

const NOT_THERE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/** Follows `source` on every open connection for as long as it is not disposed. */
export function createNodeFeeds<S>(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  source: NodeFeedSource<S>,
  timing: {
    /**
     * The time in ms, for the once-a-minute retry: monotonic, so a wall clock
     * stepped back does not hold a retry off.
     */
    readonly clock?: () => number;
    /** Runs `run` after `ms`; tests run it when they say. */
    readonly later?: (ms: number, run: () => void) => Disposable;
  } = {},
): NodeFeeds<S> & Disposable {
  const clock = timing.clock ?? (() => performance.now());
  const later =
    timing.later ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      return toDisposable(() => clearTimeout(timer));
    });
  const states = new Map<string, NodeFeed<S>>();
  /** Changes this client applied to a feed while its stream is read again. */
  const rereads = new Map<string, { type: string; payload: unknown }[]>();
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
        waitingRetry?.dispose();
      },
    });
    states.set(id, { status: "loading", value: source.empty });
    // A change this client makes during the first load is kept for its state too.
    rereads.set(id, []);
    changed();
    /** When this feed last read a dropped stream again (D731). */
    let lastRetry = Number.NEGATIVE_INFINITY;
    /** Whether this feed was ever read; only such a feed is read again. */
    let everRead = false;
    /** A retry waiting for the minute to pass. */
    let waitingRetry: Disposable | undefined;
    /** The current subscription's number: a disposed one's late events are ignored. */
    let generation = 0;
    const retry = () => {
      // The dropped subscription is given up now, not when the read answers:
      // what it still delivers or reports meanwhile is not heard.
      generation += 1;
      // One read at a time: a retry waiting for the minute is this one now.
      waitingRetry?.dispose();
      waitingRetry = undefined;
      lastRetry = clock();
      rereads.set(id, []);
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      // Only a feed read before tells what came meanwhile; a first read tells nothing.
      follow(everRead);
    };
    const failed = (error: unknown) => {
      if (stopped) return;
      rereads.delete(id);
      const raw = (error as { code?: unknown } | null)?.code;
      const code = typeof raw === "string" ? raw : undefined;
      const message = error instanceof Error ? error.message : String(error);
      // A node that has no such feed (or may not read it) is not asked again
      // until it is; anything else, a first load included, is retried.
      const absent = !everRead && code !== undefined && NOT_THERE.has(code);
      // A stream that dropped is read and followed again, so a hiccup does not
      // silence what is told; the feed stays as it is meanwhile, not flashing
      // "not live". The first failure is retried at once (a dropped socket, a
      // node busy for a moment); from then on at most once a minute, so a
      // flapping stream does not loop on the node: a drop (or a failed read)
      // within that minute marks the feed not live and reads it again once
      // the minute is over. A permission taken back, or a node that no longer
      // has the feed (restarted on a build without it), is not retried.
      const retrying = code === undefined || !NOT_THERE.has(code);
      if (!retrying) {
        // A retry already waiting for the minute is called off as well.
        waitingRetry?.dispose();
        waitingRetry = undefined;
      }
      const wait = lastRetry + RETRY_GAP_MS - clock();
      if (retrying && wait <= 0) {
        retry();
        return;
      }
      if (retrying && waitingRetry === undefined) {
        waitingRetry = later(wait, () => {
          waitingRetry = undefined;
          if (!stopped) retry();
        });
      }
      // A node that never answered has nothing to show; a feed that failed
      // after it was read (even a permission taken back) keeps what it showed,
      // marked not live.
      set(id, (feed) =>
        absent
          ? { status: "unsupported", value: source.empty }
          : {
              status: "error",
              value: feed.value,
              ...(feed.read === true ? { read: true } : {}),
              retrying,
              // A permission taken back is not a dropped stream: say which.
              error:
                code === "PERMISSION_DENIED"
                  ? `this client may no longer read it (${message})`
                  : retrying
                    ? message
                    : `this node no longer has it (${message})`,
            },
      );
    };
    const follow = (again = false) =>
      void source
        .load(client)
        .then(({ head, state: read }) => {
          if (stopped) return;
          const shown = states.get(id)?.value ?? source.empty;
          // What this client changed while the stream was read again may not
          // be in what was read: it is applied to it once more. A change that
          // does not apply is this client's bug, not a dropped stream: it is
          // logged and left out, and the read stands.
          const state = (rereads.get(id) ?? []).reduce((value, change) => {
            try {
              return source.apply(value, change);
            } catch (error) {
              log.warn("a feed's change did not apply", {
                stream: source.stream,
                error: String(error),
              });
              return value;
            }
          }, read);
          rereads.delete(id);
          everRead = true;
          set(id, () => ({ status: "ready", value: state, read: true }));
          // What arrived while the stream was down is told now, not lost.
          if (again) {
            try {
              source.reread?.(connection, shown, state);
            } catch (error) {
              log.warn("a feed's listener failed", { stream: source.stream, error: String(error) });
            }
          }
          const mine = ++generation;
          let subscription: Disposable;
          try {
            subscription = subscribeTo(head, mine);
          } catch (error) {
            // A transport that throws instead of following is a dropped stream.
            failed(error);
            return;
          }
          // A transport that fails inside `subscribe` has already started the
          // next read: this subscription is dead on arrival.
          if (mine === generation) subscriptions.push(subscription);
          else subscription.dispose();
          // Only a failed load is a drop; what fails after a read is logged.
        }, failed)
        .catch((error: unknown) =>
          log.warn("a feed failed after its read", { stream: source.stream, error: String(error) }),
        );
    const subscribeTo = (head: number, mine: number) =>
      client.subscribe(
        source.stream,
        {
          after: head,
          // Only the current subscription's failure counts: one given up
          // on may still report, and is not a new drop.
          onError: (error: unknown) => {
            if (mine === generation) failed(error);
          },
        },
        (event) => {
          // A transport may still deliver what it buffered for a subscription
          // already given up: the re-read holds it, so it is not told twice.
          if (stopped || mine !== generation) return;
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
        },
      );
    follow();
  };

  const stop = (id: string) => {
    feeds.get(id)?.stop();
    feeds.delete(id);
    // A replaced connection's feed starts clean: no change pending from the old one.
    rereads.delete(id);
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
      const pending = rereads.get(id);
      set(id, (feed) => {
        // A feed being read again also keeps the change for the state it gets (D731).
        const value = source.apply(feed.value, event);
        return value === feed.value ? feed : { ...feed, value };
      });
      pending?.push(event);
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
