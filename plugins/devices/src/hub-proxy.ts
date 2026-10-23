// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/DeviceHubProxy.ts
// (the hub paths a client may reach, which of them change a device, the headers kept from the
// hub, the ticket that never travels on) and apps/server/src/auth/http.ts
// (`authenticateMediaRequest`: a short-lived ticket for `<img>` and WebSocket), on Jhin's
// `http.server@1` and `auth.verifier@1` instead of Effect's router. docs/plans/preview.md, D1208.
//
// The hub binds loopback and is never reachable directly: serve-sim exposes a shell-exec route
// and serve-emu's action routes are unauthenticated, so the only way to a device stream is
// through this route, which requires a caller with `devices.read` (`devices.write` for input
// and tuning).
import * as Crypto from "node:crypto";
import * as Http from "node:http";
import type { Duplex } from "node:stream";

import type { AuthVerifier } from "@jhin/auth-api";
import type { HttpServer } from "@jhin/http-api";
import { DEVICE_HUB_PATH } from "@jhin/preview-api";
import { missingPermissions, toDisposable, type Disposable } from "@jhin/sdk";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

const MUTABLE_PATHS: readonly RegExp[] = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings)$/,
  /^\/vendor\/serve-emu\/api\/fold$/,
];

/** The hub's WebSockets; `http.server@1` upgrades exact paths, so each is registered. */
const HUB_WS_PATHS = [
  "/api/devices/ws",
  "/vendor/serve-sim/helper/ws",
  "/vendor/serve-emu/ws",
] as const;

/**
 * The client's request headers the hub gets: what it needs to answer. Credentials, cookies,
 * the referer (which carries the ticket of an `<img>` URL), forwarding and hop-by-hop headers
 * stay at the node; `Origin` is rewritten to the hub's.
 */
const KEPT_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "pragma",
  "range",
  "user-agent",
]);

/** Past this much unsent data a relayed socket's client is too slow: it is closed to reconnect. */
const MAX_BUFFERED = 16 * 1024 * 1024;

/**
 * Whether a hub path is on the allow-list as written and once decoded: the hub decodes
 * before routing, so `helper/..%2fapi%2fexec/…` must not slip past `[^/]+`.
 */
function allowedPath(hubPath: string, patterns: readonly RegExp[]): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(hubPath);
  } catch {
    return false;
  }
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === ".." || part === ".")) {
    return false;
  }
  return [hubPath, decoded].every((path) => patterns.some((pattern) => pattern.test(path)));
}

/**
 * The hub's response headers a client gets: what describes the body and its caching. Cookies,
 * CORS and anything else the hub sets stay with the hub; the node's origin is the UI's.
 */
const KEPT_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "location",
  "retry-after",
]);

/** A mutating request's body is a small JSON setting or a screenshot request. */
const MAX_REQUEST_BODY = 1024 * 1024;

