import { createTestKernel, testManifest } from "../../testing/src/index.ts"; // relative: a package dependency would be a cycle
import { definePlugin } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

const noop = definePlugin({ activate() {} });

function statusOf(
  snapshot: ReturnType<Awaited<ReturnType<typeof createTestKernel>>["inspect"]>,
  id: string,
) {
  const plugin = snapshot.plugins.find((item) => item.id === id);
  return { status: plugin?.status, code: plugin?.error?.code };
}

describe("capability graph", () => {
  it("activates providers before their dependants", async () => {
    const order: string[] = [];
    const recording = (id: string) => definePlugin({ activate: () => void order.push(id) });
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^1" } }),
          definition: recording("app.ui"),
        },
        {
          manifest: testManifest("app.store", { provides: { "app.storage": "1.4.0" } }),
          definition: recording("app.store"),
        },
      ],
    });

    expect(order).toEqual(["app.store", "app.ui"]);
    expect(kernel.inspect().plugins.map((plugin) => plugin.status)).toEqual(["active", "active"]);
  });

  it("blocks a plugin whose required capability is missing", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^1" } }),
          definition: noop,
        },
        { manifest: testManifest("app.other"), definition: noop },
      ],
    });

    expect(statusOf(kernel.inspect(), "app.ui")).toEqual({
      status: "blocked",
      code: "CAPABILITY_MISSING",
    });
    expect(statusOf(kernel.inspect(), "app.other")).toEqual({ status: "active", code: undefined });
  });

  it("blocks a plugin when the provided version does not satisfy the range", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.ui", { requires: { "app.storage": "^2" } }),
          definition: noop,
        },
        {
          manifest: testManifest("app.store", { provides: { "app.storage": "1.4.0" } }),
          definition: noop,
        },
      ],
    });

    const ui = kernel.inspect().plugins.find((plugin) => plugin.id === "app.ui");
    expect(ui?.status).toBe("blocked");
    expect(ui?.error).toMatchObject({
      code: "VERSION_MISMATCH",
      details: { capability: "app.storage", range: "^2", provider: "app.store", version: "1.4.0" },
    });
  });

  it("blocks every member of a dependency cycle and their dependants", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("a", {
            provides: { "cap.a": "1.0.0" },
            requires: { "cap.b": "^1" },
          }),
          definition: noop,
        },
        {
          manifest: testManifest("b", {
            provides: { "cap.b": "1.0.0" },
            requires: { "cap.a": "^1" },
          }),
          definition: noop,
        },
        { manifest: testManifest("c", { requires: { "cap.a": "^1" } }), definition: noop },
        { manifest: testManifest("d"), definition: noop },
      ],
    });

    const snapshot = kernel.inspect();
    expect(statusOf(snapshot, "a")).toEqual({ status: "blocked", code: "DEPENDENCY_CYCLE" });
    expect(statusOf(snapshot, "b")).toEqual({ status: "blocked", code: "DEPENDENCY_CYCLE" });
    expect(statusOf(snapshot, "c")).toEqual({ status: "blocked", code: "DEPENDENCY_UNAVAILABLE" });
    expect(statusOf(snapshot, "d")).toEqual({ status: "active", code: undefined });
  });

  it("blocks every provider of a capability provided twice", async () => {
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("one", { provides: { "app.storage": "1.0.0" } }),
          definition: noop,
        },
        {
          manifest: testManifest("two", { provides: { "app.storage": "1.0.0" } }),
          definition: noop,
        },
      ],
    });

    expect(statusOf(kernel.inspect(), "one")).toEqual({
      status: "blocked",
      code: "CAPABILITY_CONFLICT",
    });
    expect(statusOf(kernel.inspect(), "two")).toEqual({
      status: "blocked",
      code: "CAPABILITY_CONFLICT",
    });
  });

  it("runs a plugin whose optional capability is missing", async () => {
    let seen: unknown = "unset";
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.ui", { optional: { "app.storage": "^1" } }),
          definition: definePlugin({
            activate(context) {
              seen = context.services.tryGet("app.storage");
            },
          }),
        },
      ],
    });

    expect(statusOf(kernel.inspect(), "app.ui")).toEqual({ status: "active", code: undefined });
    expect(seen).toBeUndefined();
  });

  it("reports invalid manifests and duplicate ids without activating them", async () => {
    const kernel = await createTestKernel({
      plugins: [
        { manifest: { id: "Not Valid" }, definition: noop },
        { manifest: testManifest("dup"), definition: noop },
        { manifest: testManifest("dup"), definition: noop },
      ],
    });

    const snapshot = kernel.inspect();
    expect(snapshot.invalid.map((item) => item.error.code)).toEqual([
      "MANIFEST_INVALID",
      "DUPLICATE_PLUGIN",
      "DUPLICATE_PLUGIN",
    ]);
    expect(statusOf(snapshot, "dup")).toEqual({ status: "blocked", code: "DUPLICATE_PLUGIN" });
  });

  it("skips plugins built for the other side", async () => {
    const kernel = await createTestKernel({
      side: "server",
      plugins: [
        { manifest: testManifest("app.web", { side: "client" }), definition: noop },
        { manifest: testManifest("app.node", { side: "server" }), definition: noop },
      ],
    });

    expect(statusOf(kernel.inspect(), "app.web").status).toBe("skipped");
    expect(statusOf(kernel.inspect(), "app.node").status).toBe("active");
  });
});
