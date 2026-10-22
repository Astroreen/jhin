import { webSocketPeer, type Peer, type WebSocketLike } from "./peer.ts";
import { PROTOCOL, RPC_READY, TOKEN_PROTOCOL_PREFIX } from "./protocol.ts";

/** Close code a server uses when the token is missing or wrong. */
export const CLOSE_UNAUTHENTICATED = 4401;

type WebSocketConstructor = new (
  url: string,
  protocols: string[],
) => WebSocketLike & {
  addEventListener(type: "open" | "error", listener: () => void): void;
};

/**
 * Opens a WebSocket to a Jhin node and resolves with a peer once it is open.
 * Rejects with `code: "UNAUTHENTICATED"` when the node refuses the token.
 */
export function connectWebSocket(
  url: string,
  token: string | undefined,
  WebSocketImpl: WebSocketConstructor = (
    globalThis as unknown as { WebSocket: WebSocketConstructor }
  ).WebSocket,
): Promise<Peer> {
  const protocols =
    token === undefined ? [PROTOCOL] : [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`];
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url, protocols);
    let settled = false;
    socket.addEventListener("open", () => {
      // The node checks the token after the handshake: it either sends rpc.ready
      // first or closes with 4401. Only rpc.ready makes the peer usable.
      const peer = webSocketPeer(socket);
      const first = peer.onMessage((text) => {
        first.dispose();
        if (settled) return;
        settled = true;
        if ((JSON.parse(text) as { method?: unknown }).method === RPC_READY) resolve(peer);
        else {
          peer.close(1002, "expected rpc.ready");
          reject(
            Object.assign(new Error("Server did not send rpc.ready"), { code: "CONNECT_FAILED" }),
          );
        }
      });
    });
    socket.addEventListener("close", (event) => {
      if (settled) return;
      settled = true;
      reject(
        Object.assign(
          new Error(
            event.code === CLOSE_UNAUTHENTICATED
              ? "Token refused"
              : `WebSocket closed (${event.code})`,
          ),
          {
            code: event.code === CLOSE_UNAUTHENTICATED ? "UNAUTHENTICATED" : "CONNECT_FAILED",
          },
        ),
      );
    });
    socket.addEventListener("error", () => undefined);
  });
}