/** A close code a WebSocket may send: the hub's reserved or unknown ones become a normal close. */
const sendableCode = (code: number) =>
  (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
  (code >= 3000 && code <= 4999)
    ? code
    : 1000;

/** The query parameter a ticket travels in (T3's name). */
export const TICKET_PARAM = "wsTicket";
/** T3's WebSocket tickets last five minutes; a stream reconnecting asks for a fresh one. */
const TICKET_TTL_MS = 5 * 60_000;

const READ = ["devices.read"];
const CONTROL = ["devices.write"];

/**
 * `media` tickets ride in `<img>` and `EventSource` URLs (history, logs) and carry only
 * `devices.read`: watching, and T3's screenshot POST, which reads the screen;
 * `socket` tickets open the hub's WebSockets with the caller's grants and work for nothing else.
 */
export type TicketKind = "media" | "socket";

interface Ticket {
  readonly kind: TicketKind;
  readonly principal: string;
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}

const digest = (ticket: string) => Crypto.createHash("sha256").update(ticket).digest("hex");

/** Short-lived tickets for what cannot send a bearer header: `<img>`, `EventSource`, WebSocket. */
export function createTickets(now: () => number = Date.now) {
  /** By the SHA-256 of the ticket; the ticket itself is never kept. */
  const issued = new Map<string, Ticket>();
  const sweep = () => {
    for (const [key, ticket] of issued) if (ticket.expiresAt <= now()) issued.delete(key);
  };
  return {
    issue(caller: { id: string; permissions: readonly string[] }, kind: TicketKind) {
      sweep();
      const ticket = Crypto.randomBytes(32).toString("base64url");
      const expiresAt = now() + TICKET_TTL_MS;
      const permissions =
        kind === "socket"
          ? [...caller.permissions]
          : missingPermissions(caller.permissions, READ).length === 0
            ? READ
            : [];
      issued.set(digest(ticket), { kind, principal: caller.id, permissions, expiresAt });
      return { ticket, expiresAt };
    },
    verify(ticket: string, kind: TicketKind): Ticket | undefined {
      sweep();
      const found = issued.get(digest(ticket));
      if (found === undefined || found.expiresAt <= now() || found.kind !== kind) return undefined;
      return found;
    },
    /** A socket ticket opens one socket: a client that reconnects asks for a fresh one. */
    consume(ticket: string): void {
      issued.delete(digest(ticket));
    },
    /** A revoked token's tickets go with it (security.md D414). */
    revoke(principal?: string) {
      for (const [key, ticket] of issued) {
        if (principal === undefined || ticket.principal === principal) issued.delete(key);
      }
    },
  };
}

export interface HubProxyOptions {
  readonly http: HttpServer;
  readonly verifier: AuthVerifier;
  readonly tickets: ReturnType<typeof createTickets>;
  /** The running hub's origin, or undefined when none runs (503, as T3 answers). */
  readonly origin: () => string | undefined;
}

const bearer = (request: Http.IncomingMessage) => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length).trim() : undefined;
};

/**
 * `<node>/device-hub/*` → the hub, for authenticated callers: a bearer token
 * (`auth.verifier@1`) or a ticket from `device.hub.access`.
 */
