import type { Connections } from "@jhin/client-api";
import {
  applyMissionEvent,
  EMPTY_MISSIONS,
  MISSIONS_STREAM,
  type Mission,
  type MissionsState,
  type ProjectIntent,
  type Slice,
} from "@jhin/missions-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** What a client knows of one node's missions (D641: the fold of its `missions` stream). */
export interface MissionsView {
  /**
   * `unavailable`: the node has no missions plugin (`missions.catalog` is not a
   * command there) or this client may not read them (`PERMISSION_DENIED`).
   */
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly error?: string;
  readonly state: MissionsState;
}

const LOADING: MissionsView = { status: "loading", state: EMPTY_MISSIONS };

/** Answers that are final for this opening: the node is not asked again until it reopens. */
const UNAVAILABLE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/** The longest wait before a feed that keeps failing starts over. */
const MAX_RETRY_MS = 30_000;

/** The fold of a `missions.catalog` answer: the same state its events would have built. */
function stateOf(catalog: {
  readonly intents: readonly ProjectIntent[];
  readonly missions: readonly Mission[];
  readonly slices: readonly Slice[];
}): MissionsState {
  return {
    intents: Object.fromEntries(catalog.intents.map((intent) => [intent.projectId, intent])),
    missions: Object.fromEntries(catalog.missions.map((mission) => [mission.id, mission])),
    slices: Object.fromEntries(catalog.slices.map((slice) => [slice.id, slice])),
  };
}

export interface MissionsStore {
  /** The view of a connection's node; the same object until it changes. */
  view(connection: string): MissionsView;
  /** Follows the connection's node while subscribed; `listener` fires whenever its view changes. */
  subscribe(connection: string, listener: () => void): Disposable;
}

interface Feed {
  readonly connection: string;
  readonly listeners: Set<() => void>;
  view: MissionsView;
  client: RpcClient | undefined;
  stop: (() => void) | undefined;
  /** Starts over since the stream last delivered an event; later ones back off. */
  retries: number;
}

/**
 * The missions of every connected node somebody looks at: `missions.catalog`,
 * then the node's `missions` stream after the head it reflects, folded with
 * `applyMissionEvent` as the node folds it (D641). A feed starts over whenever
 * its connection opens again, and after a failure, backing off.
 */
export function createMissionsStore(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  /** Runs `run` after `ms`; returns a cancel. Tests run it themselves. */
  delay: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
): MissionsStore & Disposable {
  const feeds = new Map<string, Feed>();

  const set = (feed: Feed, view: MissionsView) => {
    if (view === feed.view) return;
    feed.view = view;
    for (const listener of Array.from(feed.listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("a missions listener failed", { error: String(error) });
      }
    }
  };

  const start = (feed: Feed, client: RpcClient): (() => void) => {
    let stopped = false;
    let subscription: Disposable | undefined;
    let cancelRetry: (() => void) | undefined;
    let failedOnce = false;
    const failed = (error: unknown) => {
      // A catalog and its stream never both schedule a restart.
      if (stopped || failedOnce) return;
      failedOnce = true;
      if (UNAVAILABLE.has(String((error as { code?: unknown } | null)?.code))) {
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
      .call<{
        head: number;
        intents: ProjectIntent[];
        missions: Mission[];
        slices: Slice[];
      }>("missions.catalog", {})
      .then((catalog) => {
        if (stopped) return;
        set(feed, { status: "ready", state: stateOf(catalog) });
        subscription = client.subscribe(
          MISSIONS_STREAM,
          { after: catalog.head, onError: failed },
          (event) => {
            if (stopped) return;
            feed.retries = 0;
            const state = applyMissionEvent(feed.view.state, event);
            if (state !== feed.view.state) set(feed, { status: "ready", state });
          },
        );
        if (stopped) subscription.dispose();
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
    // What the old connection showed is not live any more.
    set(feed, LOADING);
    if (client !== undefined) feed.stop = start(feed, client);
  };

  const following = connections.subscribe(() => {
    for (const feed of feeds.values()) sync(feed);
  });

  return {
    view: (connection) => feeds.get(connection)?.view ?? LOADING,
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
        };
        feeds.set(connection, feed);
      }
      feed.listeners.add(listener);
      sync(feed);
      const followed = feed;
      return toDisposable(() => {
        followed.listeners.delete(listener);
        // The last one gone closes the feed; the next subscriber loads it afresh.
        if (followed.listeners.size > 0) return;
        followed.stop?.();
        feeds.delete(followed.connection);
      });
    },
    dispose() {
      following.dispose();
      for (const feed of feeds.values()) feed.stop?.();
      feeds.clear();
    },
  };
}
