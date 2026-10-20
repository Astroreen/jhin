import * as Crypto from "node:crypto";

import {
  AUTH_VERIFIER_CAPABILITY,
  AuthEvents,
  OWNER_PRINCIPAL_ID,
  type AuthVerifier,
} from "@jhin/auth-api";
import { HOST_TRACE_CAPABILITY, type HostTrace } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import {
  CLOSE_UNAUTHENTICATED,
  LIVE_STREAMS_CAPABILITY,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  createLiveStreams,
  serveRpc,
  webSocketPeer,
  type WebSocketLike,
} from "@jhin/rpc";
import { definePlugin, type Disposable } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";
import { WebSocketServer, type WebSocket } from "ws";

import { onExpiry } from "./expiry.ts";

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
    /** Open connections and whom each acts as (undefined until its token is checked). */
    const sockets = new Map<WebSocket, string | undefined>();
    const closeAll = (principal: string, reason: string) => {
      for (const [socket, owner] of sockets) {
        if (owner === principal) socket.close(CLOSE_UNAUTHENTICATED, reason);
      }
    };
    // Streams other plugins keep in memory (terminal output), next to the event log's.
    const streams = createLiveStreams();
    context.services.provide(LIVE_STREAMS_CAPABILITY, streams);

    // Only the protocol is echoed back, never the token subprotocol.
    const server = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    });

    async function accept(socket: WebSocket, token: string | undefined): Promise<void> {
      sockets.set(socket, undefined);
      let expiry: Disposable | undefined;
      socket.on("close", () => {
        sockets.delete(socket);
        expiry?.dispose();
      });
      const caller = await verifier.verify(token === undefined ? {} : { token });
      if (caller === undefined) {
        context.log.warn("connection refused: bad or missing token");
        socket.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
        return;
      }
      if (!sockets.has(socket)) return;
      sockets.set(socket, caller.id);
      // A token that expires drops its connection then, as a revoked one does (security.md D414).
      if (caller.expiresAt !== undefined) {
        expiry = onExpiry(caller.expiresAt, () =>
          socket.close(CLOSE_UNAUTHENTICATED, "token expired"),
        );
      }
      context.log.info("client connected", { caller: caller.id, clients: sockets.size });
      serveRpc(webSocketPeer(socket as unknown as WebSocketLike), {
        execute: (name, input, invocation) => context.commands.execute(name, input, invocation),
        caller,
        ...(log === undefined ? {} : { log }),
        streams,
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
    // A rotated owner token drops the owner's connections; a revoked device token, its own.
    context.events.on(AuthEvents.tokenRotated, () => closeAll(OWNER_PRINCIPAL_ID, "token rotated"));
    context.events.on(AuthEvents.clientRevoked, (payload) => {
      const principal = (payload as { principal?: unknown } | undefined)?.principal;
      if (typeof principal === "string") closeAll(principal, "token revoked");
    });
    context.subscriptions.add({
      dispose() {
        for (const socket of sockets.keys()) {
          socket.close(CLOSE_SERVICE_RESTART, "transport restarting");
        }
        server.close();
      },
    });
    context.log.info("rpc endpoint ready", {
      url: `${http.url.replace(/^http/, "ws")}${RPC_PATH}`,
    });
  },
});
