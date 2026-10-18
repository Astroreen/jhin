import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

// relative: a package dependency would be a cycle
import { createTestKernel, testManifest } from "../../testing/src/index.ts";

const noop = definePlugin({ activate() {} });

describe("lifecycle serialization", () => {
  it("runs concurrent reloads one after the other without double activation", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.base", { provides: { "app.cap": "1.0.0" } }),
          definition: definePlugin({
            activate: (context) => void context.services.provide("app.cap", {}),
          }),
        },
        { manifest: testManifest("app.user", { requires: { "app.cap": "^1" } }), definition: noop },
      ],
    });
    const reloaded: unknown[] = [];
    kernel.events.on("kernel.plugin.reloaded", (payload) => reloaded.push(payload));

    await Promise.all([
      kernel.reload("app.base"),
      kernel.reload("app.base"),
      kernel.reload("app.user"),
    ]);

    expect(reloaded).toEqual([
      { plugin: "app.base", affected: ["app.base", "app.user"] },
      { plugin: "app.base", affected: ["app.base", "app.user"] },
      { plugin: "app.user", affected: ["app.user"] },
    ]);
    expect(kernel.loads("app.base")).toBe(3);
    expect(kernel.loads("app.user")).toBe(4);
    expect(kernel.inspect().services).toEqual([{ capability: "app.cap", plugin: "app.base" }]);

    const deactivated: unknown[] = [];
    kernel.events.on("kernel.plugin.deactivated", (payload) => deactivated.push(payload));
    await kernel.stop();
    expect(deactivated).toEqual([{ plugin: "app.user" }, { plugin: "app.base" }]);
  });

  it("finishes a reload before a stop that was called during it", async () => {
    const kernel = await createTestKernel({
      plugins: [{ manifest: testManifest("app.one"), definition: noop }],
    });

    const reload = kernel.reload("app.one");
    const stop = kernel.stop();
    await Promise.all([reload, stop]);

    expect(kernel.inspect().plugins[0]?.status).toBe("inactive");
  });
});

describe("retained context", () => {
  it("refuses registrations after the plugin was deactivated", async () => {
    let retained: PluginContext | undefined;
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.late"),
          definition: definePlugin({ activate: (context) => void (retained = context) }),
        },
      ],
    });
    await kernel.stop();

    expect(() =>
      retained!.commands.register({
        name: "app.late.cmd",
        description: "Registered too late",
        input: z.object({}),
        output: z.null(),
        handler: () => null,
      }),
    ).toThrow(expect.objectContaining({ code: "KERNEL_STATE" }));
    expect(() => retained!.events.on("app.late.event", () => {})).toThrow(
      expect.objectContaining({ code: "KERNEL_STATE" }),
    );
    expect(kernel.inspect().commands).toEqual([]);
  });
});

describe("optional cycles", () => {
  it("runs two plugins that optionally use each other", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("a", {
            provides: { "cap.a": "1.0.0" },
            optional: { "cap.b": "^1" },
          }),
          definition: noop,
        },
        {
          manifest: testManifest("b", {
            provides: { "cap.b": "1.0.0" },
            optional: { "cap.a": "^1" },
          }),
          definition: noop,
        },
      ],
    });

    expect(kernel.inspect().plugins.map((plugin) => plugin.status)).toEqual(["active", "active"]);
  });

  it("keeps the required edge when an optional edge closes the cycle", async () => {
    const order: string[] = [];
    const recording = (id: string) => definePlugin({ activate: () => void order.push(id) });
    await createTestKernel({
      plugins: [
        {
          manifest: testManifest("a", {
            provides: { "cap.a": "1.0.0" },
            requires: { "cap.b": "^1" },
          }),
          definition: recording("a"),
        },
        {
          manifest: testManifest("b", {
            provides: { "cap.b": "1.0.0" },
            optional: { "cap.a": "^1" },
          }),
          definition: recording("b"),
        },
      ],
    });

    expect(order).toEqual(["b", "a"]);
  });
});

describe("config hardening", () => {
  it("ignores prototype keys coming from layers", async () => {
    let context: PluginContext | undefined;
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.cfg"),
          definition: definePlugin({ activate: (ctx) => void (context = ctx) }),
        },
      ],
    });
    context!.config.define("app.cfg", z.object({ name: z.string().default("x") }));

    kernel.config.setLayer("distribution", { "app.cfg": { name: "base" } });
    kernel.config.setLayer(
      "node",
      JSON.parse('{"app.cfg": {"__proto__": {"polluted": true}, "name": "node"}}'),
    );

    expect(context!.config.get("app.cfg")).toEqual({ name: "node" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("diagnostics", () => {
  it("hints when a missing capability exists on the other side", async () => {
    const kernel = await createTestKernel({
      side: "server",
      plugins: [
        {
          manifest: testManifest("app.ui", { side: "client", provides: { "app.panel": "1.0.0" } }),
          definition: noop,
        },
        {
          manifest: testManifest("app.srv", { side: "server", requires: { "app.panel": "^1" } }),
          definition: noop,
        },
      ],
    });

    const srv = kernel.inspect().plugins.find((plugin) => plugin.id === "app.srv");
    expect(srv?.error).toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { otherSide: { plugin: "app.ui", side: "client" } },
    });
  });

  it("lists every copy of a duplicate plugin", async () => {
    const kernel = await createTestKernel({
      plugins: [
        { manifest: testManifest("dup"), definition: noop },
        { manifest: testManifest("dup"), definition: noop },
      ],
    });

    expect(kernel.inspect().invalid.map((item) => item.location)).toEqual([
      "memory://0",
      "memory://1",
    ]);
  });
});
