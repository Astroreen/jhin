import {
  CONNECTIONS_CAPABILITY,
  HISTORY_CACHE_CAPABILITY,
  SETTINGS_CAPABILITY,
  type Connections,
  type DeviceSettings,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { HISTORY_CACHE_SECTION, HistoryCacheSettings, readSection } from "../../lib/settings.ts";
import { historyCacheRow } from "./settings-row.tsx";
import { createHistoryCache, forgetWithConnections, NO_STORE } from "./service.ts";
import { openHistoryStore } from "./store.ts";

/**
 * `jhin.history-cache` (loading.md D1588): the streams this device has read,
 * kept in IndexedDB, as `client.history-cache@1`, behind the device setting
 * "Keep chat history on this device" (D1592). Without IndexedDB (a private
 * window that refuses it) the plugin provides no service, so threads open
 * from 0 as before it, and its commands answer that nothing is kept.
 */
export const historyCachePlugin = builtin(
  "jhin.history-cache",
  {
    provides: { [HISTORY_CACHE_CAPABILITY]: "1.1.0" },
    optional: {
      [CONNECTIONS_CAPABILITY]: "^1",
      [SETTINGS_CAPABILITY]: "^1",
      [UI_SLOTS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      context.config.define(HISTORY_CACHE_SECTION, HistoryCacheSettings);
      // Without IndexedDB nothing is kept, but the commands still answer (rule 6).
      const available = typeof indexedDB !== "undefined";
      const enabled = () =>
        available && readSection(context, HISTORY_CACHE_SECTION, HistoryCacheSettings).enabled;
      const store = available ? openHistoryStore() : NO_STORE;
      context.subscriptions.add({ dispose: () => store.close() });
      const cache = createHistoryCache(store, { enabled });
      const warn = (what: string) => (error: unknown) =>
        context.log.warn(what, { error: error instanceof Error ? error.message : String(error) });

      // Off: nothing is kept, not even what was (D1592).
      if (!enabled()) void cache.clear().catch(warn("the history cache was not cleared"));
      else void cache.evictStale().catch(warn("old history was not evicted"));
      const settings = context.services.tryGet<DeviceSettings>(SETTINGS_CAPABILITY);
      // Turned off here or in another tab: deleted at once.
      context.subscriptions.add(
        context.config.onDidChange(HISTORY_CACHE_SECTION, () => {
          if (!enabled()) void cache.clear().catch(warn("the history cache was not cleared"));
        }),
      );

      const connections = context.services.tryGet<Connections>(CONNECTIONS_CAPABILITY);
      if (connections !== undefined) {
        context.subscriptions.add(
          forgetWithConnections(
            connections,
            (connection) =>
              void cache.clear(connection).catch(warn("a node's history was not cleared")),
          ),
        );
      }

      context.commands.register({
        name: "history-cache.status",
        title: "History cache status",
        description:
          "Whether this device keeps the chat history it read (loading.md D1592), how many thread streams it keeps and about how many bytes they take (the UTF-8 size of their JSON)",
        input: z.object({}),
        output: z.object({ enabled: z.boolean(), entries: z.number(), bytes: z.number() }),
        handler: () => cache.status(),
      });
      context.commands.register({
        name: "history-cache.clear",
        title: "Clear the history cache",
        description:
          "Forgets the chat history this device keeps, of one connection (its RPC URL) or of every node; threads then open from their nodes again. Answers how many thread streams went",
        input: z.object({
          connection: z.string().min(1).optional().meta({
            description: "The connection (a node's RPC URL) to forget; every node when absent",
          }),
        }),
        output: z.object({ cleared: z.number() }),
        handler: async ({ connection }) => ({ cleared: await cache.clear(connection) }),
      });

      const slots = context.services.tryGet<SlotRegistry>(UI_SLOTS_CAPABILITY);
      if (slots !== undefined && settings !== undefined) {
        context.subscriptions.add(
          slots.contribute("settings.general.behavior", {
            id: "jhin.history-cache.setting",
            component: historyCacheRow(context, settings, cache),
          }),
        );
      }
      if (available) context.services.provide(HISTORY_CACHE_CAPABILITY, cache);
    },
  }),
);
