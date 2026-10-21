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
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";
import { WebSocketServer, type WebSocket } from "ws";

import { onExpiry } from "./expiry.ts";

/** Path of the WebSocket endpoint on the node's HTTP server. */
export const RPC_PATH = "/rpc";

/** Tells clients to come back: used when this plugin stops or reloads. */
const CLOSE_SERVICE_RESTART = 1012;

const CONFIG_SECTION = "jhin.transport-ws";

const Config = z
  .object({
    /** security.md D418. */
    allowedOrigins: z
      .array(
        z
          .string()
          .refine(
            (value) => URL.canParse(value) && new URL(value).origin === value.replace(/\/$/, ""),
            "must be an origin: scheme, host and port, e.g. https://jhin.example.com",
          ),
      )
      .default([])
      .meta({
        title: "Allowed origins",
        description:
          "Web pages on other origins that may connect with a token, e.g. a jhin client page. While empty, a page on any origin may connect with a token; the node's own pages always may.",
        examples: ["https://jhin.example.com"],
        advanced: true,
      }),
  })
  .default({ allowedOrigins: [] })
  .meta({ title: "Browser access", description: "Which web pages may connect to this node." });

/**
 * Whether a browser page may open a connection (security.md D418). A request
 * without `Origin` is not a browser's (the CLI, another node). The node's own
 * pages are always allowed, recognised by host and port alone (T3's rule): behind
 * a TLS proxy the page is `https` while the node speaks `http`. Other pages only
 * while no origin is listed, or when listed, compared by scheme, host and port.
 */
export function originAllowed(
  origin: string | undefined,
  requestedHost: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  const parsed = URL.canParse(origin) ? new URL(origin) : undefined;
  if (parsed === undefined) return false;
  if (requestedHost !== undefined && parsed.host === requestedHost) return true;
  if (allowed.length === 0) return true;
  return allowed.some((entry) => new URL(entry).origin === parsed.origin);
}

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
    context.config.define(CONFIG_SECTION, Config);
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const verifier = context.services.get<AuthVerifier>(AUTH_VERIFIER_CAPABILITY);
    const log = context.services.tryGet<EventLog>(EVENTLOG_CAPABILITY);
    const trace = context.services.tryGet<HostTrace>(HOST_TRACE_CAPABILITY);
    /** Open connections and whom each acts as (undefined until its token is checked). */
    const sockets = new Map<WebSocket, string | undefined>();
    /**
     * Principals revoked while some token was still being checked: a socket
     * whose check ends after the revoke is closed then (security.md D414).
     */
    let checking = 0;
    let revocations = 0;
    const revokedWhileChecking: { readonly seq: number; readonly principal: string }[] = [];
    const closeAll = (principal: string, reason: string) => {
      if (checking > 0) revokedWhileChecking.push({ seq: ++revocations, principal });
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
      checking++;
      const since = revocations;
      let caller: Awaited<ReturnType<AuthVerifier["verify"]>>;
      let revoked = false;
      try {
        caller = await verifier.verify(token === undefined ? {} : { token });
      } finally {
        checking--;
      }
      if (caller !== undefined) {
        const id = caller.id;
        revoked = revokedWhileChecking.some((entry) => entry.seq > since && entry.principal === id);
      }
      if (checking === 0) revokedWhileChecking.length = 0;
      if (caller === undefined || revoked) {
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
        const { allowedOrigins } = context.config.get<z.output<typeof Config>>(CONFIG_SECTION);
        const origin = request.headers.origin;
        if (!originAllowed(origin, http.requestedHost(request), allowedOrigins)) {
          // The header is the client's: logged short, never whole.
          // A hostile page may retry in a loop: kept out of the warnings.
          context.log.debug("connection refused: origin not allowed", {
            origin: origin === undefined ? undefined : origin.slice(0, 200),
          });
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
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
