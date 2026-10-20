import { targetKey, type Connections, type NodeTarget } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";
import { TERMINALS_STREAM, TerminalEvents, type TerminalSummary } from "@jhin/terminal-api";

import { terminalChannel } from "./channel.ts";

const NONE: readonly TerminalSummary[] = Object.freeze([]);

/** The terminals of one node (a connection, or a member through one), kept current while somebody listens. */
export interface TerminalFeed {
  /** Empty until the node answers, and for a node without terminals; the same array until it changes. */
  sessions(): readonly TerminalSummary[];
  subscribe(listener: () => void): Disposable;
}

/**
 * The terminal sessions of every node a view looks at, from each node's
 * `terminals` stream (one list per change); a mesh member's through the
 * connection's relay of it (D504). A feed follows its connection: the first
 * listener subscribes, the last one stops, a new client for the connection
 * starts it over.
 */
export function createNodeTerminals(connections: Connections): {
  of(target: NodeTarget): TerminalFeed;
} & Disposable {
  interface Feed extends TerminalFeed {
    readonly listeners: Set<() => void>;
    list: readonly TerminalSummary[];
    client: RpcClient | undefined;
    stop: Disposable | undefined;
  }
  const feeds = new Map<string, { target: NodeTarget; feed: Feed }>();
  const notify = (feed: Feed) => {
    for (const listener of Array.from(feed.listeners)) listener();
  };
  const set = (feed: Feed, list: readonly TerminalSummary[]) => {
    if (list === feed.list) return;
    feed.list = list;
    notify(feed);
  };

  const follow = (target: NodeTarget, feed: Feed) => {
    const client = feed.listeners.size === 0 ? undefined : connections.get(target.node)?.client;
    if (client === feed.client) return;
    feed.stop?.dispose();
    feed.stop = undefined;
    feed.client = client;
    if (client === undefined) {
      set(feed, NONE);
      return;
    }
    // The stream keeps the latest list only: a new subscriber gets it at once.
    feed.stop = terminalChannel(client, target.remote).subscribe(
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
    for (const { target, feed } of feeds.values()) follow(target, feed);
  });

  return {
    of(target) {
      const key = targetKey(target);
      const known = feeds.get(key);
      if (known !== undefined) return known.feed;
      const fixed: NodeTarget = {
        node: target.node,
        ...(target.remote === undefined ? {} : { remote: target.remote }),
      };
      const created: Feed = {
        listeners: new Set(),
        list: NONE,
        client: undefined,
        stop: undefined,
        sessions: () => created.list,
        subscribe(listener) {
          created.listeners.add(listener);
          follow(fixed, created);
          return toDisposable(() => {
            created.listeners.delete(listener);
            follow(fixed, created);
          });
        },
      };
      feeds.set(key, { target: fixed, feed: created });
      return created;
    },
    dispose() {
      watching.dispose();
      for (const { feed } of feeds.values()) feed.stop?.dispose();
      feeds.clear();
    },
  };
}
