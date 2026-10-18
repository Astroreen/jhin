import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  type Connections,
  type MeshMember,
  type MeshMembership,
  type NodeConnection,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { createTestKernel, mockCapability, testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { meshPlugin } from "../src/plugins/mesh.ts";

const member = (name: string, reachable = true): MeshMember => ({
  nodeId: `id-${name}`,
  name,
  self: name === "a",
  reachable,
});

/** An RPC client that answers `mesh.nodes` from `answers` and counts `mesh` subscriptions. */
function fakeClient(answers: Array<() => Promise<MeshMember[]>>) {
  const open = new Set<(event: StoredEvent) => void>();
  let subscribed = 0;
  const client = {
    state: "open",
    call: (method: string) => {
      if (method !== "mesh.nodes") return Promise.reject(new Error(`unexpected ${method}`));
      return answers.shift()!();
    },
    subscribe: (stream: string, _options: unknown, onEvent: (event: StoredEvent) => void) => {
      if (stream !== "mesh") throw new Error(`unexpected stream ${stream}`);
      subscribed += 1;
      open.add(onEvent);
      return { lastSequence: 0, dispose: () => open.delete(onEvent) };
    },
  } as unknown as RpcClient;
  return {
    client,
    /** How many `mesh` subscriptions were ever opened, and how many are open now. */
    subscriptions: () => ({ opened: subscribed, open: open.size }),
    /** Delivers a `mesh.nodes.changed` event to every open subscription. */
    changed: () => {
      for (const onEvent of Array.from(open))
        onEvent({ stream: "mesh", sequence: 1, type: "mesh.nodes.changed", payload: {}, at: "" });
    },
  };
}

/** `client.connections@1` holding one node, whose connection can be swapped. */
function fakeConnections(first: NodeConnection) {
  let nodes = [first];
  const listeners = new Set<() => void>();
  const connections: Connections = {
    list: () => nodes,
    get: (id) => nodes.find((node) => node.id === id),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
  return {
    connections,
    replace(node: NodeConnection) {
      nodes = [node];
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

const connection = (
  client: RpcClient,
  state: NodeConnection["state"] = "open",
): NodeConnection => ({
  id: "ws://a/rpc",
  url: "ws://a/rpc",
  label: "a",
  client,
  state,
});

async function start(connections: Connections) {
  let membership: MeshMembership | undefined;
  const kernel = await createTestKernel({
    side: "client",
    plugins: [
      mockCapability(CONNECTIONS_CAPABILITY, connections),
      meshPlugin,
      {
        manifest: testManifest("app.consumer", {
          side: "client",
          requires: { [MESH_CAPABILITY]: "^1" },
        }),
        definition: definePlugin({
          activate(context) {
            membership = context.services.get(MESH_CAPABILITY);
          },
        }),
      },
    ],
  });
  return { kernel, membership: membership! };
}

/** Resolves on the next change a subscriber of `connection` is told about. */
function nextChange(membership: MeshMembership, id: string): Promise<void> {
  return new Promise((resolve) => {
    const subscription = membership.subscribe(id, () => {
      subscription.dispose();
      resolve();
    });
  });
}

describe("client.mesh@1", () => {
  it("serves two consumers of one connection from exactly one mesh subscription", async () => {
    const node = fakeClient([async () => [member("a"), member("c")]]);
    const { kernel, membership } = await start(
      fakeConnections(connection(node.client)).connections,
    );
    const id = "ws://a/rpc";

    const seenBySidebar: Array<readonly MeshMember[] | undefined> = [];
    const seenByMain: Array<readonly MeshMember[] | undefined> = [];
    const answered = nextChange(membership, id);
    const sidebar = membership.subscribe(id, () => seenBySidebar.push(membership.members(id)));
    const main = membership.subscribe(id, () => seenByMain.push(membership.members(id)));
    await answered;

    expect(node.subscriptions()).toEqual({ opened: 1, open: 1 });
    expect(seenBySidebar).toEqual([[member("a"), member("c")]]);
    // Both read the very same snapshot.
    expect(seenByMain[0]).toBe(seenBySidebar[0]);

    sidebar.dispose();
    expect(node.subscriptions()).toEqual({ opened: 1, open: 1 });
    main.dispose();
    expect(node.subscriptions()).toEqual({ opened: 1, open: 0 });
    expect(membership.members(id)).toBeUndefined();
    await kernel.stop();
  });

  it("follows mesh events; only the newest answer counts", async () => {
    const node = fakeClient([
      async () => [member("a"), member("c")],
      async () => [member("a"), member("c", false)],
      () => Promise.reject(new Error("mesh is restarting")),
      async () => [member("a")],
    ]);
    const { kernel, membership } = await start(
      fakeConnections(connection(node.client)).connections,
    );
    const id = "ws://a/rpc";
    const watching = membership.subscribe(id, () => undefined);
    await nextChange(membership, id);

    let changed = nextChange(membership, id);
    node.changed();
    await changed;
    expect(membership.members(id)).toEqual([member("a"), member("c", false)]);

    // Two events at once: the first answer (a failure) is superseded by the second.
    changed = nextChange(membership, id);
    node.changed();
    node.changed();
    await changed;
    expect(membership.members(id)).toEqual([member("a")]);
    watching.dispose();
    await kernel.stop();
  });

  it("reads an empty mesh when the first answer fails (a node without the mesh plugin)", async () => {
    const node = fakeClient([() => Promise.reject(new Error("Unknown command mesh.nodes"))]);
    const { kernel, membership } = await start(
      fakeConnections(connection(node.client)).connections,
    );
    const id = "ws://a/rpc";
    const answered = nextChange(membership, id);
    const watching = membership.subscribe(id, () => undefined);
    await answered;
    expect(membership.members(id)).toEqual([]);
    watching.dispose();
    await kernel.stop();
  });

  it("starts over on a new client and stays quiet while the connection is not open", async () => {
    const first = fakeClient([async () => [member("a"), member("c")]]);
    const second = fakeClient([async () => [member("a"), member("d")]]);
    const fake = fakeConnections(connection(first.client));
    const { kernel, membership } = await start(fake.connections);
    const id = "ws://a/rpc";
    let answered = nextChange(membership, id);
    const watching = membership.subscribe(id, () => undefined);
    await answered;

    // Reconnecting: the old client's members are gone and nothing is followed.
    let notified = nextChange(membership, id);
    fake.replace(connection(first.client, "connecting"));
    await notified;
    expect(membership.members(id)).toBeUndefined();
    expect(first.subscriptions()).toEqual({ opened: 1, open: 0 });

    answered = nextChange(membership, id);
    fake.replace(connection(second.client));
    await answered;
    expect(membership.members(id)).toEqual([member("a"), member("d")]);
    expect(second.subscriptions()).toEqual({ opened: 1, open: 1 });

    watching.dispose();
    await kernel.stop();
    expect(second.subscriptions().open).toBe(0);
  });
});
