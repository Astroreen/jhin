// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/auth/mcpOAuthHttp.ts —
// the metadata, registration, authorization and token endpoints of an MCP client's sign-in.
import * as Crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AUTH_VERIFIER_CAPABILITY,
  OWNER_PRINCIPAL_ID,
  clientPrincipalId,
  deriveClientMetadata,
  readCookie,
  sessionCookieName,
  type AuthVerifier,
} from "@jhin/auth-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { AGENT_PERMISSIONS } from "@jhin/mcp-api";
import { definePlugin, holdsPermission } from "@jhin/sdk";
import { SECRETS_STORE_CAPABILITY, type SecretStore } from "@jhin/secrets-api";

import { pageHeaders, renderApprovalPage, renderErrorPage } from "./html.ts";
import {
  authorizationServerMetadata,
  createOAuth,
  protectedResourceMetadata,
  urlsFor,
  type AuthorizationRequest,
  type PendingCode,
} from "./oauth.ts";

const SIGNING_KEY = "jhin.mcp-oauth/signing-key";
/** An OAuth client's token lives as long as a paired device's (security.md D1195). */
const TOKEN_TTL_DAYS = 30;
const MAX_BODY = 16 * 1024;
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

    const titles = async () => {
      try {
        const { permissions } = (await context.commands.execute("auth.permissions.list", {})) as {
          permissions: { permission: string; title?: string; description?: string }[];
        };
        return new Map(permissions.map((entry) => [entry.permission, entry]));
      } catch {
        return new Map<string, { permission: string; title?: string; description?: string }>();
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
        grant_types: ["authorization_code"],
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
      const known = await titles();
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
          permissions: authorization.scopes.map(
            (scope) => known.get(scope) ?? { permission: scope },
          ),
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
      const approver = await approverOf(request, authorization);
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
      context.log.warn("an MCP client sign-in was approved", {
        client: authorization.client.name,
        approver: approver.principal.id,
        scopes: authorization.scopes,
      });
      redirect(
        response,
        oauth.approve(authorization, {
          id: approver.principal.id,
          permissions: approver.principal.permissions,
        }),
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
        grants === undefined ||
        !exchanged.scopes.every((scope) => holdsPermission(grants, scope))
      ) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "Whoever approved this sign-in can no longer grant it.",
        });
        return;
      }
      let issued: { token: string; expiresAt?: number };
      try {
        // As the approver: a token never holds more than who approved it (D413, D1195).
        issued = (await context.commands.execute(
          "auth.tokens.issue",
          {
            label: exchanged.clientName,
            permissions: exchanged.scopes,
            // Never outlives who approved it, as a page session never outlives its token (D421).
            ttlDays:
              approverNow?.expiresAt === undefined
                ? TOKEN_TTL_DAYS
                : Math.min(TOKEN_TTL_DAYS, (approverNow.expiresAt - Date.now()) / 86_400_000),
            method: "oauth",
            metadata: deriveClientMetadata({
              userAgent: request.headers["user-agent"],
              ipAddress: http.clientAddress(request),
            }),
          },
          { caller: { id: exchanged.approver.id, permissions: grants } },
        )) as { token: string; expiresAt?: number };
      } catch (error) {
        context.log.error("an approved MCP client could not get its token", {
          error: String(error),
        });
        json(response, 400, {
          error: "invalid_grant",
          error_description: "The token could not be issued.",
        });
        return;
      }
      json(response, 200, {
        access_token: issued.token,
        token_type: "Bearer",
        expires_in:
          issued.expiresAt === undefined
            ? TOKEN_TTL_DAYS * 86_400
            : Math.max(0, Math.floor((issued.expiresAt - Date.now()) / 1000)),
        scope: exchanged.scopes.join(" "),
      });
    });
    context.log.info("mcp oauth ready");
  },
});
