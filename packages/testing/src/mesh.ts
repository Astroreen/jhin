import type { Kernel } from "@jhin/kernel";
import { noopLogger } from "@jhin/kernel";
import { RELAY_PREFIX, type MeshStreams } from "@jhin/mesh-api";
import { createMemoryNetwork, createMesh, type Mesh } from "@jhin/mesh-core";
import { createLiveStreams, type LiveStreams } from "@jhin/rpc";
import type { Invocation } from "@jhin/sdk";
import { createMemoryStorage, type EventLog } from "@jhin/storage-api";

import { connectInMemory, type InMemoryConnection } from "./transport.ts";

type Network = ReturnType<typeof createMemoryNetwork>;
type Commands = Pick<Kernel, "commands">;

export interface MemoryMeshNode {
  readonly id: string;
  readonly address: string;
  readonly mesh: Mesh;
  /** The node's event log: what members read and mirror. */
  readonly log: EventLog;
  /** The node's live streams (`rpc.streams@1.1`); its relays are served here (D499). */
  readonly live: LiveStreams;
  /** `mesh.streams@1` for the node's plugins: `mockCapability(MESH_STREAMS_CAPABILITY, node.meshStreams)`. */
  readonly meshStreams: MeshStreams;
  /** The kernel whose commands answer this node's calls, from members and clients. */
  use(kernel: Commands): void;
  /**
   * A client of this node, as a web client connects: its commands, plus
   * `mesh.call` and `mesh.relay`, its event log and its live streams with
   * the relays, as `jhin.mesh` serves them.
   */
  connect(): InMemoryConnection;
  /** Joins `other`'s mesh and resolves once each sees the other reachable. */
  join(other: MemoryMeshNode): Promise<void>;
  dispose(): void;
}

const missing = (method: string) =>
  Object.assign(new Error(`Command ${method} is not registered`), { code: "COMMAND_NOT_FOUND" });

/**
 * A mesh node on the in-memory network (D38, D505), wired as `jhin.mesh`
 * wires one: tests put a test kernel behind it (`use`) and drive real
 * plugins on members through `connect()`. Signatures are not cryptographic:
 * one owner's nodes in one process.
 */
export function startMeshNode(
  network: Network,
  id: string,
  options: { readonly log?: EventLog; readonly live?: LiveStreams } = {},
): MemoryMeshNode {
  const address = `mem://${id}`;
  const log = options.log ?? createMemoryStorage().log;
  const live = options.live ?? createLiveStreams();
  let kernel: Commands | undefined;
  const execute = (method: string, params: unknown, invocation: Invocation) => {
    if (kernel === undefined) return Promise.reject(missing(method));
    return kernel.commands.execute(method, params, invocation);
  };
  const mesh = createMesh({
    identity: { nodeId: id, publicKey: id, name: id },
    sign: (data) => `${id}:${data}`,
    verify: (publicKey, data, signature) => signature === `${publicKey}:${data}`,
    transport: network.transport(address),
    execute,
    logger: noopLogger,
    retryDelay: () => 1,
    log,
    streams: live,
  });
  const relays = live.serve(RELAY_PREFIX, mesh.relays, { permissions: ["mesh.call"] });
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

  const node: MemoryMeshNode = {
    id,
    address,
    mesh,
    log,
    live,
    meshStreams: { share: (name) => mesh.share(name) },
    use(next) {
      kernel = next;
    },
    connect() {
      // Only `execute` is used by a connection.
      const commands = {
        execute: async (method: string, params: unknown, invocation: Invocation = {}) => {
          const input = (params ?? {}) as Record<string, unknown>;
          const target = String(input["node"]);
          if (method === "mesh.call") {
            return mesh.call(
              target,
              String(input["method"]),
              input["params"] ?? {},
              invocation.traceId,
            );
          }
          if (method === "mesh.relay")
            return { stream: mesh.relay(target, String(input["stream"])) };
          return execute(method, params, invocation);
        },
      } as unknown as Commands["commands"];
      return connectInMemory({ commands }, { log, streams: live });
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
    dispose() {
      relays.dispose();
      mesh.dispose();
      network.unlisten(address);
    },
  };
  return node;
}
