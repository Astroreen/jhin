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
