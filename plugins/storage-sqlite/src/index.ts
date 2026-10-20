import * as Fs from "node:fs";
import * as Path from "node:path";

import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { BLOBS_CAPABILITY, EVENTLOG_CAPABILITY, KV_CAPABILITY } from "@jhin/storage-api";

import { openFileBlobs } from "./blobs.ts";

import { openSqliteStorage } from "./sqlite.ts";

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
const Config = z
  .object({
    path: z
      .string()
      .optional()
      .meta({
        title: "Database file",
        description:
          "Absolute or relative to the Jhin home; defaults to <home>/data/jhin.storage-sqlite/jhin.db. Read when the node starts.",
        examples: ["data/jhin.db"],
        advanced: true,
      }),
  })
  .meta({
    title: "Storage (SQLite)",
    description: "Where this node keeps its event logs and settings.",
  });

export default definePlugin({
  activate(context) {
    context.config.define("jhin.storage-sqlite", Config);
    const config = context.config.get<z.output<typeof Config>>("jhin.storage-sqlite");
    const paths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
    // A relative path is relative to the Jhin home, never to wherever the node was started.
    const file =
      config.path === undefined
        ? Path.join(paths.dataDir(context.plugin.id), "jhin.db")
        : Path.resolve(paths.home, config.path);
    Fs.mkdirSync(Path.dirname(file), { recursive: true });

    const storage = openSqliteStorage(file);
    context.subscriptions.add({ dispose: () => storage.close() });
    context.services.provide(KV_CAPABILITY, storage.kv);
    context.services.provide(EVENTLOG_CAPABILITY, storage.log);
    // Blobs are files beside the database's default place, whatever file the database is.
    context.services.provide(
      BLOBS_CAPABILITY,
      openFileBlobs(Path.join(paths.dataDir(context.plugin.id), "blobs")),
    );
    context.log.info("storage opened", { file });
  },
});

export { openFileBlobs } from "./blobs.ts";
export { openSqliteStorage, type SqliteStorage } from "./sqlite.ts";
