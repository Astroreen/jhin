import type { IncomingMessage, ServerResponse } from "node:http";

import {
  deriveClientMetadata,
  readCookie,
  sessionCookieName,
  type ClientMetadata,
  type Principal,
} from "@jhin/auth-api";
import type { HttpServer } from "@jhin/http-api";
import { DisposableStore, z, type Disposable, type Logger } from "@jhin/sdk";

import { verifyDpopProof, type ReplayGuard } from "./dpop.ts";
import { DeviceType } from "./metadata.ts";

// The pairing endpoints follow T3 Code's (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/auth/http.ts — a one-time code becomes a token over HTTP,
// answers are never cached, and the page's own session is an httpOnly cookie.

const MAX_BODY = 16 * 1024;
/**
 * Failed attempts per client address in one clock minute (a fixed window, so
 * up to twice this across a minute's edge). Codes are 60 bits of randomness;
 * this only keeps guessing and floods cheap to refuse.
 */
const ATTEMPTS_PER_MINUTE = 20;

const PairRequest = z.object({
  code: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(200).optional(),
  /** What the device says it is (T3's presented metadata, security.md D1187). */
  deviceType: DeviceType.optional(),
  os: z.string().trim().min(1).max(64).optional(),
});
const SessionRequest = z.object({ credential: z.string().min(1).max(512) });

/** What the routes need from the plugin. */
export interface AuthHttpOptions {
  readonly http: HttpServer;
  readonly log: Logger;
  /**
   * Failed attempts per route, client address and minute. The plugin keeps it
   * in its kernel-scoped state, so a reload does not reset the limit.
   */
  readonly attempts: Map<string, number>;
  /**
   * A pairing code becomes a device token, or undefined for a wrong, used or
   * expired code; bound to the key with thumbprint `jkt` when given (D1366).
   */
  pair(
    code: string,
    label: string | undefined,
    metadata: ClientMetadata,
    jkt?: string,
  ): IssuedToken | undefined;
  /** The DPoP proofs seen (D1366), in the plugin's kernel-scoped state. */
  readonly replay: ReplayGuard;
  /**
   * A device token that may ask for a WebSocket ticket (D1367): its key's
   * thumbprint when bound, and how to mint one (undefined when too many are open).
   */
  ticket(token: string):
    | {
        readonly jkt?: string;
        /** At its cap of open tickets: refused before its proof is spent. */
        full(): boolean;
        issue(): { ticket: string; expiresAt: number } | undefined;
      }
    | undefined;
  /** A token or pairing code becomes the page's own device token (security.md D421). */
  openSession(credential: string, metadata: ClientMetadata): Promise<IssuedToken | undefined>;
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
  /** `DPoP` for a token bound to a key (D1366), else `Bearer`. */
  readonly tokenType?: "DPoP" | "Bearer";
}

class BodyTooLarge extends Error {}

