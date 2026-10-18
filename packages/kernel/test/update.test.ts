import {
  createTestKernel,
  testManifest,
  type TestKernel,
  type TestPlugin,
} from "../../testing/src/index.ts"; // relative: a package dependency would be a cycle
import { definePlugin, z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

/** A plugin that records its activations and deactivations in `calls`. */
function tracked(
  calls: string[],
  id: string,
  manifest: Record<string, unknown> = {},
  activate: (context: Parameters<Parameters<typeof definePlugin>[0]["activate"]>[0]) => void = () =>
    undefined,
): TestPlugin {
  return {
    location: `memory://${id}`,
    manifest: testManifest(id, manifest),
    definition: definePlugin({
      activate(context) {
        calls.push(`+${id}`);
        activate(context);
      },
      deactivate: () => void calls.push(`-${id}`),
    }),
  };
}

const statuses = (kernel: TestKernel) =>
  Object.fromEntries(kernel.inspect().plugins.map((plugin) => [plugin.id, plugin.status]));

describe("kernel.update", () => {
  it("restarts a plugin whose manifest changed and its dependants, along the new graph, keeping state", async () => {
    const calls: string[] = [];
    const store = (version: string) =>
      tracked(calls, "app.store", { provides: { "app.storage": version } }, (context) => {
        context.state.set("starts", (context.state.get<number>("starts") ?? 0) + 1);
        context.commands.register({
          name: "app.store.starts",
          description: "How often the store started",
          input: z.object({}),
          output: z.number(),
          handler: () => context.state.get<number>("starts") ?? 0,
        });
      });
    const ui = tracked(calls, "app.ui", { requires: { "app.storage": "^1" } });
    const other = tracked(calls, "app.other");
    const kernel = await createTestKernel({ plugins: [store("1.0.0"), ui, other] });
    calls.length = 0;

    const update = await kernel.setPlugins([store("1.1.0"), ui, other]);

    expect(update).toEqual({
      added: [],
      removed: [],
      changed: ["app.store"],
      stopped: ["app.ui", "app.store"],
      started: ["app.store", "app.ui"],
      invalid: [],
    });
    expect(calls).toEqual(["-app.ui", "-app.store", "+app.store", "+app.ui"]);
    expect(kernel.loads("app.other")).toBe(1);
    expect(kernel.inspect().plugins.find((plugin) => plugin.id === "app.store")?.provides).toEqual({
      "app.storage": "1.1.0",
    });
    expect(await kernel.commands.execute("app.store.starts", {})).toBe(2);
  });

  it("blocks dependants when a changed manifest breaks the graph, and recovers when it is fixed", async () => {
    const calls: string[] = [];
    const store = (version: string) =>
      tracked(calls, "app.store", { provides: { "app.storage": version } });
    const ui = tracked(calls, "app.ui", { requires: { "app.storage": "^1" } });
    const other = tracked(calls, "app.other");
    const kernel = await createTestKernel({ plugins: [store("1.0.0"), ui, other] });
    calls.length = 0;

    await kernel.setPlugins([store("2.0.0"), ui, other]);

    expect(statuses(kernel)).toEqual({
      "app.other": "active",
      "app.store": "active",
      "app.ui": "blocked",
    });
    expect(kernel.inspect().plugins.find((plugin) => plugin.id === "app.ui")?.error?.code).toBe(
      "VERSION_MISMATCH",
    );
    expect(calls).toEqual(["-app.ui", "-app.store", "+app.store"]);

    await kernel.setPlugins([store("1.2.0"), ui, other]);

    expect(statuses(kernel)).toEqual({
      "app.other": "active",
      "app.store": "active",
      "app.ui": "active",
    });
    expect(
      kernel.inspect().plugins.find((plugin) => plugin.id === "app.ui")?.error,
    ).toBeUndefined();
  });

  it("keeps the previous manifest when the new one is invalid, and shows why", async () => {
    const calls: string[] = [];
    const store = tracked(calls, "app.store", { provides: { "app.storage": "1.0.0" } });
    const ui = tracked(calls, "app.ui", { requires: { "app.storage": "^1" } });
    const kernel = await createTestKernel({ plugins: [store, ui] });
    calls.length = 0;
    const updated: unknown[] = [];
    kernel.events.on("kernel.plugins.updated", (payload) => updated.push(payload));

    const update = await kernel.setPlugins([
      { ...store, manifest: { id: "app.store", provides: "not a map" } },
      ui,
    ]);

    expect(update).toMatchObject({ changed: [], stopped: [], started: [] });
    expect(updated).toEqual([update]);
    expect(calls).toEqual([]);
    expect(statuses(kernel)).toEqual({ "app.store": "active", "app.ui": "active" });
    expect(kernel.inspect().invalid).toEqual([
      {
        location: "memory://app.store",
        error: expect.objectContaining({
          code: "MANIFEST_INVALID",
          message: "Invalid manifest at memory://app.store; app.store keeps its previous manifest",
          details: expect.objectContaining({ kept: "app.store" }),
        }),
      },
    ]);

    // Fixing it clears the error.
    await kernel.setPlugins([store, ui]);
    expect(kernel.inspect().invalid).toEqual([]);
  });

  it("activates an added plugin, unblocking what needed it, and disposes a removed one with its dependants", async () => {
    const calls: string[] = [];
    const disposed: string[] = [];
    const store = tracked(calls, "app.store", { provides: { "app.storage": "1.0.0" } }, (context) =>
      context.subscriptions.add({ dispose: () => disposed.push("app.store") }),
    );
    const ui = tracked(calls, "app.ui", { requires: { "app.storage": "^1" } });
    const other = tracked(calls, "app.other");
    const kernel = await createTestKernel({ plugins: [ui, other] });
    expect(statuses(kernel)).toEqual({ "app.other": "active", "app.ui": "blocked" });
    calls.length = 0;

    const added = await kernel.setPlugins([ui, other, store]);

    expect(added).toMatchObject({ added: ["app.store"], started: ["app.store", "app.ui"] });
    expect(statuses(kernel)).toEqual({
      "app.other": "active",
      "app.store": "active",
      "app.ui": "active",
    });

    calls.length = 0;
    const removed = await kernel.setPlugins([ui, other]);

    expect(removed).toMatchObject({ removed: ["app.store"], stopped: ["app.ui", "app.store"] });
    expect(calls).toEqual(["-app.ui", "-app.store"]);
    expect(disposed).toEqual(["app.store"]);
    expect(kernel.inspect().services).toEqual([]);
    expect(statuses(kernel)).toEqual({ "app.other": "active", "app.ui": "blocked" });
    expect(kernel.loads("app.other")).toBe(1);
  });

  it("restarts a plugin when a capability it optionally uses appears", async () => {
    const calls: string[] = [];
    const seen: unknown[] = [];
    const ui = tracked(calls, "app.ui", { optional: { "app.theme": "^1" } }, (context) =>
      seen.push(context.services.tryGet("app.theme")),
    );
    const theme: TestPlugin = {
      location: "memory://app.theme",
      manifest: testManifest("app.theme", { provides: { "app.theme": "1.0.0" } }),
      definition: definePlugin({
        activate: (context) => void context.services.provide("app.theme", "dark"),
      }),
    };
    const kernel = await createTestKernel({ plugins: [ui] });

    await kernel.setPlugins([ui, theme]);

    expect(seen).toEqual([undefined, "dark"]);
  });

  it("lets a plugin move to another location (a user copy replacing a distribution plugin)", async () => {
    const calls: string[] = [];
    const original = tracked(calls, "app.store");
    const kernel = await createTestKernel({ plugins: [original] });

    const update = await kernel.setPlugins([{ ...original, location: "memory://user/app.store" }]);

    expect(update).toMatchObject({ changed: ["app.store"], started: ["app.store"] });
    expect(kernel.inspect().plugins[0]?.location).toBe("memory://user/app.store");
  });

  it("emits nothing and touches nothing when nothing changed", async () => {
    const calls: string[] = [];
    const plugins = [tracked(calls, "app.one"), tracked(calls, "app.two")];
    const kernel = await createTestKernel({ plugins });
    const updated: unknown[] = [];
    kernel.events.on("kernel.plugins.updated", (payload) => updated.push(payload));
    calls.length = 0;

    const update = await kernel.setPlugins(plugins);

    expect(update).toMatchObject({ added: [], removed: [], changed: [], stopped: [], started: [] });
    expect(updated).toEqual([]);
    expect(calls).toEqual([]);
  });
});
