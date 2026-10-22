import { definePlugin, type PluginContext } from "@jhin/sdk";
import { createTestKernel, testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_SECTION, ChatSettings, readSection } from "../src/lib/settings.ts";

describe("stored chat settings (D70)", () => {
  it("still read when they keep the removed threads-per-project setting", async () => {
    let context: PluginContext | undefined;
    const kernel = await createTestKernel({
      side: "client",
      configLayers: ["device"],
      // A device that saved the setting before it went away.
      config: { device: { [CHAT_SECTION]: { threadPreviewCount: 10, sendShortcut: "mod-enter" } } },
      plugins: [
        {
          manifest: testManifest("app.chat", { side: "client" }),
          definition: definePlugin({
            activate(current) {
              current.config.define(CHAT_SECTION, ChatSettings);
              context = current;
            },
          }),
        },
      ],
    });
    const settings = readSection(context!, CHAT_SECTION, ChatSettings);
    // The rest of the device's choices hold; the stale key is dropped.
    expect(settings.sendShortcut).toBe("mod-enter");
    expect(settings).not.toHaveProperty("threadPreviewCount");
    await kernel.stop();
  });
});
