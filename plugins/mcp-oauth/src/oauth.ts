// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/auth/McpOAuth.ts —
// stateless client registration, redirect rules, PKCE, one-use codes bound to their request.
import * as Crypto from "node:crypto";

import { isGrant } from "@jhin/sdk";

/** T3's limits (docs/plans/security.md D1192, D1195). */
const AUTHORIZATION_CODE_TTL_MS = 60_000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const DEFAULT_CLIENT_NAME = "MCP client";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OAuthUrls {
  readonly issuer: string;
  readonly resource: string;
}

export const urlsFor = (origin: string): OAuthUrls => ({
  issuer: origin,
  resource: `${origin}/mcp`,
});

export const protectedResourceMetadata = (urls: OAuthUrls, scopes: readonly string[]) => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  scopes_supported: scopes,
  bearer_methods_supported: ["header"],
  resource_name: "Jhin",
});

export const authorizationServerMetadata = (urls: OAuthUrls, scopes: readonly string[]) => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  response_types_supported: ["code"],
  // Refresh tokens are Jhin's (security.md D1519); T3 issues none.
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: scopes,
  authorization_response_iss_parameter_supported: true,
});

function parseRedirect(value: string): URL | undefined {
  // No fragment, not even an empty one, which `URL.hash` reports as "" (RFC 6749 §3.1.2).
  if (value.length > MAX_REDIRECT_URI_LENGTH || value.includes("#")) return undefined;
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
  return allowed && url.username === "" && url.password === "" ? url : undefined;
}

/**
 * Loopback redirects match on everything but the port (RFC 8252 §7.3), since
 * CLI agents listen on whatever port is free; https redirects match exactly.
 */
function redirectMatches(registered: string, presented: string): boolean {
  const left = parseRedirect(registered);
  const right = parseRedirect(presented);
  if (left === undefined || right === undefined) return false;
  if (left.protocol === "https:" || right.protocol === "https:") return left.href === right.href;
  return (
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
}

function sameResource(urls: OAuthUrls, presented: string | undefined): boolean {
  if (presented === undefined) return true;
  if (!URL.canParse(presented)) return false;
  const url = new URL(presented);
  return url.hash === "" && `${url.origin}${url.pathname.replace(/\/+$/u, "")}` === urls.resource;
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const sha256 = (value: string) => Crypto.createHash("sha256").update(value).digest("base64url");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && Crypto.timingSafeEqual(left, right);
}

export interface OAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

/** A request the owner may approve: everything checked, the redirect trusted. */
export interface AuthorizationRequest {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly resource: string;
  readonly issuer: string;
  /** Jhin grants asked for (D1194). */
  readonly scopes: readonly string[];
}

/** Who approved: its grants are read again at exchange, and the token is issued as it (D1195). */
export interface Approver {
  readonly id: string;
}

interface PendingCode {
  readonly codeHash: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly approver: Approver;
  readonly expiresAt: number;
}

export type Validation =
  /** Shown on the page, never redirected: the client or its redirect is not trusted. */
  | { readonly kind: "page"; readonly description: string }
  /** Sent back to the client's verified redirect. */
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "ok"; readonly request: AuthorizationRequest };

export type Exchange =
  | { readonly kind: "error"; readonly error: string; readonly description: string }
  | {
      readonly kind: "ok";
      readonly clientId: string;
      readonly clientName: string;
      readonly resource: string;
      readonly scopes: readonly string[];
      readonly approver: Approver;
    };

/** A refresh request whose form is valid; the token itself is checked by the store (D1519). */
export type RefreshRequest =
  | { readonly kind: "error"; readonly error: string; readonly description: string }
  | {
      readonly kind: "ok";
      readonly clientId: string;
      readonly token: string;
      /** The narrower scope asked for; absent, the granted one. */
      readonly scopes?: readonly string[];
    };

function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/**
 * The OAuth authority of one node. `key` signs client ids and anti-forgery
 * values; `codes` holds pending authorization codes (kernel-scoped state, so
 * a reload keeps them).
 */
