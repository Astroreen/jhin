// The teams of every connected node somebody looks at (docs/plans/agents.md,
// A5: D689, D691): `teams.list`, listed again on each event of the node's
// `teams` stream after the head it reflects.
import { TEAMS_STREAM, type TeamRecord } from "@jhin/agent-api";
import type { Connections } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** What a client knows of one node's teams. */
export interface TeamsView {
  /** `unavailable`: the node has no `teams.list`, or this client may not read it. */
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly teams: readonly TeamRecord[];
  readonly error?: string;
}

const LOADING: TeamsView = { status: "loading", teams: [] };
const UNAVAILABLE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

export interface TeamsStore {
  /** The view of a connection's node; the same object until it changes. */
  view(connection: string): TeamsView;
  /** Follows the connection's node while subscribed; `listener` fires whenever its view changes. */
  subscribe(connection: string, listener: () => void): Disposable;
  /** Lists the node's teams again now, as after an action of the owner. */
  refresh(connection: string): void;
}

interface Feed {
  readonly connection: string;
  readonly listeners: Set<() => void>;
  view: TeamsView;
  client: RpcClient | undefined;
  stop: (() => void) | undefined;
  list: (() => void) | undefined;
}

export function createTeamsStore(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): TeamsStore & Disposable {
  const feeds = new Map<string, Feed>();

  const set = (feed: Feed, view: TeamsView) => {
    if (view === feed.view) return;
    feed.view = view;
    for (const listener of Array.from(feed.listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("a teams listener failed", { error: String(error) });
      }
    }
  };

  const start = (feed: Feed, client: RpcClient): (() => void) => {
    let stopped = false;
    let subscription: Disposable | undefined;
    /** Answers come in order of asking: a late answer never replaces a newer one. */
    let asked = 0;
    const failed = (error: unknown) => {
      if (stopped) return;
      if (UNAVAILABLE.has(String((error as { code?: unknown } | null)?.code))) {
        set(feed, { ...LOADING, status: "unavailable" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      set(feed, { ...feed.view, status: "error", error: message });
    };
    const list = () => {
      const ask = ++asked;
      return client.call<{ head: number; teams: TeamRecord[] }>("teams.list", {}).then((answer) => {
        if (stopped || ask !== asked) return undefined;
        set(feed, { status: "ready", teams: answer.teams });
        return answer.head;
      });
    };
    feed.list = () => void list().catch(failed);
    void list()
      .then((head) => {
        if (stopped || head === undefined) return;
        // A team's record is computed (its config, its bundle, its roster): list it again.
        subscription = client.subscribe(TEAMS_STREAM, { after: head, onError: failed }, () => {
          if (!stopped) feed.list?.();
        });
        if (stopped) subscription.dispose();
      })
      .catch(failed);
    return () => {
      stopped = true;
      subscription?.dispose();
    };
  };

  const sync = (feed: Feed) => {
    const node = connections.get(feed.connection);
    const client = node?.state === "open" ? node.client : undefined;
    if (client === feed.client) return;
    feed.stop?.();
    feed.stop = undefined;
    feed.list = undefined;
    feed.client = client;
    // What the old connection showed is not live any more.
    set(feed, LOADING);
    if (client !== undefined) feed.stop = start(feed, client);
  };

  const following = connections.subscribe(() => {
    for (const feed of feeds.values()) sync(feed);
  });

  return {
    view: (connection) => feeds.get(connection)?.view ?? LOADING,
    refresh: (connection) => feeds.get(connection)?.list?.(),
    subscribe(connection, listener) {
      let feed = feeds.get(connection);
      if (feed === undefined) {
        feed = {
          connection,
          listeners: new Set(),
          view: LOADING,
          client: undefined,
          stop: undefined,
          list: undefined,
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
