import type { Connections } from "@jhin/client-api";
import { PreviewEvents, previewTabsStream, type PreviewTab } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";

const NONE: readonly PreviewTab[] = Object.freeze([]);

/** The browser tabs of one thread, kept current while somebody listens. */
export interface TabsFeed {
  /** Empty until the node answers; the same array until it changes. */
  tabs(): readonly PreviewTab[];
  subscribe(listener: () => void): Disposable;
}

/**
 * Every thread's tabs from its `preview/<thread>` stream (one list per
 * change). A feed follows its connection: the first listener subscribes, the
 * last one stops, a new client for the connection starts it over.
 */
export function createTabFeeds(connections: Connections): {
  of(connection: string, threadId: string): TabsFeed;
} & Disposable {
  interface Feed extends TabsFeed {
    readonly connection: string;
    readonly threadId: string;
    readonly listeners: Set<() => void>;
    list: readonly PreviewTab[];
    client: RpcClient | undefined;
    stop: Disposable | undefined;
  }
  const feeds = new Map<string, Feed>();
  const set = (feed: Feed, list: readonly PreviewTab[]) => {
    feed.list = list;
    for (const listener of Array.from(feed.listeners)) listener();
  };
  const follow = (feed: Feed) => {
    const client = feed.listeners.size === 0 ? undefined : connections.get(feed.connection)?.client;
    if (client === feed.client) return;
    feed.stop?.dispose();
    feed.stop = undefined;
    feed.client = client;
    if (client === undefined) {
      feed.list = NONE;
      return;
    }
    // The stream keeps the latest list only: a new subscriber gets it at once.
    feed.stop = client.subscribe(
      previewTabsStream(feed.threadId),
      { after: 0, onError: () => set(feed, NONE) },
      (event) => {
        if (event.type !== PreviewEvents.tabs) return;
        const tabs = (event.payload as { tabs?: PreviewTab[] } | null)?.tabs;
        set(feed, Array.isArray(tabs) && tabs.length > 0 ? tabs : NONE);
      },
    );
  };
  const watching = connections.subscribe(() => {
    for (const feed of feeds.values()) follow(feed);
  });
  return {
    of(connection, threadId) {
      const key = `${connection}\u0000${threadId}`;
      const known = feeds.get(key);
      if (known !== undefined) return known;
      const feed: Feed = {
        connection,
        threadId,
        listeners: new Set(),
        list: NONE,
        client: undefined,
        stop: undefined,
        tabs: () => feed.list,
        subscribe(listener) {
          feed.listeners.add(listener);
          follow(feed);
          return toDisposable(() => {
            feed.listeners.delete(listener);
            follow(feed);
          });
        },
      };
      feeds.set(key, feed);
      return feed;
    },
    dispose() {
      watching.dispose();
      for (const feed of feeds.values()) feed.stop?.dispose();
      feeds.clear();
    },
  };
}