export function serveHubProxy(options: HubProxyOptions): Disposable & {
  /** Closes the proxied sockets of a principal whose token went, or of everyone. */
  drop(principal?: string): void;
} {
  const { http, verifier, tickets } = options;
  const sockets = new Map<WebSocket, string>();
  /** Proxied HTTP responses in flight (MJPEG and AVCC run for hours), by their principal. */
  const streams = new Map<Http.ServerResponse, string>();
  const server = new WebSocketServer({ noServer: true });

  const authenticate = async (
    request: Http.IncomingMessage,
    url: URL,
    kind: TicketKind,
  ): Promise<{ id: string; permissions: readonly string[] } | undefined> => {
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket !== null && ticket.trim() !== "") {
      const found = tickets.verify(ticket, kind);
      return found === undefined
        ? undefined
        : { id: found.principal, permissions: found.permissions };
    }
    const token = bearer(request);
    if (token === undefined) return undefined;
    const principal = await verifier.verify({ token });
    return principal === undefined
      ? undefined
      : { id: principal.id, permissions: principal.permissions };
  };

  /** The hub's path and the query it gets: the ticket authenticates here and stays here. */
  const upstream = (url: URL) => {
    const hubPath = url.pathname.slice(DEVICE_HUB_PATH.length) || "/";
    const search = new URLSearchParams(url.search);
    search.delete(TICKET_PARAM);
    search.delete("hostId");
    return `${hubPath}${search.size > 0 ? `?${search.toString()}` : ""}`;
  };

  const forwardHeaders = (request: Http.IncomingMessage, origin: string) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!KEPT_REQUEST_HEADERS.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    // serve-emu refuses mutations whose Origin differs from the request origin.
    if (request.headers.origin !== undefined) headers.origin = origin;
    return headers;
  };

  const text = (response: Http.ServerResponse, status: number, body: string) => {
    if (response.headersSent) return void response.end();
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(body);
  };

  const handle = async (request: Http.IncomingMessage, response: Http.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const hubPath = url.pathname.slice(DEVICE_HUB_PATH.length) || "/";
    if (!allowedPath(hubPath, ALLOWED_PATHS)) return text(response, 404, "Not Found");
    const readOnly = request.method === "GET" || request.method === "HEAD";
    if (!readOnly && !allowedPath(hubPath, MUTABLE_PATHS)) {
      return text(response, 405, "Method Not Allowed");
    }
    // T3's rule: changing a stream or the fold drives the device; a screenshot POST only reads
    // the screen, so it is watching (`devices.read`).
    const controlsDevice = !readOnly && /\/api\/(stream-(mode|settings)|fold)$/.test(hubPath);
    const caller = await authenticate(request, url, "media");
    if (caller === undefined) {
      response.setHeader("www-authenticate", "Bearer");
      return text(response, 401, "Unauthorized");
    }
    if (missingPermissions(caller.permissions, controlsDevice ? CONTROL : READ).length > 0) {
      return text(response, 403, "Forbidden");
    }
    const origin = options.origin();
    if (origin === undefined) return text(response, 503, "Device hub is not running");
    const outgoing = Http.request(`${origin}${upstream(url)}`, {
      method: request.method,
      headers: forwardHeaders(request, origin),
    });
    // A client that goes away ends a long-lived MJPEG or AVCC response upstream too.
    streams.set(response, caller.id);
    response.once("close", () => {
      streams.delete(response);
      outgoing.destroy();
    });
    outgoing.once("error", () => text(response, 502, "Device hub did not answer"));
    outgoing.once("response", (answer) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (!KEPT_RESPONSE_HEADERS.has(name) || value === undefined) continue;
        headers[name] = value;
      }
      // Long-lived MJPEG and AVCC responses must not be buffered by compression.
      headers["cache-control"] = "no-store, no-transform";
      // A redirect inside the hub stays under the node's hub path; one elsewhere is dropped,
      // so the hub's loopback origin never reaches a client.
      const location = answer.headers.location;
      delete headers.location;
      if (location !== undefined) {
        const target = URL.canParse(location, origin) ? new URL(location, origin) : undefined;
        if (target?.origin === new URL(origin).origin) {
          headers.location = `${DEVICE_HUB_PATH}${target.pathname}${target.search}`;
        }
      }
      response.writeHead(answer.statusCode ?? 502, headers);
      // A hub that dies mid-stream ends the client's response too, so the stream reconnects.
      answer.once("close", () => {
        if (!answer.complete) response.destroy();
      });
      answer.pipe(response);
    });
    if (readOnly) {
      outgoing.end();
      return;
    }
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BODY) return;
      request.unpipe(outgoing);
      outgoing.destroy();
      response.setHeader("connection", "close");
      // Nothing more of the upload is read once the 413 is out.
      response.once("finish", () => request.destroy());
      text(response, 413, "Payload Too Large");
    });
    // A client that aborts its upload ends the hub's side too.
    request.once("error", () => outgoing.destroy());
    request.once("aborted", () => outgoing.destroy());
    request.pipe(outgoing);
  };

  const refuse = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  /** Closes a socket with a code it may send; a socket that cannot close is ended. */
  const close = (socket: WebSocket, code: number, reason: Buffer) => {
    try {
      socket.close(sendableCode(code), reason.subarray(0, 123));
    } catch {
      socket.terminate();
    }
  };

  /** Frames go both ways as they are; whichever side closes first closes the other. */
  const pump = (client: WebSocket, hub: WebSocket) => {
    const forward = (to: WebSocket) => (data: RawData, isBinary: boolean) => {
      if (to.readyState !== WebSocket.OPEN) return;
      // Dropping video frames would corrupt H.264; a client that cannot keep up reconnects.
      if (to.bufferedAmount > MAX_BUFFERED) {
        close(to, 1013, Buffer.from("too slow"));
        return;
      }
      to.send(data, { binary: isBinary });
    };
    client.on("message", forward(hub));
    hub.on("message", forward(client));
    client.once("close", (code, reason) => {
      if (hub.readyState === WebSocket.CONNECTING) hub.terminate();
      else close(hub, code, reason);
    });
    hub.once("close", (code, reason) => close(client, code, reason));
    client.once("error", () => hub.terminate());
    hub.once("error", () => client.terminate());
  };

  const upgrade = (request: Http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Until the hub's socket is handed to the client, a client that resets or leaves must
    // neither throw nor leave the hub's side open.
    let hub: WebSocket | undefined;
    const ignore = () => undefined;
    const gone = () => hub?.terminate();
    socket.on("error", ignore);
    socket.once("close", gone);
    const settle = () => {
      socket.off("error", ignore);
      socket.off("close", gone);
    };
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const hubPath = url.pathname.slice(DEVICE_HUB_PATH.length);
      // One rule with the HTTP side, whatever paths `http.server@1` hands over.
      if (!(HUB_WS_PATHS as readonly string[]).includes(hubPath)) {
        return refuse(socket, "404 Not Found");
      }
      const caller = await authenticate(request, url, "socket");
      if (caller === undefined) return refuse(socket, "401 Unauthorized");
      // Every socket but the device list's carries input; serve-emu's carries the video too,
      // so watching an Android Emulator needs devices.write, as T3 needs its operate scope.
      const required = hubPath === "/api/devices/ws" ? READ : CONTROL;
      if (missingPermissions(caller.permissions, required).length > 0) {
        return refuse(socket, "403 Forbidden");
      }
      // Spent only once it is good for this socket.
      const ticket = url.searchParams.get(TICKET_PARAM);
      if (ticket !== null && ticket.trim() !== "") tickets.consume(ticket);
      const origin = options.origin();
      if (origin === undefined) return refuse(socket, "503 Service Unavailable");
      if (socket.destroyed) return;
      const upstreamSocket = new WebSocket(`${origin.replace(/^http/, "ws")}${upstream(url)}`, {
        headers: forwardHeaders(request, origin),
      });
      hub = upstreamSocket;
      // The hub must accept before the client is: a refused hub refuses the client.
      upstreamSocket.once("unexpected-response", () => {
        upstreamSocket.terminate();
        refuse(socket, "502 Bad Gateway");
      });
      upstreamSocket.once("error", () => {
        if (upstreamSocket.readyState !== WebSocket.OPEN) refuse(socket, "502 Bad Gateway");
      });
      upstreamSocket.once("open", () => {
        if (socket.destroyed) {
          upstreamSocket.terminate();
          return;
        }
        settle();
        server.handleUpgrade(request, socket, head, (client) => {
          sockets.set(client, caller.id);
          client.once("close", () => sockets.delete(client));
          pump(client, upstreamSocket);
        });
      });
    })().catch(() => refuse(socket, "500 Internal Server Error"));
  };

  const registrations: Disposable[] = [
    ...["GET", "HEAD", "POST", "PUT", "DELETE"].map((method) =>
      http.route(method, `${DEVICE_HUB_PATH}/*`, (request, response) =>
        handle(request, response).catch(() => text(response, 500, "Internal Server Error")),
      ),
    ),
    ...HUB_WS_PATHS.map((path) => http.upgrade(`${DEVICE_HUB_PATH}${path}`, upgrade)),
  ];
  const disposable = toDisposable(() => {
    for (const registration of registrations) registration.dispose();
    for (const socket of sockets.keys()) socket.close(1012, "device hub proxy restarting");
    for (const response of streams.keys()) response.destroy();
    server.close();
  });
  return {
    dispose: () => disposable.dispose(),
    drop(principal) {
      for (const [socket, owner] of sockets) {
        if (principal === undefined || owner === principal) socket.close(4401, "token revoked");
      }
      // A video feed ends too: what a token opened goes with it (security.md D414).
      for (const [response, owner] of streams) {
        if (principal === undefined || owner === principal) response.destroy();
      }
    },
  };
}
