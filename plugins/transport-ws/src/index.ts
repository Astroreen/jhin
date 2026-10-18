import * as Crypto from "node:crypto";

import { AUTH_VERIFIER_CAPABILITY, type AuthVerifier } from "@jhin/auth-api";
import { HOST_TRACE_CAPABILITY, type HostTrace } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import {
  CLOSE_UNAUTHENTICATED,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  serveRpc,
  webSocketPeer,
  type WebSocketLike,
} from "@jhin/rpc";
import { definePlugin } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";
import { WebSocketServer, type WebSocket } from "ws";

/** Path of the WebSocket endpoint on the node's HTTP server. */
export const RPC_PATH = "/rpc";

/** Tells clients to come back: used when this plugin stops or reloads. */
const CLOSE_SERVICE_RESTART = 1012;

function tokenFrom(header: string | string[] | undefined): string | undefined {
  const protocols = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",");
  for (const protocol of protocols) {
    const value = protocol.trim();
    if (value.startsWith(TOKEN_PROTOCOL_PREFIX)) return value.slice(TOKEN_PROTOCOL_PREFIX.length);
  }
  return undefined;
}

export default definePlugin({
  activate(context) {
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const verifier = context.services.get<AuthVerifier>(AUTH_VERIFIER_CAPABILITY);
    const log = context.services.tryGet<EventLog>(EVENTLOG_CAPABILITY);
    const trace = context.services.tryGet<HostTrace>(HOST_TRACE_CAPABILITY);
    const sockets = new Set<WebSocket>();

    // Only the protocol is echoed back, never the token subprotocol.
    const server = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    });

    async function accept(socket: WebSocket, token: string | undefined): Promise<void> {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const caller = await verifier.verify(token === undefined ? {} : { token });
      if (caller === undefined) {
        context.log.warn("connection refused: bad or missing token");
        socket.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
        return;
      }
      context.log.info("client connected", { caller: caller.id, clients: sockets.size });
      serveRpc(webSocketPeer(socket as unknown as WebSocketLike), {
        execute: (name, input, invocation) => context.commands.execute(name, input, invocation),
        caller,
        ...(log === undefined ? {} : { log }),
        hello: () => ({ protocol: PROTOCOL }),
        newTraceId: () => Crypto.randomUUID(),
        ...(trace === undefined ? {} : { traced: (traceId, work) => trace.run(traceId, work) }),
        logger: context.log,
      });
    }

    context.subscriptions.add(
      http.upgrade(RPC_PATH, (request, socket, head) => {
        const token = tokenFrom(request.headers["sec-websocket-protocol"]);
        server.handleUpgrade(request, socket, head, (ws) => {
          void accept(ws, token).catch((error: unknown) => {
            context.log.error("connection setup failed", { error: String(error) });
            ws.close(1011, "internal error");
          });
        });
      }),
    );
    context.events.on("auth.token.rotated", () => {
      for (const socket of sockets) socket.close(CLOSE_UNAUTHENTICATED, "token rotated");
    });
    context.subscriptions.add({
      dispose() {
        for (const socket of sockets) socket.close(CLOSE_SERVICE_RESTART, "transport restarting");
        server.close();
      },
    });
    context.log.info("rpc endpoint ready", {
      url: `${http.url.replace(/^http/, "ws")}${RPC_PATH}`,
    });
  },
});
