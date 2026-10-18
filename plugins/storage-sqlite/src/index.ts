import * as Path from "node:path";

import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, KV_CAPABILITY } from "@jhin/storage-api";

import { openSqliteStorage } from "./sqlite.ts";

const Config = z.object({
  /** Database file; defaults to `<home>/data/jhin.storage-sqlite/jhin.db`. */
  path: z.string().optional(),
});

export default definePlugin({
  activate(context) {
    context.config.define("jhin.storage-sqlite", Config);
    const config = context.config.get<z.output<typeof Config>>("jhin.storage-sqlite");
    const file =
      config.path ??
      Path.join(
        context.services.get<HostPaths>(HOST_PATHS_CAPABILITY).dataDir(context.plugin.id),
        "jhin.db",
      );

    const storage = openSqliteStorage(file);
    context.subscriptions.add({ dispose: () => storage.close() });
    context.services.provide(KV_CAPABILITY, storage.kv);
    context.services.provide(EVENTLOG_CAPABILITY, storage.log);
    context.log.info("storage opened", { file });
  },
});

export { openSqliteStorage, type SqliteStorage } from "./sqlite.ts";
