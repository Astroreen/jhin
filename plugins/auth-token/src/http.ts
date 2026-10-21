import type { IncomingMessage, ServerResponse } from "node:http";

import { readCookie, sessionCookieName, type Principal } from "@jhin/auth-api";
import type { HttpServer } from "@jhin/http-api";
import { DisposableStore, z, type Disposable, type Logger } from "@jhin/sdk";

// The pairing endpoints follow T3 Code's (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/auth/http.ts — a one-time code becomes a token over HTTP,
// answers are never cached, and the page's own session is an httpOnly cookie.

const MAX_BODY = 16 * 1024;
/** Codes are 60 bits of randomness; this only keeps guessing and floods cheap to refuse. */
const ATTEMPTS_PER_MINUTE = 20;

const PairRequest = z.object({
  code: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(200).optional(),
});
const SessionRequest = z.object({ credential: z.string().min(1).max(512) });

/** What the routes need from the plugin. */
export interface AuthHttpOptions {
  readonly http: HttpServer;
  readonly log: Logger;
  /** A pairing code becomes a device token, or undefined for a wrong, used or expired code. */
  pair(code: string, label: string | undefined): IssuedToken | undefined;
  /** A token or pairing code becomes the page's own device token (security.md D421). */
  openSession(credential: string): Promise<IssuedToken | undefined>;
  /** Who a token is, as the verifier sees it. */
  verify(token: string): Promise<Principal | undefined>;
  /** Revokes the device token behind a session cookie. */
  closeSession(token: string): void;
}

interface IssuedToken {
  readonly id: string;
  readonly token: string;
  readonly permissions: readonly string[];
  readonly expiresAt?: number;
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) request.destroy(new Error("Body too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    })
    .end(JSON.stringify(body));
}

/** A page on another origin may pair (D420): without credentials, so no cookie rides along. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

/** The node's own page asks: no `Origin` (not a browser), or one whose host is the node's. */
function ownPage(http: HttpServer, request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (!URL.canParse(origin)) return false;
  return new URL(origin).host === http.requestedHost(request);
}

export function serveAuthHttp(options: AuthHttpOptions): Disposable {
  const { http, log } = options;
  const store = new DisposableStore();
  const cookie = sessionCookieName(new URL(http.url).port);
  const attempts = new Map<string, number>();

  /** False (and answered with 429) once a client tried too often this minute. */
  const admit = (route: string, request: IncomingMessage, response: ServerResponse): boolean => {
    const minute = Math.floor(Date.now() / 60_000);
    // One bucket per route: a signed-in page never spends a pairing device's attempts.
    const key = `${route}:${http.clientAddress(request)}:${minute}`;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    for (const old of attempts.keys()) if (!old.endsWith(`:${minute}`)) attempts.delete(old);
    if (count <= ATTEMPTS_PER_MINUTE) return true;
    send(
      response,
      429,
      { code: "TOO_MANY_PAIRING_ATTEMPTS", message: "Try again in a minute" },
      { ...CORS, "retry-after": "60" },
    );
    return false;
  };

  const cookieHeader = (value: string, request: IncomingMessage, maxAge?: number) => {
    const secure =
      request.headers["x-forwarded-proto"] === "https" ||
      (request.socket as { encrypted?: boolean }).encrypted === true;
    return [
      `${cookie}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
      ...(secure ? ["Secure"] : []),
    ].join("; ");
  };

  store.add(
    http.route("OPTIONS", "/auth/pair", (_request, response) => {
      response.writeHead(204, CORS).end();
    }),
  );
  store.add(
    http.route("POST", "/auth/pair", async (request, response) => {
      if (!admit("pair", request, response)) return;
      const parsed = PairRequest.safeParse(await readJson(request).catch(() => undefined));
      if (!parsed.success) {
        send(response, 400, { code: "INVALID", message: "Expected { code, label? }" }, CORS);
        return;
      }
      const issued = options.pair(parsed.data.code, parsed.data.label);
      if (issued === undefined) {
        log.warn("pairing refused: wrong, used or expired code", {
          client: http.clientAddress(request),
        });
        send(
          response,
          401,
          {
            code: "PAIRING_CODE_INVALID",
            message:
              "This pairing code is wrong, was already used or has expired. Request a new pairing link.",
          },
          CORS,
        );
        return;
      }
      send(response, 200, issued, CORS);
    }),
  );

  store.add(
    http.route("POST", "/auth/session", async (request, response) => {
      if (!admit("session", request, response)) return;
      if (!ownPage(http, request)) {
        send(response, 403, {
          code: "ORIGIN_NOT_ALLOWED",
          message: "Browser sessions are only accepted from the node's own pages.",
        });
        return;
      }
      const parsed = SessionRequest.safeParse(await readJson(request).catch(() => undefined));
      if (!parsed.success) {
        send(response, 400, { code: "INVALID", message: "Expected { credential }" });
        return;
      }
      const issued = await options.openSession(parsed.data.credential);
      if (issued === undefined) {
        send(response, 401, {
          code: "CREDENTIAL_INVALID",
          message: "This token or pairing code is not valid here. Request a new pairing link.",
        });
        return;
      }
      const maxAge =
        issued.expiresAt === undefined
          ? undefined
          : Math.max(0, Math.floor((issued.expiresAt - Date.now()) / 1000));
      // The token goes into the cookie only: the page never sees it.
      const { token, ...visible } = issued;
      send(
        response,
        200,
        { authenticated: true, ...visible },
        {
          "set-cookie": cookieHeader(token, request, maxAge),
        },
      );
    }),
  );

  store.add(
    http.route("GET", "/auth/session", async (request, response) => {
      const token = readCookie(request.headers.cookie, cookie);
      const principal = token === undefined ? undefined : await options.verify(token);
      if (principal === undefined) {
        send(response, 401, { authenticated: false });
        return;
      }
      send(response, 200, {
        authenticated: true,
        permissions: principal.permissions,
        ...(principal.expiresAt === undefined ? {} : { expiresAt: principal.expiresAt }),
      });
    }),
  );

  store.add(
    http.route("DELETE", "/auth/session", (request, response) => {
      if (!ownPage(http, request)) {
        send(response, 403, { code: "ORIGIN_NOT_ALLOWED", message: "Not this node's page" });
        return;
      }
      const token = readCookie(request.headers.cookie, cookie);
      if (token !== undefined) options.closeSession(token);
      send(response, 200, { authenticated: false }, { "set-cookie": cookieHeader("", request, 0) });
    }),
  );

  return store;
}
