import { noopLogger } from "@jhin/kernel";
import { MESH_STREAMS_CAPABILITY } from "@jhin/mesh-api";
import {
  createMemoryNetwork,
  createMesh,
  meshCallCommand,
  meshRelayCommand,
  meshStreams,
  serveRelays,
  type Mesh,
} from "@jhin/mesh-core";
import { LIVE_STREAMS_CAPABILITY, createLiveStreams, type LiveStreams } from "@jhin/rpc";
import { definePlugin, type Invocation } from "@jhin/sdk";
import type { EventLog } from "@jhin/storage-api";

import { createTestKernel, testManifest, type TestKernel, type TestPlugin } from "./kernel.ts";
import { memoryStoragePlugin, mockCapability } from "./mocks.ts";
import { connectInMemory, type InMemoryConnection } from "./transport.ts";

type Network = ReturnType<typeof createMemoryNetwork>;

export interface MemoryMeshNode {
  readonly id: string;
  readonly address: string;
  readonly mesh: Mesh;
  /** The node's kernel: the mesh's commands, plus the plugins it was started with. */
  readonly kernel: TestKernel;
  /** The node's event log: what members read and mirror. */
  readonly log: EventLog;
  /** The node's live streams (`rpc.streams@1.2`); its relays are served here (D499). */
  readonly live: LiveStreams;
  /** A client of this node, as a web client connects, holding `caller`'s permissions (default `*`). */
  connect(caller?: NonNullable<Invocation["caller"]>): InMemoryConnection;
  /** Joins `other`'s mesh and resolves once each sees the other reachable. */
  join(other: MemoryMeshNode): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A mesh node on the in-memory network (D38, D505), wired as `jhin.mesh`
 * wires one: its kernel provides `rpc.streams@1.2`, `storage.*` and
 * `mesh.streams@1.1` (D1522), and registers the plugin's own `mesh.call` and
 * `mesh.relay`; `plugins` run next to them. Signatures are not
 * cryptographic: one owner's nodes in one process.
 */
export async function startMeshNode(
  network: Network,
  id: string,
  options: {
    readonly plugins?: readonly TestPlugin[];
    readonly config?: Readonly<Record<string, Record<string, unknown>>>;
    /** The storage plugin to run, to read what the node wrote; a fresh one by default. */
    readonly storage?: ReturnType<typeof memoryStoragePlugin>;
    /** Streams relayed at once at most (D502). */
    readonly maxRelays?: number;
  } = {},
): Promise<MemoryMeshNode> {
  const address = `mem://${id}`;
  const storage = options.storage ?? memoryStoragePlugin();
  const log = storage.storage.log;
  const live = createLiveStreams();
  let kernel: TestKernel | undefined;
  const mesh = createMesh({
    identity: { nodeId: id, publicKey: id, name: id },
    sign: (data) => `${id}:${data}`,
    verify: (publicKey, data, signature) => signature === `${publicKey}:${data}`,
    transport: network.transport(address),
    execute: (method, params, invocation) => {
      if (kernel === undefined) {
        return Promise.reject(
          Object.assign(new Error(`${id} is still starting`), { code: "COMMAND_NOT_FOUND" }),
        );
      }
      return kernel.commands.execute(method, params, invocation);
    },
    logger: noopLogger,
    retryDelay: () => 1,
    log,
    streams: live,
    ...(options.maxRelays === undefined ? {} : { maxRelays: options.maxRelays }),
  });
  const meshPlugin: TestPlugin = {
    manifest: testManifest("test.mesh", {
      provides: { [MESH_STREAMS_CAPABILITY]: "1.1.0" },
      side: "server",
    }),
    definition: definePlugin({
      activate(context) {
        context.services.provide(MESH_STREAMS_CAPABILITY, meshStreams(mesh));
        context.subscriptions.add(serveRelays(mesh, live));
        context.commands.register(meshCallCommand(mesh));
        context.commands.register(meshRelayCommand(mesh));
      },
    }),
  };
  kernel = await createTestKernel({
    plugins: [
      mockCapability(LIVE_STREAMS_CAPABILITY, live, "1.2.0"),
      storage,
      meshPlugin,
      ...(options.plugins ?? []),
    ],
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const started = kernel;
  network.listen(address, {
    accept(peer, token) {
      const from = mesh.verifyToken(token);
      if (from === undefined) return false;
      mesh.accept(peer, from);
      return true;
    },
    join: (request) => mesh.acceptJoin(request),
  });
  mesh.setUrls([address]);

  const reachable = (from: Mesh, to: string) =>
    from.members().some((member) => member.record.nodeId === to && member.reachable);
  const clients: InMemoryConnection[] = [];

  return {
    id,
    address,
    mesh,
    kernel: started,
    log,
    live,
    connect(caller) {
      const connection = connectInMemory(started, {
        log,
        streams: live,
        ...(caller === undefined ? {} : { caller }),
      });
      clients.push(connection);
      return connection;
    },
    async join(other) {
      await mesh.join(other.address, other.mesh.invite().code);
      await new Promise<void>((resolve) => {
        const both = () => reachable(mesh, other.id) && reachable(other.mesh, id);
        const subscriptions = [mesh.onChange(check), other.mesh.onChange(check)];
        function check() {
          if (!both()) return;
          for (const subscription of subscriptions) subscription.dispose();
          resolve();
        }
        check();
      });
    },
    async stop() {
      for (const connection of clients.splice(0)) connection.client.close();
      network.unlisten(address);
      mesh.dispose();
      await started.stop();
    },
  };
}
