// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/auth/mcpOAuthHttp.ts —
// the metadata, registration, authorization and token endpoints of an MCP client's sign-in.
import * as Crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as Path from "node:path";

import {
  AUTH_VERIFIER_CAPABILITY,
  AuthEvents,
  OWNER_PRINCIPAL_ID,
  clientPrincipalId,
  deriveClientMetadata,
  readCookie,
  sessionCookieName,
  type AuthVerifier,
} from "@jhin/auth-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { AGENT_PERMISSIONS } from "@jhin/mcp-api";
import { definePlugin, holdsPermission } from "@jhin/sdk";
import { SECRETS_STORE_CAPABILITY, type SecretStore } from "@jhin/secrets-api";

import {
  ACCESS_LEVELS,
  pageHeaders,
  renderApprovalPage,
  renderErrorPage,
  type AccessLevel,
  type ApprovalPage,
} from "./html.ts";
import {
  authorizationServerMetadata,
  createOAuth,
  protectedResourceMetadata,
  urlsFor,
  type Approver,
  type AuthorizationRequest,
  type PendingCode,
} from "./oauth.ts";
import { createRefreshStore, type RefreshGrant } from "./refresh.ts";

const SIGNING_KEY = "jhin.mcp-oauth/signing-key";
/** An OAuth client's token lives as long as a paired device's (security.md D1195). */
const TOKEN_TTL_DAYS = 30;
const MAX_BODY = 16 * 1024;
/**
 * What an access level grants of what was asked (security.md D1369): read
 * only, the asked `*.read` permissions; any other level, all of it and the
 * level's runtime mode ceiling (`threads.mode.<mode>`, D1370).
 */
export function grantsFor(level: AccessLevel, asked: readonly string[]): string[] {
  if (level === "read-only") return asked.filter((scope) => scope.endsWith(".read"));
  // The ceiling is the approver's choice, never the client's: a mode it asked for goes.
  const chosen = asked.filter((scope) => !scope.startsWith("threads.mode."));
  return [...new Set([...chosen, `threads.mode.${level}`])];
}

/** An entry of `auth.permissions.list`, as the approval page reads it (D1364, D1517). */
type DescribedPermission = ApprovalPage["permissions"][number];

/** Approving issues tokens: the approver needs `auth.write` (D1193). */
const APPROVE_PERMISSION = "auth.write";

/** The request parameters an authorization request carries, and only those. */
const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
] as const;

/** Metadata, registration and the token endpoint answer agents on any origin. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
};

class BodyTooLarge extends Error {}

/** A 413 for a body past `MAX_BODY`; the connection closes once it is sent. */
function tooLarge(request: IncomingMessage, response: ServerResponse): void {
  response.on("finish", () => request.destroy());
  json(
    response,
    413,
    { error: "invalid_request", error_description: "The request body is too large." },
    { connection: "close" },
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop reading, answer, and close after the answer: the client hears why.
        request.off("data", onData);
        request.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
    // A client that goes away mid-body settles it too; nothing waits on it.
    request.on("close", () => {
      if (!request.complete) reject(new Error("aborted"));
    });
  });
}

/** A form or JSON body as flat string parameters. */
async function readParams(request: IncomingMessage): Promise<Record<string, string>> {
  const text = await readBody(request);
  const type = request.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      ...CORS,
      ...headers,
    })
    .end(JSON.stringify(body));
}