export function createOAuth(options: {
  readonly key: string;
  readonly codes: Map<string, PendingCode>;
  readonly defaultScopes: readonly string[];
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const sign = (domain: string, payload: string) =>
    Crypto.createHmac("sha256", options.key).update(`${domain}.${payload}`).digest("base64url");

  const signClientId = (name: string, redirectUris: readonly string[]) => {
    const body = base64url(JSON.stringify({ v: 1, n: name, r: redirectUris }));
    return `${body}.${sign("mcp-client-id", body)}`;
  };

  function parseClientId(clientId: string): OAuthClient | undefined {
    const [body, signature, extra] = clientId.split(".");
    if (body === undefined || signature === undefined || extra !== undefined) return undefined;
    if (body === "" || !sameText(signature, sign("mcp-client-id", body))) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        v?: unknown;
        n?: unknown;
        r?: unknown;
      };
      if (
        payload.v !== 1 ||
        typeof payload.n !== "string" ||
        !Array.isArray(payload.r) ||
        !payload.r.every((uri) => typeof uri === "string")
      ) {
        return undefined;
      }
      return { clientId, name: payload.n, redirectUris: payload.r as string[] };
    } catch {
      return undefined;
    }
  }

  const sweep = () => {
    const at = now();
    for (const [hash, pending] of options.codes) {
      if (pending.expiresAt <= at) options.codes.delete(hash);
    }
  };

  return {
    /** RFC 7591, stateless: the client id is its signed metadata (D1192). */
    register(
      metadata: unknown,
    ):
      | { readonly kind: "ok"; readonly client: OAuthClient }
      | { readonly kind: "error"; readonly error: string; readonly description: string } {
      const body = (typeof metadata === "object" && metadata !== null ? metadata : {}) as {
        client_name?: unknown;
        redirect_uris?: unknown;
      };
      const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "";
      const name = (rawName === "" ? DEFAULT_CLIENT_NAME : rawName).slice(
        0,
        MAX_CLIENT_NAME_LENGTH,
      );
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
        return {
          kind: "error",
          error: "invalid_redirect_uri",
          description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
        };
      }
      if (!redirectUris.every((uri) => typeof uri === "string" && parseRedirect(uri))) {
        return {
          kind: "error",
          error: "invalid_redirect_uri",
          description: "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
        };
      }
      // Requested grant types, scopes and auth methods are ignored rather than
      // refused (RFC 7591 lets the server answer with what it supports): every
      // client is public and proves itself with PKCE.
      const uris = redirectUris as string[];
      return {
        kind: "ok",
        client: { clientId: signClientId(name, uris), name, redirectUris: uris },
      };
    },

    /** Checks an authorization request (D1193); page errors never redirect. */
    validate(urls: OAuthUrls, params: Record<string, string | undefined>): Validation {
      const client = parseClientId(params["client_id"] ?? "");
      if (client === undefined) {
        return {
          kind: "page",
          description: "This sign-in link names an unknown app. Start the sign-in again from it.",
        };
      }
      const redirectUri = params["redirect_uri"];
      if (
        redirectUri === undefined ||
        !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
      ) {
        return {
          kind: "page",
          description: "This sign-in link sends you to an address the app did not register.",
        };
      }
      const state = params["state"];
      const fail = (error: string, description: string): Validation => ({
        kind: "redirect",
        url: redirectWith(redirectUri, {
          error,
          error_description: description,
          state,
          iss: urls.issuer,
        }),
      });
      if (params["response_type"] !== "code") {
        return fail("unsupported_response_type", "Only response_type=code is supported.");
      }
      const codeChallenge = params["code_challenge"];
      if (
        params["code_challenge_method"] !== "S256" ||
        codeChallenge === undefined ||
        !CODE_CHALLENGE_PATTERN.test(codeChallenge)
      ) {
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      }
      if (!sameResource(urls, params["resource"])) {
        return fail("invalid_target", `This node only issues tokens for ${urls.resource}.`);
      }
      const asked = (params["scope"] ?? "").split(/\s+/u).filter((scope) => scope !== "");
      if (!asked.every(isGrant)) {
        return fail("invalid_scope", "A scope is a Jhin permission or a pattern such as git.*.");
      }
      // An agent never gets the owner's whole authority, nor access management:
      // `*` and `auth.*` are not offered to an MCP client (D1194).
      if (asked.some((scope) => scope === "*" || scope === "auth" || scope.startsWith("auth."))) {
        return fail("invalid_scope", "`*` and auth.* are not granted to MCP clients.");
      }
      return {
        kind: "ok",
        request: {
          client,
          redirectUri,
          codeChallenge,
          state,
          resource: urls.resource,
          issuer: urls.issuer,
          scopes: asked.length === 0 ? [...options.defaultScopes] : [...new Set(asked)],
        },
      };
    },

    /** The anti-forgery value of a form shown to the browser session `session` for `request` (D1193). */
    csrf(session: string, request: AuthorizationRequest): string {
      return sign(
        "mcp-csrf",
        JSON.stringify([
          session,
          request.client.clientId,
          request.redirectUri,
          request.codeChallenge,
          request.scopes,
        ]),
      );
    },
    csrfMatches(given: string, session: string, request: AuthorizationRequest): boolean {
      return sameText(given, this.csrf(session, request));
    },

    /** Approves: a one-use code, back to the client's redirect (D1195). */
    approve(request: AuthorizationRequest, approver: Approver): string {
      sweep();
      const code = Crypto.randomBytes(32).toString("base64url");
      const codeHash = sha256(code);
      options.codes.set(codeHash, {
        codeHash,
        clientId: request.client.clientId,
        clientName: request.client.name,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        scopes: request.scopes,
        approver: { id: approver.id },
        expiresAt: now() + AUTHORIZATION_CODE_TTL_MS,
      });
      return redirectWith(request.redirectUri, {
        code,
        state: request.state,
        iss: request.issuer,
      });
    },

    deny(request: AuthorizationRequest): string {
      return redirectWith(request.redirectUri, {
        error: "access_denied",
        state: request.state,
        iss: request.issuer,
      });
    },

    /** The token request (D1195): the code is spent even when a later check fails. */
    exchange(urls: OAuthUrls, params: Record<string, string | undefined>): Exchange {
      const fail = (error: string, description: string): Exchange => ({
        kind: "error",
        error,
        description,
      });
      if (params["grant_type"] !== "authorization_code") {
        return fail("unsupported_grant_type", "Only authorization_code is supported.");
      }
      const code = params["code"];
      const redirectUri = params["redirect_uri"];
      const clientId = params["client_id"];
      const verifier = params["code_verifier"];
      if (!code || !redirectUri || !clientId || !verifier) {
        return fail(
          "invalid_request",
          "code, redirect_uri, client_id and code_verifier are required.",
        );
      }
      if (parseClientId(clientId) === undefined) {
        return fail("invalid_client", "The client is unknown.");
      }
      sweep();
      const codeHash = sha256(code);
      const pending = options.codes.get(codeHash);
      options.codes.delete(codeHash);
      if (
        pending === undefined ||
        pending.expiresAt <= now() ||
        pending.clientId !== clientId ||
        pending.redirectUri !== redirectUri ||
        pending.resource !== urls.resource ||
        !sameResource(urls, params["resource"]) ||
        !CODE_VERIFIER_PATTERN.test(verifier) ||
        !sameText(sha256(verifier), pending.codeChallenge)
      ) {
        return fail("invalid_grant", "The authorization code is invalid or expired.");
      }
      return {
        kind: "ok",
        clientId: pending.clientId,
        clientName: pending.clientName,
        resource: pending.resource,
        scopes: pending.scopes,
        approver: pending.approver,
      };
    },

    /** The form of a `refresh_token` grant (security.md D1519, RFC 6749 §6). */
    refreshRequest(urls: OAuthUrls, params: Record<string, string | undefined>): RefreshRequest {
      const fail = (error: string, description: string): RefreshRequest => ({
        kind: "error",
        error,
        description,
      });
      const token = params["refresh_token"];
      const clientId = params["client_id"];
      if (!token || !clientId) {
        return fail("invalid_request", "refresh_token and client_id are required.");
      }
      if (parseClientId(clientId) === undefined) {
        return fail("invalid_client", "The client is unknown.");
      }
      if (!sameResource(urls, params["resource"])) {
        return fail("invalid_target", `This node only issues tokens for ${urls.resource}.`);
      }
      const scope = params["scope"];
      if (scope === undefined) return { kind: "ok", clientId, token };
      const asked = [...new Set(scope.split(/\s+/u).filter((entry) => entry !== ""))];
      if (asked.length === 0 || !asked.every(isGrant)) {
        return fail("invalid_scope", "A scope is a Jhin permission or a pattern such as git.*.");
      }
      return { kind: "ok", clientId, token, scopes: asked };
    },
  };
}

export type { PendingCode };
