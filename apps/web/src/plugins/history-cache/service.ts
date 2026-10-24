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
}

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
  const evictFor = async (connection: string, stream: string) => {
    const others = (await store.entries())
      .filter((entry) => entry.connection !== connection || entry.stream !== stream)
      .toSorted((a, b) => a.openedAt - b.openedAt);
    for (const entry of others.slice(0, Math.max(1, Math.ceil(others.length / 4)))) {
      await store.drop(entry.connection, entry.stream);
    }
  };
  /** Runs a write; over the quota, makes room once and tries again. */
  const write = async (connection: string, stream: string, run: () => Promise<void>) => {
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
  const forget = async (connection?: string) => {
    const before = await store.entries();
    await store.drop(connection);
    return before.filter((entry) => connection === undefined || entry.connection === connection)
      .length;
  };
  return {
    enabled: on,
    read: async (connection, stream) => (on() ? store.read(connection, stream, now()) : undefined),
    append: (connection, stream, epoch, events) =>
      write(connection, stream, () => store.append(connection, stream, epoch, events, now())),
    drop: (connection, stream) => store.drop(connection, stream),
    readCatalog: async (connection) => (on() ? store.readCatalog(connection) : undefined),
    writeCatalog: (connection, catalog) =>
      write(connection, "", () => store.writeCatalog(connection, catalog)),
    async status() {
      const entries = await store.entries();
      return {
        enabled: options.enabled(),
        entries: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      };
    },
    clear: forget,
    async evictStale() {
      const oldest = now() - STALE_AFTER_MS;
      const stale = (await store.entries()).filter((entry) => entry.openedAt < oldest);
      for (const entry of stale) await store.drop(entry.connection, entry.stream);
      return stale.length;
    },
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