const redirect = (response: ServerResponse, location: string) =>
  response
    .writeHead(303, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" })
    .end();

export default definePlugin({
  activate(context) {
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const verifier = context.services.get<AuthVerifier>(AUTH_VERIFIER_CAPABILITY);
    const secrets = context.services.get<SecretStore>(SECRETS_STORE_CAPABILITY);
    if (!secrets.readable || secrets.getOrCreateRandom === undefined) {
      // Without the key there is no sign-in; MCP clients keep using tokens (D1191).
      context.log.warn("MCP OAuth is off: the secret store cannot keep its signing key");
      return;
    }
    const codes =
      context.state.get<Map<string, PendingCode>>("codes") ??
      (() => {
        const created = new Map<string, PendingCode>();
        context.state.set("codes", created);
        return created;
      })();
    const oauth = createOAuth({
      key: secrets.getOrCreateRandom(SIGNING_KEY, 32),
      codes,
      defaultScopes: AGENT_PERMISSIONS,
    });
    const cookie = sessionCookieName(new URL(http.url).port);
    // Refresh tokens outlive a restart, so they live in a file, as hashes (D1519).
    const refresh = createRefreshStore({
      file: Path.join(
        context.services.get<HostPaths>(HOST_PATHS_CAPABILITY).dataDir(context.plugin.id),
        "refresh.json",
      ),
      onCorrupt: (error) =>
        context.log.warn("refresh.json is unreadable: every MCP client signs in again", { error }),
    });

    /** Revokes a device token as the node itself; one already gone is fine. */
    const revokeToken = async (id: string) => {
      try {
        await context.commands.execute("auth.clients.revoke", { id });
      } catch (error) {
        context.log.info("an MCP client's token was already gone", { id, error: String(error) });
      }
    };
    /** Ends a sign-in: its refresh tokens and the access token it currently renews. */
    const endSignIn = async (family: string) => {
      const current = refresh.end(family);
      if (current !== undefined) await revokeToken(current);
    };
    // Revoking under Authorized clients ends the sign-in at once (D1519).
    context.subscriptions.add(
      context.events.on(AuthEvents.clientRevoked, (payload) => {
        const principal = (payload as { principal?: unknown } | undefined)?.principal;
        if (typeof principal !== "string") return;
        const family = refresh.familyOf((tokenId) => clientPrincipalId(tokenId) === principal);
        if (family !== undefined) refresh.end(family);
      }),
    );

    /** Every URL from the request's own origin: loopback, a proxy and Tailscale Serve alike (D1191). */
    const originOf = (request: IncomingMessage) =>
      http.requestOrigin?.(request) ?? new URL(http.url).origin;
    const urlsOf = (request: IncomingMessage) => urlsFor(originOf(request));

    /** The page session's principal, when it may approve `request` (D1193). */
    const approverOf = async (request: IncomingMessage, authorization: AuthorizationRequest) => {
      const token = readCookie(request.headers.cookie, cookie);
      const principal = token === undefined ? undefined : await verifier.verify({ token });
      if (principal === undefined || token === undefined) return { kind: "none" } as const;
      const missing = [APPROVE_PERMISSION, ...authorization.scopes].filter(
        (permission) => !holdsPermission(principal.permissions, permission),
      );
      return missing.length > 0
        ? ({ kind: "short", missing } as const)
        : ({ kind: "ok", principal, session: sessionKey(token) } as const);
    };

    /** What the anti-forgery value binds to: this browser's session, never its token itself. */
    const sessionKey = (token: string) =>
      Crypto.createHash("sha256").update(token).digest("base64url");

    /**
     * The approver's grants now, not when it approved (D413): a revoked or
     * narrowed session within the code's 60 seconds issues nothing more.
     */
    const currentGrants = async (approver: {
      id: string;
    }): Promise<{ permissions: string[]; expiresAt?: number } | undefined> => {
      if (approver.id === OWNER_PRINCIPAL_ID) return { permissions: ["*"] };
      const { clients } = (await context.commands.execute("auth.clients.list", {})) as {
        clients: { id: string; permissions: string[]; expiresAt?: number }[];
      };
      const record = clients.find((client) => clientPrincipalId(client.id) === approver.id);
      // An approver that expired since grants nothing, as one that was revoked.
      return record === undefined ||
        (record.expiresAt !== undefined && record.expiresAt <= Date.now())
        ? undefined
        : {
            permissions: record.permissions,
            ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
          };
    };

    /**
     * Who stands behind an approver: a page session is opened with a token
     * and never outlives it (D421), so a sign-in's refresh tokens hang on that
     * token (the owner, or a paired device), not on one browser's session (D1519).
     */
    const standingOf = async (approver: Approver): Promise<Approver> => {
      if (approver.id === OWNER_PRINCIPAL_ID) return approver;
      const { clients } = (await context.commands.execute("auth.clients.list", {})) as {
        clients: { id: string; parent?: string }[];
      };
      let id = approver.id;
      for (let hops = 0; hops <= clients.length; hops++) {
        const parent = clients.find((client) => clientPrincipalId(client.id) === id)?.parent;
        if (parent === undefined) break;
        id = parent;
      }
      return { id };
    };

    const titles = async () => {
      try {
        const { permissions } = (await context.commands.execute("auth.permissions.list", {})) as {
          permissions: DescribedPermission[];
        };
        return new Map(permissions.map((entry) => [entry.permission, entry]));
      } catch (error) {
        // The page then says it could not tell which permissions run commands (D1364).
        context.log.warn("could not read the permissions for the approval page", {
          error: String(error),
        });
        return undefined;
      }
    };

    const add = (method: string, path: string, handler: Parameters<HttpServer["route"]>[2]) =>
      context.subscriptions.add(http.route(method, path, handler));

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      add("GET", path, (request, response) =>
        json(response, 200, protectedResourceMetadata(urlsOf(request), AGENT_PERMISSIONS)),
      );
    }
    add("GET", "/.well-known/oauth-authorization-server", (request, response) =>
      json(response, 200, authorizationServerMetadata(urlsOf(request), AGENT_PERMISSIONS)),
    );
    for (const path of [
      "/oauth/mcp/register",
      "/oauth/mcp/token",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      add("OPTIONS", path, (_request, response) => {
        response.writeHead(204, CORS).end();
      });
    }

    add("POST", "/oauth/mcp/register", async (request, response) => {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof BodyTooLarge) return tooLarge(request, response);
        json(response, 400, {
          error: "invalid_client_metadata",
          error_description: "Expected JSON client metadata.",
        });
        return;
      }
      const registered = oauth.register(body);
      if (registered.kind === "error") {
        json(response, 400, {
          error: registered.error,
          error_description: registered.description,
        });
        return;
      }
      json(response, 201, {
        client_id: registered.client.clientId,
        client_name: registered.client.name,
        redirect_uris: registered.client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    });

    const showPage = async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Record<string, string | undefined>,
    ) => {
      const urls = urlsOf(request);
      const validated = oauth.validate(urls, params);
      if (validated.kind === "page") {
        response.writeHead(400, pageHeaders()).end(renderErrorPage(validated.description));
        return;
      }
      if (validated.kind === "redirect") {
        redirect(response, validated.url);
        return;
      }
      const authorization = validated.request;
      const approver = await approverOf(request, authorization);
      const described = await titles();
      const known = described ?? new Map<string, DescribedPermission>();
      const nonce = Crypto.randomBytes(16).toString("base64url");
      const kept = Object.fromEntries(
        AUTHORIZE_PARAMS.flatMap((name) =>
          params[name] === undefined ? [] : [[name, params[name]!] as const],
        ),
      );
      response.writeHead(200, pageHeaders(nonce)).end(
        renderApprovalPage({
          clientName: authorization.client.name,
          redirectHost: new URL(authorization.redirectUri).host,
          nodeHost: new URL(urls.issuer).host,
          params: kept,
          ...(described === undefined ? { permissionsUnknown: true } : {}),
          ...(grantsFor("read-only", authorization.scopes).length === 0
            ? { nothingReadable: true }
            : {}),
          permissions: authorization.scopes.map((scope) => {
            const entry = known.get(scope) ?? { permission: scope };
            // A pattern (`terminals.*`) grants shell access when it covers a permission
            // that has it (security.md D1364).
            const shell = [...known.values()].filter(
              (other) => other.shellAccess === true && holdsPermission([scope], other.permission),
            );
            if (shell.length === 0) return entry;
            // Its reason (D1517) when every permission it covers gives the same one;
            // else D1364's sentence, which holds for each of them.
            const reasons = new Set(shell.map((other) => other.shellAccessReason));
            const [reason] = reasons;
            return {
              permission: entry.permission,
              ...(entry.title === undefined ? {} : { title: entry.title }),
              ...(entry.description === undefined ? {} : { description: entry.description }),
              shellAccess: true,
              ...(reasons.size === 1 && reason !== undefined ? { shellAccessReason: reason } : {}),
            };
          }),
          ...(approver.kind === "ok" ? { csrf: oauth.csrf(approver.session, authorization) } : {}),
          ...(approver.kind === "short"
            ? {
                sessionProblem: `This browser's session cannot approve it: it does not hold ${approver.missing.join(", ")}. Enter a pairing code instead.`,
              }
            : {}),
          nonce,
        }),
      );
    };

    add("GET", "/oauth/mcp/authorize", (request, response) =>
      showPage(
        request,
        response,
        Object.fromEntries(new URL(request.url ?? "/", "http://node").searchParams),
      ),
    );

    add("POST", "/oauth/mcp/authorize", async (request, response) => {
      // The decision is posted by the approval page only (D1193). Browsers send
      // `Origin` with a form post; without it, only a same-origin fetch counts.
      // An opaque `Origin: null` counts only with the browser's own word that
      // the post is same-origin.
      const origin = request.headers.origin;
      const sameSite = request.headers["sec-fetch-site"] === "same-origin";
      if (origin === undefined || origin === "null" ? !sameSite : origin !== originOf(request)) {
        response.writeHead(403, pageHeaders()).end(renderErrorPage("This page is not the node's."));
        return;
      }
      let params: Record<string, string>;
      try {
        params = await readParams(request);
      } catch (error) {
        if (error instanceof BodyTooLarge) return tooLarge(request, response);
        response.writeHead(400, pageHeaders()).end(renderErrorPage("The request was malformed."));
        return;
      }
      const validated = oauth.validate(urlsOf(request), params);
      if (validated.kind === "page") {
        response.writeHead(400, pageHeaders()).end(renderErrorPage(validated.description));
        return;
      }
      if (validated.kind === "redirect") {
        redirect(response, validated.url);
        return;
      }
      const authorization = validated.request;
      if (params["decision"] === "deny") {
        context.log.info("an MCP client sign-in was denied", { client: authorization.client.name });
        redirect(response, oauth.deny(authorization));
        return;
      }
      // Only an explicit approval issues a code: a missing or mistyped decision does not.
      if (params["decision"] !== "approve") {
        response
          .writeHead(400, pageHeaders())
          .end(renderErrorPage("The page sent no decision. Open the sign-in link again."));
        return;
      }
      // The session and its anti-forgery value first, so nothing else is told to another page.
      const approver = await approverOf(request, { ...authorization, scopes: [] });
      if (
        approver.kind !== "ok" ||
        !oauth.csrfMatches(params["csrf"] ?? "", approver.session, authorization)
      ) {
        response
          .writeHead(403, pageHeaders())
          .end(
            renderErrorPage(
              "Your session cannot approve this request. Open the sign-in link again and approve it from this node's page.",
            ),
          );
        return;
      }
      // T3's access level (security.md D1369): what the approver picked on the page.
      const level = ACCESS_LEVELS.find((entry) => entry.access === params["access"])?.access;
      if (level === undefined) {
        response
          .writeHead(400, pageHeaders())
          .end(renderErrorPage("The page sent no access level. Open the sign-in link again."));
        return;
      }
      const granted = grantsFor(level, authorization.scopes);
      if (granted.length === 0) {
        response
          .writeHead(400, pageHeaders())
          .end(
            renderErrorPage(
              "This agent asked for nothing it could read. Choose another access level.",
            ),
          );
        return;
      }
      // The approver gives only what it holds (D413), the level's ceiling included.
      const missing = granted.filter(
        (permission) => !holdsPermission(approver.principal.permissions, permission),
      );
      if (missing.length > 0) {
        response
          .writeHead(403, pageHeaders())
          .end(
            renderErrorPage(
              `This session cannot grant ${missing.join(", ")}. Choose another access level, or approve with a session that holds it.`,
            ),
          );
        return;
      }
      context.log.warn("an MCP client sign-in was approved", {
        client: authorization.client.name,
        approver: approver.principal.id,
        access: level,
        scopes: granted,
      });
      redirect(
        response,
        oauth.approve({ ...authorization, scopes: granted }, { id: approver.principal.id }),
      );
    });

    add("POST", "/oauth/mcp/token", async (request, response) => {
      let params: Record<string, string>;
      try {
        params = await readParams(request);
      } catch (error) {
        if (error instanceof BodyTooLarge) return tooLarge(request, response);
        json(response, 400, { error: "invalid_request", error_description: "Malformed body." });
        return;
      }
      if (params["grant_type"] === "refresh_token") {
        await refreshGrant(request, response, params);
        return;
      }
      const exchanged = oauth.exchange(urlsOf(request), params);
      if (exchanged.kind === "error") {
        json(response, exchanged.error === "invalid_client" ? 401 : 400, {
          error: exchanged.error,
          error_description: exchanged.description,
        });
        return;
      }
      const approverNow = await currentGrants(exchanged.approver);
      const grants = approverNow?.permissions;
      if (
        approverNow === undefined ||
        grants === undefined ||
        !exchanged.scopes.every((scope) => holdsPermission(grants, scope))
      ) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "Whoever approved this sign-in can no longer grant it.",
        });
        return;
      }
      const issued = await issueAccess(
        request,
        exchanged.clientName,
        exchanged.approver,
        approverNow,
        exchanged.scopes,
      );
      if (issued === undefined) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "The token could not be issued.",
        });
        return;
      }
      // Every code grant gets a refresh token too, a new sign-in of its own (D1519).
      const refreshToken = refresh.issue({
        clientId: exchanged.clientId,
        clientName: exchanged.clientName,
        resource: exchanged.resource,
        scopes: [...exchanged.scopes],
        approver: await standingOf(exchanged.approver),
        ...renews(issued),
      });
      answerTokens(response, issued, exchanged.scopes, refreshToken);
    });

    /** What a refresh token records of the device token it renews. */
    const renews = (issued: { id: string; expiresAt?: number }) => ({
      tokenId: issued.id,
      ...(issued.expiresAt === undefined ? {} : { tokenExpiresAt: issued.expiresAt }),
    });

    const answerTokens = (
      response: ServerResponse,
      issued: { token: string; expiresAt?: number },
      scopes: readonly string[],
      refreshToken: string,
    ) =>
      json(response, 200, {
        access_token: issued.token,
        token_type: "Bearer",
        expires_in:
          issued.expiresAt === undefined
            ? TOKEN_TTL_DAYS * 86_400
            : Math.max(0, Math.floor((issued.expiresAt - Date.now()) / 1000)),
        scope: scopes.join(" "),
        refresh_token: refreshToken,
      });

    /**
     * A device token for an MCP client, issued as its approver: it never holds
     * more than who approved it (D413, D1195) and never outlives it.
     */
    const issueAccess = async (
      request: IncomingMessage,
      clientName: string,
      approver: Approver,
      approverNow: { permissions: string[]; expiresAt?: number },
      scopes: readonly string[],
    ): Promise<{ id: string; token: string; expiresAt?: number } | undefined> => {
      try {
        return (await context.commands.execute(
          "auth.tokens.issue",
          {
            label: clientName,
            permissions: scopes,
            // Never outlives who approved it, as a page session never outlives its token (D421).
            ttlDays:
              approverNow.expiresAt === undefined
                ? TOKEN_TTL_DAYS
                : Math.min(TOKEN_TTL_DAYS, (approverNow.expiresAt - Date.now()) / 86_400_000),
            method: "oauth",
            metadata: deriveClientMetadata({
              userAgent: request.headers["user-agent"],
              ipAddress: http.clientAddress(request),
            }),
          },
          { caller: { id: approver.id, permissions: approverNow.permissions } },
        )) as { id: string; token: string; expiresAt?: number };
      } catch (error) {
        context.log.error("an approved MCP client could not get its token", {
          error: String(error),
        });
        return undefined;
      }
    };

    /**
     * `grant_type=refresh_token` (D1519): one use, rotated, bound to its
     * client, its resource and the approver's standing; a spent token
     * presented again ends the sign-in (RFC 9700 §4.14.2).
     */
    const refreshGrant = async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Record<string, string>,
    ) => {
      const refused = (description: string) =>
        json(response, 400, { error: "invalid_grant", error_description: description });
      const urls = urlsOf(request);
      const asked = oauth.refreshRequest(urls, params);
      if (asked.kind === "error") {
        json(response, asked.error === "invalid_client" ? 401 : 400, {
          error: asked.error,
          error_description: asked.description,
        });
        return;
      }
      const found = refresh.find(asked.token);
      if (found.kind === "unknown") return refused("The refresh token is invalid or expired.");
      const record = found.record;
      const scopes = asked.scopes ?? record.scopes;
      const fits =
        record.clientId === asked.clientId &&
        record.resource === urls.resource &&
        scopes.every((scope) => holdsPermission(record.scopes, scope));
      // The answer to its spend never arrived: what it carried is dropped (D1705).
      const from = http.clientAddress(request);
      const lost =
        found.kind === "spent" && fits ? refresh.retry(record, asked.clientId, from) : undefined;
      if (found.kind === "spent" && lost === undefined) {
        // One of the two holders stole it: neither keeps the sign-in.
        context.log.warn("a spent MCP refresh token was presented again; its sign-in ends");
        await endSignIn(found.family);
        return refused("The refresh token was already used.");
      }
      if (record.clientId !== asked.clientId || record.resource !== urls.resource) {
        return refused("The refresh token was issued to another client.");
      }
      if (!fits) {
        json(response, 400, {
          error: "invalid_scope",
          error_description: "A refresh may narrow the granted scope, never widen it.",
        });
        return;
      }
      if (lost !== undefined) {
        context.log.info("an MCP client retried a refresh whose answer it did not get");
        await revokeToken(lost.tokenId);
      }
      // Spent before anything is awaited: the same token twice is a reuse.
      if (lost === undefined) refresh.spend(record.hash, from);
      const end = async (description: string) => {
        await endSignIn(record.family);
        refused(description);
      };
      const { clients } = (await context.commands.execute("auth.clients.list", {})) as {
        clients: { id: string }[];
      };
      // A retry renews nothing more: the token its spend renewed went with that answer.
      const renewed = lost === undefined && clients.some((client) => client.id === record.tokenId);
      // Gone before it expired: it was revoked, and the sign-in with it. An
      // access token that expired is what a refresh is for.
      if (
        lost === undefined &&
        !renewed &&
        (record.tokenExpiresAt === undefined || record.tokenExpiresAt > Date.now())
      ) {
        return end("The sign-in was revoked.");
      }
      const approverNow = await currentGrants(record.approver);
      const granted =
        approverNow === undefined
          ? []
          : scopes.filter((scope) => holdsPermission(approverNow.permissions, scope));
      if (approverNow === undefined || granted.length === 0) {
        return end("Whoever approved this sign-in can no longer grant it.");
      }
      const issued = await issueAccess(
        request,
        record.clientName,
        record.approver,
        approverNow,
        granted,
      );
      if (issued === undefined) return end("The token could not be issued.");
      if (!refresh.alive(record.family)) {
        // The sign-in ended while this refresh was under way (a reuse, a revoke).
        await revokeToken(issued.id);
        return refused("The sign-in was revoked.");
      }
      const grant: RefreshGrant = {
        clientId: record.clientId,
        clientName: record.clientName,
        resource: record.resource,
        // The refresh token keeps the granted scope (OAuth 2.1 §4.3.1).
        scopes: record.scopes,
        approver: record.approver,
        ...renews(issued),
      };
      const next = refresh.issue(grant, record.family);
      if (renewed) await revokeToken(record.tokenId);
      answerTokens(response, issued, granted, next);
    };
    context.log.info("mcp oauth ready");
  },
});
