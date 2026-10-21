import { definePlugin } from "@jhin/sdk";
import {
  createMemoryStorage,
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type MemoryStorage,
} from "@jhin/storage-api";

import { testManifest, type TestPlugin } from "./kernel.ts";

/** A plugin that provides `capability` at `version` with the given implementation. */
export function mockCapability(
  capability: string,
  implementation: unknown,
  version = "1.0.0",
): TestPlugin {
  return {
    manifest: testManifest(`mock.${capability}`, { provides: { [capability]: version } }),
    definition: definePlugin({
      activate(context) {
        context.services.provide(capability, implementation);
      },
    }),
  };
}

/**
 * A plugin providing in-memory `storage.kv@1` and `storage.eventlog@1.1`.
 * The returned `storage` lets a test read what plugins wrote.
 */
export function memoryStoragePlugin(): TestPlugin & { readonly storage: MemoryStorage } {
  const storage = createMemoryStorage();
  return {
    storage,
    manifest: testManifest("mock.storage", {
      provides: { [KV_CAPABILITY]: "1.0.0", [EVENTLOG_CAPABILITY]: "1.2.0" },
    }),
    definition: definePlugin({
      activate(context) {
        context.services.provide(KV_CAPABILITY, storage.kv);
        context.services.provide(EVENTLOG_CAPABILITY, storage.log);
      },
    }),
  };
}
