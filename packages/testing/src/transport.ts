import type { Kernel } from "@jhin/kernel";
import { createPeerPair, createRpcClient, serveRpc, type Peer, type RpcClient } from "@jhin/rpc";
import { noopLogger } from "@jhin/kernel";
import type { Invocation } from "@jhin/sdk";
import type { EventLog } from "@jhin/storage-api";

export interface InMemoryConnection {
  readonly client: RpcClient;
  /** Drops the current connection as a network failure would; the client reconnects. */
  drop(): void;
}

/**
 * Connects an RPC client to a kernel without sockets: the same protocol, the
 * same server session, an in-memory channel (D38).
 */
export function connectInMemory(
  kernel: Pick<Kernel, "commands">,
  options: { log?: EventLog; caller?: NonNullable<Invocation["caller"]> } = {},
): InMemoryConnection {
  let current: Peer | undefined;
  let traces = 0;
  const client = createRpcClient({
    retryDelay: () => 0,
    async connect() {
      const [clientEnd, serverEnd] = createPeerPair();
      current = serverEnd;
      serveRpc(serverEnd, {
        execute: (name, input, invocation) => kernel.commands.execute(name, input, invocation),
        caller: options.caller ?? { id: "owner", permissions: ["*"] },
        ...(options.log === undefined ? {} : { log: options.log }),
        hello: () => ({ protocol: "in-memory" }),
        newTraceId: () => `test-trace-${++traces}`,
        logger: noopLogger,
      });
      return clientEnd;
    },
  });
  return { client, drop: () => current?.close(1006, "dropped by test") };
}
