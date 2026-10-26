import { HISTORY_CACHE_CAPABILITY, type HistoryCache } from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";

import { builtin } from "../../lib/builtin.ts";
import { openHistoryStore, type HistoryStore } from "./store.ts";

/** The service over a store; a store that fails costs a replay from 0, never the thread. */
function createHistoryCache(store: HistoryStore, now: () => number = Date.now): HistoryCache {
  return {
    enabled: () => true,
    read: (connection, stream) => store.read(connection, stream, now()),
    append: (connection, stream, epoch, events) =>
      store.append(connection, stream, epoch, events, now()),
    drop: (connection, stream) => store.drop(connection, stream),
    readCatalog: (connection) => store.readCatalog(connection),
    writeCatalog: (connection, catalog) => store.writeCatalog(connection, catalog),
  };
}

/**
 * `jhin.history-cache` (loading.md D1588): the streams this device has read,
 * kept in IndexedDB, as `client.history-cache@1`. Without IndexedDB (a
 * private window that refuses it) the plugin provides nothing and threads
 * open from 0, as before it.
 */
export const historyCachePlugin = builtin(
  "jhin.history-cache",
  { provides: { [HISTORY_CACHE_CAPABILITY]: "1.1.0" } },
  definePlugin({
    activate(context) {
      if (typeof indexedDB === "undefined") return;
      const store = openHistoryStore();
      context.subscriptions.add({ dispose: () => store.close() });
      context.services.provide(HISTORY_CACHE_CAPABILITY, createHistoryCache(store));
    },
  }),
);
