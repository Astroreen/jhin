import * as Crypto from "node:crypto";

import {
  AUTH_CLIENTS_STREAM,
  AUTH_VERIFIER_CAPABILITY,
  AuthEvents,
  OWNER_PRINCIPAL_ID,
  readCookie,
  sessionCookieName,
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
  createMemoryStreams,
  serveRpc,
  webSocketPeer,
  type WebSocketLike,
} from "@jhin/rpc";
import {
  PERMISSIONS_DESCRIBE_HOOK,
  definePlugin,
  z,
  type Disposable,
  type PermissionEntry,
} from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";
import { WebSocketServer, type WebSocket } from "ws";

import { onExpiry } from "./expiry.ts";

/** Path of the WebSocket endpoint on the node's HTTP server. */
export const RPC_PATH = "/rpc";

/** Tells clients to come back: used when this plugin stops or reloads. */
const CLOSE_SERVICE_RESTART = 1012;

const CONFIG_SECTION = "jhin.transport-ws";

/** `jhin.transport-ws` (security.md D418). */
export const TransportConfig = z
  .object({
    /** security.md D418. */
    allowedOrigins: z
      .array(
        z
          .string()
          .refine(
            (value) =>
              URL.canParse(value) &&
              /^https?:$/.test(new URL(value).protocol) &&
              ["", "/"].includes(new URL(value).pathname) &&
              new URL(value).search === "" &&
              new URL(value).hash === "",
            "must be an origin: scheme, host and port, e.g. https://jhin.example.com",
          )
          // Kept as an origin is compared: `https://Jhin.example.com/` is `https://jhin.example.com`.
          .transform((value) => new URL(value).origin),
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
 * Whether `requested` (a `Host` value: `name`, `name:port`, `[::1]:port`)
 * is the origin's host. Read with the origin's scheme, so a default port
 * written out (`node:443` for https) or left off is the same host.
 */
function sameHost(origin: URL, requested: string): boolean {
  // Only a host and a port: `good@evil`, `evil/x` or `evil?x` would parse as another host.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?$/i.test(requested)) return false;
  const target = `${origin.protocol}//${requested}`;
  return URL.canParse(target) && new URL(target).host === origin.host;
}

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
  /** Authenticated by the session cookie, which a browser sends from any page: never "any". */
  byCookie = false,
): boolean {
  if (origin === undefined) return true;
  const parsed = URL.canParse(origin) ? new URL(origin) : undefined;
  if (parsed === undefined) return false;
  if (requestedHost !== undefined && sameHost(parsed, requestedHost)) return true;
  if (allowed.length === 0) return !byCookie;
  return allowed.some((entry) => URL.canParse(entry) && new URL(entry).origin === parsed.origin);
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
    context.config.define(CONFIG_SECTION, TransportConfig);
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const sessionCookie = sessionCookieName(new URL(http.url).port);
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
    // The streams each permission guards, for clients granting it (security.md D1371):
    // the token plugin cannot read them itself (it is this plugin's dependency).
    context.subscriptions.add(
      context.hooks.after<unknown, PermissionEntry[]>(PERMISSIONS_DESCRIBE_HOOK, (entries) => {
        if (!Array.isArray(entries)) return entries;
        const guarded = new Map<string, string[]>();
        for (const { stream, permissions } of streams.permissions?.() ?? []) {
          for (const permission of permissions) {
            guarded.set(permission, [...(guarded.get(permission) ?? []), stream]);
          }
        }
        const listed = entries.map((entry) => {
          const named = guarded.get(entry.permission);
          guarded.delete(entry.permission);
          return named === undefined
            ? entry
            : { ...entry, streams: [...new Set([...(entry.streams ?? []), ...named])].toSorted() };
        });
        const only = [...guarded].map(([permission, named]) => ({
          permission,
          commands: [],
          streams: named.toSorted(),
        }));
        return [...listed, ...only];
      }),
    );
    // The token plugin cannot serve a stream of its own (this plugin depends on
    // its verifier), so its changes reach clients here (security.md D1188).
    const authClients = createMemoryStreams({ log: context.log });
    context.subscriptions.add(
      streams.serve(AUTH_CLIENTS_STREAM, authClients, { permissions: ["auth.read"] }),
    );
    context.events.on(AuthEvents.clientsChanged, () => {
      // Only "it changed" matters: the latest event is all a subscriber needs.
      // `clear` keeps the sequence counting, so the new event is above every old one.
      authClients.clear(AUTH_CLIENTS_STREAM);
      authClients.append(AUTH_CLIENTS_STREAM, AuthEvents.clientsChanged, {});
    });

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
        const { allowedOrigins } =
          context.config.get<z.output<typeof TransportConfig>>(CONFIG_SECTION);
        const origin = request.headers.origin;
        // A token in the subprotocol first; else the page's own session cookie (security.md D421).
        const offered = tokenFrom(request.headers["sec-websocket-protocol"]);
        const token = offered ?? readCookie(request.headers.cookie, sessionCookie);
        const byCookie = offered === undefined && token !== undefined;
        if (!originAllowed(origin, http.requestedHost(request), allowedOrigins, byCookie)) {
          // The header is the client's: logged short, never whole.
          // A hostile page may retry in a loop: kept out of the warnings.
          context.log.debug("connection refused: origin not allowed", {
            origin: origin === undefined ? undefined : origin.slice(0, 200),
            byCookie,
          });
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
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
