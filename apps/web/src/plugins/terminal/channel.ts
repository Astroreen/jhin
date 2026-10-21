import { ErrorCodes, RpcError, type ClientSubscription, type RpcClient } from "@jhin/rpc";

/**
 * What the terminal code talks to (D504): a connected node's client, or a
 * mesh member through it, with the same calls, subscriptions and the
 * connection's state.
 */
export type TerminalChannel = Pick<RpcClient, "state" | "onState" | "call" | "subscribe">;

const channels = new WeakMap<RpcClient, Map<string, TerminalChannel>>();

/** `client` itself, or the one channel to `member` through it: the same object every time. */
export function terminalChannel(client: RpcClient, member: string | undefined): TerminalChannel {
  if (member === undefined) return client;
  const byMember = channels.get(client) ?? new Map<string, TerminalChannel>();
  channels.set(client, byMember);
  let channel = byMember.get(member);
  if (channel === undefined) {
    channel = memberChannel(client, member);
    byMember.set(member, channel);
  }
  return channel;
}

/**
 * A member through `client`: its commands with `mesh.call`, its streams
 * through the connected node's relays (`mesh.relay`, D502).
 */
function memberChannel(client: RpcClient, member: string): TerminalChannel {
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
                  message: "This node cannot stream terminals of other nodes of its mesh",
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
