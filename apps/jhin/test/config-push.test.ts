import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeHome, serve, untilStream, type Node } from "./support/nodes.ts";

const running: Node[] = [];
afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

describe("pushing a node's config changes to its clients (D483)", () => {
  it("tells a client which sections of which file changed", async () => {
    const node = await serve("a", makeHome("a"), running);
    // Subscribed before the change is sent: one connection keeps their order.
    const changed = untilStream(node, "host/config", (events) => events.length > 0);
    await node.client.call("host.config.patch", {
      layer: "node",
      section: "jhin.host",
      values: { machine: "laptop" },
    });
    const [event] = await changed;
    expect(event).toMatchObject({
      type: "host.config.changed",
      payload: { layer: "node", sections: ["jhin.host"] },
    });
    // A change that leaves the file as it was says nothing; the next real one does.
    const next = untilStream(node, "host/config", (events) => events.length > 0);
    await node.client.call("host.config.patch", {
      layer: "node",
      section: "jhin.host",
      values: { machine: "laptop" },
    });
    await node.client.call("host.config.patch", {
      layer: "project",
      section: "jhin.example",
      values: { greeting: "Hi" },
    });
    expect((await next)[0]).toMatchObject({
      payload: { layer: "project", sections: ["jhin.example"] },
    });
  });
});

describe("device settings kept for the owner's devices (D487)", () => {
  it("keeps the later change of a section and tells the node's clients", async () => {
    const node = await serve("d", makeHome("d"), running);
    expect(await node.client.call("host.device-settings.get", {})).toEqual({ sections: {} });
    const changed = untilStream(node, "host/device-settings", (events) => events.length > 0);
    expect(
      await node.client.call("host.device-settings.patch", {
        section: "jhin.chat",
        values: { sendShortcut: "mod-enter" },
        at: 10,
      }),
    ).toEqual({ applied: true });
    expect((await changed)[0]).toMatchObject({
      type: "host.device-settings.changed",
      payload: { section: "jhin.chat", values: { sendShortcut: "mod-enter" }, at: 10 },
    });
    // Older than what is kept: ignored.
    expect(
      await node.client.call("host.device-settings.patch", {
        section: "jhin.chat",
        values: {},
        at: 5,
      }),
    ).toEqual({ applied: false });
    expect(await node.client.call("host.device-settings.get", {})).toEqual({
      sections: { "jhin.chat": { values: { sendShortcut: "mod-enter" }, at: 10 } },
    });
  });
});
