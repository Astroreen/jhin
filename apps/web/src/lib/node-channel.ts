// One way to talk to a node the client shows (mesh-streams.md D504, agents.md
// D1527): a connected node's client itself, or a member of its mesh through
// it, its commands with `mesh.call` and its streams through the connected
// node's relays (`mesh.relay`, D502).
import { ErrorCodes, RpcError, type ClientSubscription, type RpcClient } from "@jhin/rpc";

/** What talking to a node takes: calls, subscriptions and the connection's state. */
export type NodeChannel = Pick<RpcClient, "state" | "onState" | "call" | "subscribe">;

const channels = new WeakMap<RpcClient, Map<string, NodeChannel>>();

/**
 * `client` itself, or the one channel to `member` through it: the same
 * object every time. `relayless` is what a subscription fails with when the
 * connected node has no relays.
 */
export function nodeChannel(
  client: RpcClient,
  member: string | undefined,
  relayless = "This node cannot stream from other nodes of its mesh",
): NodeChannel {
  if (member === undefined) return client;
  const byMember = channels.get(client) ?? new Map<string, NodeChannel>();
  channels.set(client, byMember);
  const key = `${member}\n${relayless}`;
  let channel = byMember.get(key);
  if (channel === undefined) {
    channel = memberChannel(client, member, relayless);
    byMember.set(key, channel);
  }
  return channel;
}

function memberChannel(client: RpcClient, member: string, relayless: string): NodeChannel {
  return {
    get state() {
      return client.state;
    },
    onState: (listener) => client.onState(listener),
    call: <T>(method: string, params?: unknown, options?: { trace?: string }) =>
      client.call<T>("mesh.call", { node: member, method, params: params ?? {} }, options),
    subscribe(stream, options, onEvent): ClientSubscription {
      let inner: ClientSubscription | undefined;
      let disposed = false;
      void client.call<{ stream: string }>("mesh.relay", { node: member, stream }).then(
        ({ stream: relayed }) => {
          if (!disposed) inner = client.subscribe(relayed, options, onEvent);
        },
        (error: unknown) => {
          if (disposed) return;
          const code = (error as { code?: unknown }).code;
          options.onError?.(
            code === "COMMAND_NOT_FOUND"
              ? new RpcError({
                  code: ErrorCodes.METHOD_NOT_FOUND,
                  message: relayless,
                  data: { code: "RELAY_UNAVAILABLE" },
                })
              : error instanceof RpcError
                ? error
                : new RpcError({
                    code: ErrorCodes.SERVER_ERROR,
                    message: String(error),
                    data: { code: "INTERNAL" },
                  }),
          );
        },
      );
      return {
        // Until the relay is named, nothing was delivered: `after` is still the last seen.
        get lastSequence() {
          return inner?.lastSequence ?? options.after ?? 0;
        },
        dispose() {
          disposed = true;
          inner?.dispose();
        },
      };
    },
  };
}
