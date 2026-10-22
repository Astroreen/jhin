import { createTestKernel, mockCapability, testManifest } from "../../testing/src/index.ts"; // relative: a package dependency would be a cycle
import { definePlugin, z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

const echo = {
  name: "app.echo",
  description: "Echoes its input",
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  handler: (input: { text: string }) => input,
};

describe("lifecycle", () => {
  it("isolates an activation failure: it fails, its dependants block, the rest run", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.store", { provides: { "app.storage": "1.0.0" } }),
          definition: definePlugin({
            activate(context) {
              context.commands.register(echo);
              throw new Error("disk on fire");
            },
          }),
        },
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^1" } }),
          definition: definePlugin({ activate() {} }),
        },
        { manifest: testManifest("app.other"), definition: definePlugin({ activate() {} }) },
      ],
    });

    const snapshot = kernel.inspect();
    const byId = Object.fromEntries(snapshot.plugins.map((plugin) => [plugin.id, plugin]));
    expect(byId["app.store"]?.status).toBe("failed");
    expect(byId["app.store"]?.error?.code).toBe("ACTIVATION_FAILED");
    expect(byId["app.store"]?.error?.message).toContain("disk on fire");
    expect(byId["app.ui"]?.status).toBe("blocked");
    expect(byId["app.ui"]?.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(byId["app.other"]?.status).toBe("active");
    // Registrations made before the throw are rolled back.
    expect(snapshot.commands).toEqual([]);
  });

  it("fails a plugin whose module does not default-export a plugin definition", async () => {
    const kernel = await createTestKernel({
      plugins: [{ manifest: testManifest("app.bad"), definition: {} as never }],
    });

    expect(kernel.inspect().plugins[0]?.error?.code).toBe("MODULE_INVALID");
  });

  it("disposes every registration and calls deactivate in reverse order on stop", async () => {
    const calls: string[] = [];
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("app.storage", { kind: "memory" }),
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^1" } }),
          definition: definePlugin({
            activate(context) {
              context.commands.register(echo);
              context.hooks.before("app.send", (input) => input);
              context.subscriptions.add({ dispose: () => calls.push("ui:disposed") });
            },
            deactivate: () => void calls.push("ui:deactivate"),
          }),
        },
      ],
    });
    expect(kernel.inspect().commands.map((command) => command.name)).toEqual(["app.echo"]);
    expect(kernel.inspect().services).toEqual([
      { capability: "app.storage", plugin: "mock.app.storage" },
    ]);

    const deactivated: unknown[] = [];
    kernel.events.on("kernel.plugin.deactivated", (payload) => deactivated.push(payload));
    await kernel.stop();

    const snapshot = kernel.inspect();
    expect(calls).toEqual(["ui:deactivate", "ui:disposed"]);
    expect(deactivated).toEqual([{ plugin: "app.ui" }, { plugin: "mock.app.storage" }]);
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.hooks).toEqual([]);
    expect(snapshot.services).toEqual([]);
    expect(snapshot.plugins.every((plugin) => plugin.status === "inactive")).toBe(true);
  });

  it("gives a plugin its required services and refuses undeclared ones", async () => {
    let storage: unknown;
    let undeclared: unknown;
    await createTestKernel({
      plugins: [
        mockCapability("app.storage", { kind: "memory" }),
        mockCapability("app.secret", { kind: "secret" }),
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^1" } }),
          definition: definePlugin({
            activate(context) {
              storage = context.services.get("app.storage");
              try {
                context.services.get("app.secret");
              } catch (error) {
                undeclared = error;
              }
            },
          }),
        },
      ],
    });

    expect(storage).toEqual({ kind: "memory" });
    expect(undeclared).toMatchObject({ code: "CAPABILITY_NOT_DECLARED" });
  });

  it("reloads a plugin and its dependants, keeping plugin state", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.counter", { provides: { "app.count": "1.0.0" } }),
          definition: definePlugin({
            activate(context) {
              const count = (context.state.get<number>("count") ?? 0) + 1;
              context.state.set("count", count);
              context.services.provide("app.count", { count, version: "v1" });
            },
          }),
        },
        {
          manifest: testManifest("app.view", { requires: { "app.count": "^1" } }),
          definition: definePlugin({
            activate(context) {
              const counter = context.services.get<{ count: number; version: string }>("app.count");
              context.commands.register({
                name: "app.view.show",
                description: "Shows the counter",
                input: z.object({}),
                output: z.string(),
                handler: () => `${counter.version}:${counter.count}`,
              });
            },
          }),
        },
        { manifest: testManifest("app.unrelated"), definition: definePlugin({ activate() {} }) },
      ],
    });
    expect(await kernel.commands.execute("app.view.show", {})).toBe("v1:1");

    kernel.replace(
      "app.counter",
      definePlugin({
        activate(context) {
          const count = (context.state.get<number>("count") ?? 0) + 1;
          context.state.set("count", count);
          context.services.provide("app.count", { count, version: "v2" });
        },
      }),
    );
    await kernel.reload("app.counter");

    expect(await kernel.commands.execute("app.view.show", {})).toBe("v2:2");
    expect(kernel.loads("app.counter")).toBe(2);
    expect(kernel.loads("app.view")).toBe(2);
    expect(kernel.loads("app.unrelated")).toBe(1);
  });

  it("recovers a failed plugin and its blocked dependants on reload", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.store", { provides: { "app.storage": "1.0.0" } }),
          definition: definePlugin({
            activate() {
              throw new Error("bug");
            },
          }),
        },
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^1" } }),
          definition: definePlugin({ activate() {} }),
        },
      ],
    });
    kernel.replace(
      "app.store",
      definePlugin({ activate: (context) => void context.services.provide("app.storage", {}) }),
    );

    await kernel.reload("app.store");

    expect(kernel.inspect().plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
      ["app.store", "active"],
      ["app.ui", "active"],
    ]);
  });

  it("awaits onDeactivate cleanups, newest first, before deactivate and disposal", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.worker"),
          definition: definePlugin({
            activate(context) {
              context.subscriptions.add({ dispose: () => calls.push("disposed") });
              context.onDeactivate(async () => {
                calls.push("first:start");
                await slow;
                calls.push("first:end");
              });
              context.onDeactivate(() => void calls.push("second"));
            },
            deactivate: () => void calls.push("deactivate"),
          }),
        },
      ],
    });

    const stopped = kernel.stop();
    release();
    await stopped;

    expect(calls).toEqual(["second", "first:start", "first:end", "deactivate", "disposed"]);
  });
});
