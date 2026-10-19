import type { Connections } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";
import { TERMINALS_STREAM, TerminalEvents, type TerminalSummary } from "@jhin/terminal-api";

const NONE: readonly TerminalSummary[] = Object.freeze([]);

/** The terminals of one connected node, kept current while somebody listens. */
export interface TerminalFeed {
  /** Empty until the node answers, and for a node without terminals; the same array until it changes. */
  sessions(): readonly TerminalSummary[];
  subscribe(listener: () => void): Disposable;
}

/**
 * The terminal sessions of every connected node, from each node's
 * `terminals` stream (one list per change). A feed follows its connection:
 * the first listener subscribes, the last one stops, a new client for the
 * connection starts it over.
 */
export function createNodeTerminals(connections: Connections): {
  of(connection: string): TerminalFeed;
} & Disposable {
  interface Feed extends TerminalFeed {
    readonly listeners: Set<() => void>;
    list: readonly TerminalSummary[];
    client: RpcClient | undefined;
    stop: Disposable | undefined;
  }
  const feeds = new Map<string, Feed>();
  const notify = (feed: Feed) => {
    for (const listener of Array.from(feed.listeners)) listener();
  };
  const set = (feed: Feed, list: readonly TerminalSummary[]) => {
    if (list === feed.list) return;
    feed.list = list;
    notify(feed);
  };

  const follow = (id: string, feed: Feed) => {
    const client = feed.listeners.size === 0 ? undefined : connections.get(id)?.client;
    if (client === feed.client) return;
    feed.stop?.dispose();
    feed.stop = undefined;
    feed.client = client;
    if (client === undefined) {
      set(feed, NONE);
      return;
    }
    // The stream keeps the latest list only: a new subscriber gets it at once.
    feed.stop = client.subscribe(
      TERMINALS_STREAM,
      { after: 0, onError: () => set(feed, NONE) },
      (event) => {
        if (event.type !== TerminalEvents.sessions) return;
        const terminals = (event.payload as { terminals?: TerminalSummary[] } | null)?.terminals;
        set(feed, Array.isArray(terminals) && terminals.length > 0 ? terminals : NONE);
      },
    );
  };

  const watching = connections.subscribe(() => {
    for (const [id, feed] of feeds) follow(id, feed);
  });

  return {
    of(connection) {
      let feed = feeds.get(connection);
      if (feed !== undefined) return feed;
      const created: Feed = {
        listeners: new Set(),
        list: NONE,
        client: undefined,
        stop: undefined,
        sessions: () => created.list,
        subscribe(listener) {
          created.listeners.add(listener);
          follow(connection, created);
          return toDisposable(() => {
            created.listeners.delete(listener);
            follow(connection, created);
          });
        },
      };
      feed = created;
      feeds.set(connection, feed);
      return feed;
    },
    dispose() {
      watching.dispose();
      for (const feed of feeds.values()) feed.stop?.dispose();
      feeds.clear();
    },
  };
}
