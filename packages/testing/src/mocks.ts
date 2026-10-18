import { definePlugin } from "@jhin/sdk";

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
