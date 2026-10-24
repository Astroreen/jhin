import type { Connections, HistoryCache } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import type { HistoryStore } from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Streams no thread opened for this long are forgotten at boot (D1593). */
export const STALE_AFTER_MS = 30 * DAY_MS;

interface HistoryCacheStatus {
  readonly enabled: boolean;
  readonly entries: number;
  readonly bytes: number;
}

export interface HistoryCacheControl extends HistoryCache {
  status(): Promise<HistoryCacheStatus>;
  /** Forgets one connection's streams and catalog, or everything; resolves how many streams went. */
  clear(connection?: string): Promise<number>;
  /** Forgets the streams no thread opened for 30 days (D1593); resolves how many went. */
  evictStale(): Promise<number>;
  /** Fires after a clear has deleted what it was asked to. */
  onCleared(listener: () => void): Disposable;
}

/** Where nothing is kept: the store of a browser without IndexedDB. */
export const NO_STORE: HistoryStore = {
  read: async () => undefined,
  append: async () => undefined,
  drop: async () => undefined,
  readCatalog: async () => undefined,
  writeCatalog: async () => undefined,
  entries: async () => [],
  close: () => undefined,
};

const isQuota = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === "QuotaExceededError";

/**
 * The service over a store (D1592, D1593). Off, it reads and writes nothing.
 * A write over the quota forgets the least recently opened quarter of the
 * other streams and is tried once more; if it fails again the cache stops
 * for the session and threads open from 0 (D1610). A store that fails in any
 * other way costs a replay from 0, never the thread.
 */
export function createHistoryCache(
  store: HistoryStore,
  options: { enabled: () => boolean; now?: () => number },
): HistoryCacheControl {
  const now = options.now ?? Date.now;
  let stopped = false;
  const on = () => options.enabled() && !stopped;
  /**
   * Writes and clears run one after another, a write checking the setting when
   * its turn comes: one in flight when the cache is turned off or a node is
   * forgotten lands before the clear, never after it (D1592).
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  const cleared = new Set<() => void>();
  const evictFor = async (connection: string, stream: string) => {
    const others = (await store.entries())
      .filter((entry) => entry.connection !== connection || entry.stream !== stream)
      .toSorted((a, b) => a.openedAt - b.openedAt);
    for (const entry of others.slice(0, Math.max(1, Math.ceil(others.length / 4)))) {
      await store.drop(entry.connection, entry.stream);
    }
  };
  /** Runs a write in its turn; over the quota, makes room once and tries again. */
  const write = (connection: string, stream: string, run: () => Promise<void>) =>
    serial(() => attempt(connection, stream, run));
  const attempt = async (connection: string, stream: string, run: () => Promise<void>) => {
    if (!on()) return;
    try {
      await run();
    } catch (error) {
      if (!isQuota(error)) throw error;
      await evictFor(connection, stream);
      try {
        await run();
      } catch (again) {
        if (isQuota(again)) stopped = true;
        throw again;
      }
    }
  };
  const forget = (connection?: string) =>
    serial(async () => {
      const before = await store.entries();
      await store.drop(connection);
      for (const listener of Array.from(cleared)) listener();
      return before.filter((entry) => connection === undefined || entry.connection === connection)
        .length;
    });
  return {
    enabled: on,
    read: async (connection, stream) => (on() ? store.read(connection, stream, now()) : undefined),
    append: (connection, stream, epoch, events) =>
      write(connection, stream, () => store.append(connection, stream, epoch, events, now())),
    // In turn too: a write queued for the stream lands before the drop, not after it.
    drop: (connection, stream) => serial(() => store.drop(connection, stream)),
    readCatalog: async (connection) => (on() ? store.readCatalog(connection) : undefined),
    writeCatalog: (connection, catalog) =>
      write(connection, "", () => store.writeCatalog(connection, catalog)),
    // After what is queued: the status of the cache once its writes and clears are done.
    status: () =>
      serial(async () => {
        const entries = await store.entries();
        return {
          enabled: on(),
          entries: entries.length,
          bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        };
      }),
    clear: forget,
    onCleared(listener) {
      cleared.add(listener);
      return { dispose: () => cleared.delete(listener) };
    },
    evictStale: () =>
      serial(async () => {
        if (!on()) return 0;
        const oldest = now() - STALE_AFTER_MS;
        const stale = (await store.entries()).filter((entry) => entry.openedAt < oldest);
        for (const entry of stale) await store.drop(entry.connection, entry.stream);
        return stale.length;
      }),
  };
}

/**
 * Forgets what a device forgets (D1593): a saved node removed (which signs
 * the page out of its own node) or one whose token its node refused (`401`,
 * the client closed `UNAUTHENTICATED`) takes its streams and catalog along.
 */
export function forgetWithConnections(
  connections: Connections,
  forget: (connection: string) => void,
): Disposable {
  const seen = new Set<string>();
  const refused = new Set<string>();
  const check = () => {
    const present = new Set(connections.list().map((connection) => connection.id));
    for (const id of seen) {
      if (present.has(id)) continue;
      seen.delete(id);
      refused.delete(id);
      forget(id);
    }
    for (const connection of connections.list()) {
      seen.add(connection.id);
      const unauthenticated =
        connection.state === "closed" && connection.client.closeReason?.code === "UNAUTHENTICATED";
      if (!unauthenticated) refused.delete(connection.id);
      else if (!refused.has(connection.id)) {
        refused.add(connection.id);
        forget(connection.id);
      }
    }
  };
  check();
  return connections.subscribe(check);
}