/** One header's value. Node joins a repeated one with ", ", which no proof parses as. */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The body as JSON. Past `MAX_BODY` it stops at once with `BodyTooLarge`; the
 * caller answers 413 and the connection is closed, so nothing more is read.
 */
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) {
        chunks.push(chunk);
        return;
      }
      request.off("data", onData);
      request.pause();
      reject(new BodyTooLarge());
    };
    request.on("data", onData);
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
  "access-control-allow-headers": "content-type, authorization, dpop",
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
  const { attempts } = options;

  /** False (and answered with 429) once a client tried too often this minute. */
  const bucket = (route: string, request: IncomingMessage) =>
    `${route}:${http.clientAddress(request)}:${Math.floor(Date.now() / 60_000)}`;
  /**
   * False (and answered with 429) once a client failed too often this
   * minute. An admitted attempt counts at once, as a failure until it
   * succeeds (`succeeded` takes it back from the bucket it counted in), so parallel requests cannot all
   * pass before the first failure is counted.
   */
  const admit = (
    route: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): string | undefined => {
    const key = bucket(route, request);
    const minute = key.slice(key.lastIndexOf(":"));
    for (const old of attempts.keys()) if (!old.endsWith(minute)) attempts.delete(old);
    const count = attempts.get(key) ?? 0;
    if (count < ATTEMPTS_PER_MINUTE) {
      attempts.set(key, count + 1);
      return key;
    }
    send(
      response,
      429,
      {
        code:
          route === "pair"
            ? "TOO_MANY_PAIRING_ATTEMPTS"
            : route === "ticket"
              ? "TOO_MANY_TICKET_ATTEMPTS"
              : "TOO_MANY_SESSION_ATTEMPTS",
        message: "Try again in a minute",
      },
      // Only the pairing and ticket endpoints answer other origins (D420, D1367).
      { ...(route === "session" ? {} : CORS), "retry-after": "60" },
    );
    return undefined;
  };
  /** A pairing or sign-in that worked: its attempt, in the bucket it counted in, is no failure. */
  const succeeded = (key: string) => {
    const count = attempts.get(key) ?? 0;
    if (count > 0) attempts.set(key, count - 1);
  };

  /**
   * A proof for this request (D1366), as `verifyDpopProof` judges it. Only a
   * proof for a bound token's ticket is remembered against replay: a pairing
   * code is used once anyway, and a replayed pairing proof binds the token to
   * its author's key, worth nothing to whoever replays it. So nobody without
   * a token can fill the guard.
   */
  const checkProof = (
    request: IncomingMessage,
    proof: string | undefined,
    expected: { expectedThumbprint?: string; accessToken?: string } = {},
  ) =>
    verifyDpopProof({
      proof,
      method: request.method ?? "POST",
      host: http.requestedHost(request),
      path: new URL(request.url ?? "/", "http://node").pathname,
      nowSeconds: Math.floor(Date.now() / 1000),
      ...(expected.expectedThumbprint === undefined ? {} : { replay: options.replay }),
      ...expected,
    });
  /** Refuses a proof, saying why in RFC 9449's words (`invalid_dpop_proof`). */
  const refuseProof = (
    response: ServerResponse,
    failure: string,
    headers: Record<string, string>,
    status = 400,
  ) =>
    send(
      response,
      failure === "busy" ? 503 : status,
      {
        code: failure === "busy" ? "DPOP_BUSY" : "DPOP_PROOF_INVALID",
        message:
          failure === "busy"
            ? "The node is checking too many proofs; try again in a minute"
            : `The DPoP proof was refused (${failure}).`,
      },
      failure === "busy"
        ? { ...headers, "retry-after": "60" }
        : { ...headers, "www-authenticate": `DPoP algs="ES256", error="invalid_dpop_proof"` },
    );

  /** What the request says about the device (security.md D1187). */
  const metadataOf = (
    request: IncomingMessage,
    presented?: { deviceType?: ClientMetadata["deviceType"]; os?: string },
  ) =>
    deriveClientMetadata({
      userAgent: request.headers["user-agent"],
      ipAddress: http.clientAddress(request),
      ...(presented === undefined ? {} : { presented }),
    });

  const cookieHeader = (value: string, request: IncomingMessage, maxAge?: number) => {
    // Over HTTPS as `http.server` 1.3 tells it: a forwarded protocol only from a trusted peer (D1363).
    const secure =
      http.requestOrigin === undefined
        ? (request.socket as { encrypted?: boolean }).encrypted === true
        : http.requestOrigin(request).startsWith("https:");
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
    http.route("OPTIONS", "/auth/ws-ticket", (_request, response) => {
      response.writeHead(204, CORS).end();
    }),
  );
  store.add(
    http.route("POST", "/auth/ws-ticket", (request, response) => {
      // The body is not read: everything is in the headers (D1367).
      request.resume();
      const counted = admit("ticket", request, response);
      if (counted === undefined) return;
      const authorization = headerOf(request, "authorization") ?? "";
      const scheme = /^(DPoP|Bearer) +(\S+)$/i.exec(authorization.trim());
      const given = scheme?.[2];
      const holder = given === undefined ? undefined : options.ticket(given);
      if (scheme === null || given === undefined || holder === undefined) {
        send(
          response,
          401,
          { code: "CREDENTIAL_INVALID", message: "This token is not valid here." },
          { ...CORS, "www-authenticate": 'DPoP algs="ES256", Bearer' },
        );
        return;
      }
      const dpop = scheme[1]!.toLowerCase() === "dpop";
      // At its cap, refused before the proof is checked, so no proof is spent on it.
      if (holder.full()) {
        succeeded(counted);
        send(
          response,
          429,
          { code: "TOO_MANY_TICKETS", message: "Too many open tickets; try again in a minute" },
          { ...CORS, "retry-after": "60" },
        );
        return;
      }
      if (holder.jkt !== undefined || dpop) {
        // A bound token needs its key's proof; DPoP names a bound token (RFC 9449 §7.1).
        if (!dpop || holder.jkt === undefined) {
          send(
            response,
            401,
            {
              code: "DPOP_PROOF_INVALID",
              message: dpop
                ? "This token is not bound to a key; send it as Bearer."
                : "This token is bound to a key; send it as DPoP with a proof.",
            },
            { ...CORS, "www-authenticate": 'DPoP algs="ES256"' },
          );
          return;
        }
        const checked = checkProof(request, headerOf(request, "dpop"), {
          expectedThumbprint: holder.jkt,
          accessToken: given,
        });
        if (!checked.ok) {
          refuseProof(response, checked.failure, CORS, 401);
          return;
        }
      }
      // The proof is spent already: a refused mint is retried with a new proof,
      // as every request makes one.
      const minted = holder.issue();
      if (minted === undefined) {
        // A device at its cap is no guesser: the attempt is given back.
        succeeded(counted);
        send(
          response,
          429,
          { code: "TOO_MANY_TICKETS", message: "Too many open tickets; try again in a minute" },
          { ...CORS, "retry-after": "60" },
        );
        return;
      }
      succeeded(counted);
      send(response, 200, minted, CORS);
    }),
  );
  store.add(
    http.route("POST", "/auth/pair", async (request, response) => {
      const counted = admit("pair", request, response);
      if (counted === undefined) return;
      const body = await readJson(request).catch((error: unknown) => error);
      if (body instanceof BodyTooLarge) {
        send(
          response,
          413,
          { code: "TOO_LARGE", message: "The request body is too large" },
          { ...CORS, connection: "close" },
        );
        response.on("finish", () => request.destroy());
        return;
      }
      const parsed = PairRequest.safeParse(body instanceof Error ? undefined : body);
      if (!parsed.success) {
        send(response, 400, { code: "INVALID", message: "Expected { code, label? }" }, CORS);
        return;
      }
      // A proof binds the token to the device's key (DPoP, D1366); none pairs a bearer token.
      let jkt: string | undefined;
      const proof = headerOf(request, "dpop");
      if (proof !== undefined) {
        const checked = checkProof(request, proof);
        if (!checked.ok) {
          refuseProof(response, checked.failure, CORS);
          return;
        }
        jkt = checked.thumbprint;
      }
      let issued: IssuedToken | undefined;
      try {
        const { code, label, deviceType, os } = parsed.data;
        issued = options.pair(
          code,
          label,
          metadataOf(request, {
            ...(deviceType === undefined ? {} : { deviceType }),
            ...(os === undefined ? {} : { os }),
          }),
          jkt,
        );
      } catch (error) {
        // A JSON answer with CORS, so a page on another origin can read what went wrong.
        log.error("pairing failed", { error: String(error) });
        send(
          response,
          500,
          { code: "PAIRING_FAILED", message: "Pairing failed on the node; try again" },
          CORS,
        );
        return;
      }
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
      succeeded(counted);
      send(response, 200, issued, CORS);
    }),
  );

  store.add(
    http.route("POST", "/auth/session", async (request, response) => {
      // Refused before it counts: another page cannot spend this client's attempts.
      if (!ownPage(http, request)) {
        send(response, 403, {
          code: "ORIGIN_NOT_ALLOWED",
          message: "Browser sessions are only accepted from the node's own pages.",
        });
        return;
      }
      const counted = admit("session", request, response);
      if (counted === undefined) return;
      const body = await readJson(request).catch((error: unknown) => error);
      if (body instanceof BodyTooLarge) {
        send(
          response,
          413,
          { code: "TOO_LARGE", message: "The request body is too large" },
          { connection: "close" },
        );
        response.on("finish", () => request.destroy());
        return;
      }
      const parsed = SessionRequest.safeParse(body instanceof Error ? undefined : body);
      if (!parsed.success) {
        send(response, 400, { code: "INVALID", message: "Expected { credential }" });
        return;
      }
      let issued: IssuedToken | undefined;
      try {
        issued = await options.openSession(parsed.data.credential, metadataOf(request));
      } catch (error) {
        log.error("opening a page session failed", { error: String(error) });
        send(response, 500, {
          code: "SESSION_FAILED",
          message: "The node could not open a session; try again",
        });
        return;
      }
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
          : Math.floor((issued.expiresAt - Date.now()) / 1000);
      // A cookie that would die at once is no session: say so instead of a 200.
      if (maxAge !== undefined && maxAge <= 0) {
        options.closeSession(issued.token);
        send(response, 401, {
          code: "CREDENTIAL_INVALID",
          message: "This token is about to expire. Request a new pairing link.",
        });
        return;
      }
      // The token goes into the cookie only: the page never sees it.
      const { token, ...visible } = issued;
      succeeded(counted);
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
