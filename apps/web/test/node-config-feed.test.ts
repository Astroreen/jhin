import {
  CONNECTIONS_CAPABILITY,
  NODE_CONFIG_CHANGED,
  type Connections,
  type NodeConnection,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import type { Json, StoredEvent } from "@jhin/storage-api";
import { createTestKernel, mockCapability } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { nodeConfigFeedPlugin } from "../src/plugins/node-config-feed.ts";

/** A client whose `host/config` subscriptions the test feeds. */
function fakeClient() {
  const open = new Set<(event: StoredEvent) => void>();
  const client = {
    state: "open",
    subscribe: (stream: string, _options: unknown, onEvent: (event: StoredEvent) => void) => {
      expect(stream).toBe("host/config");
      open.add(onEvent);
      return { lastSequence: 0, dispose: () => open.delete(onEvent) };
    },
  } as unknown as RpcClient;
  return {
    client,
    open: () => open.size,
    send: (payload: Json) => {
      for (const onEvent of Array.from(open))
        onEvent({
          stream: "host/config",
          sequence: 1,
          type: "host.config.changed",
          payload,
          at: "",
        });
    },
  };
}

describe("jhin.node-config-feed (D484)", () => {
  it("turns each connection's host/config into node.config.changed, and follows the list", async () => {
    const a = fakeClient();
    let nodes: NodeConnection[] = [
      { id: "a", url: "ws://a", label: "a", client: a.client, state: "open" },
    ];
    const listeners = new Set<() => void>();
    const connections = {
      list: () => nodes,
      get: (id: string) => nodes.find((node) => node.id === id),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    } as unknown as Connections;
    const kernel = await createTestKernel({
      side: "client",
      plugins: [
        mockCapability(CONNECTIONS_CAPABILITY, connections),
        {
          manifest: { ...nodeConfigFeedPlugin.manifest },
          definition: nodeConfigFeedPlugin.definition,
        },
      ],
    });
    const seen: unknown[] = [];
    kernel.events.on(NODE_CONFIG_CHANGED, (payload) => seen.push(payload));

    a.send({ layer: "node", sections: ["jhin.host"] });
    expect(seen).toEqual([{ connection: "a", layer: "node", sections: ["jhin.host"] }]);

    // Opened again: whatever changed while away counts, every section.
    nodes = [{ ...nodes[0]!, state: "connecting" }];
    for (const listener of listeners) listener();
    nodes = [{ ...nodes[0]!, state: "open" }];
    for (const listener of listeners) listener();
    expect(seen.at(-1)).toEqual({ connection: "a", layer: "node", sections: [], all: true });
    expect(a.open()).toBe(1);

    // A removed connection is no longer followed.
    nodes = [];
    for (const listener of listeners) listener();
    expect(a.open()).toBe(0);
    await kernel.stop();
  });
});
