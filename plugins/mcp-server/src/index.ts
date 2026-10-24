// The agent credentials (issue, the token kept as a SHA-256 hash, revoke, the loopback
// endpoint) are derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/mcp/McpSessionRegistry.ts at eb7b35ac.
import * as Crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import { AUTH_VERIFIER_CAPABILITY, type AuthVerifier, type Principal } from "@jhin/auth-api";
import { HOST_TRACE_CAPABILITY, type HostTrace } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { MCP_SERVER_CAPABILITY, type McpServer } from "@jhin/mcp-api";
import { createMcpServer } from "@jhin/mcp-bridge";
import { definePlugin, missingPermissions } from "@jhin/sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const MCP_PATH = "/mcp";
const MAX_BODY = 4 * 1024 * 1024;
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The header naming the thread whose agent calls (`Invocation.threadId`). */
export const THREAD_HEADER = "x-jhin-thread";
const THREAD_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
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

/** An agent credential: who its calls run as, and for which thread. */
interface Issued {
  readonly caller: Principal;
  readonly threadId?: string;
}

/** Agent credentials by the SHA-256 of their token; the token itself is never kept (D340). */
type Credentials = Map<string, Issued>;

const digest = (token: string) => Crypto.createHash("sha256").update(token).digest("hex");

/** The endpoint as the node's own machine reaches it: loopback when HTTP listens everywhere. */
export function localEndpoint(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === "0.0.0.0") parsed.hostname = "127.0.0.1";
  else if (parsed.hostname === "[::]") parsed.hostname = "[::1]";
  return `${parsed.origin}${MCP_PATH}`;
}

/** Whether a caller may run a command; the kernel checks the same on every call. */
const allowed = (caller: Principal, permissions: readonly string[]) =>
  missingPermissions(caller.permissions, permissions).length === 0;

/**
 * Where an MCP client finds how to sign in (security.md D1191): the
 * request's own origin, so loopback, a proxy and Tailscale Serve each name
 * theirs. `jhin.mcp-oauth` answers there; without it the client keeps to tokens.
 */
function resourceMetadataUrl(http: HttpServer, request: IncomingMessage): string {
  const origin = http.requestOrigin?.(request) ?? new URL(http.url).origin;
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length).trim() : undefined;
}

export default definePlugin({
  activate(context) {
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const verifier = context.services.get<AuthVerifier>(AUTH_VERIFIER_CAPABILITY);
    const trace = context.services.tryGet<HostTrace>(HOST_TRACE_CAPABILITY);
    // Kept across a reload of the plugin: the agents holding them keep running.
    let credentials = context.state.get<Credentials>("credentials");
    if (credentials === undefined) {
      credentials = new Map();
      context.state.set("credentials", credentials);
    }
    const issued = credentials;
    const url = localEndpoint(http.url);

    const service: McpServer = {
      url,
      issue(grant) {
        if (grant.permissions.includes("*")) {
          throw new Error("An agent credential names its permissions; `*` is the owner's");
        }
        const token = Crypto.randomBytes(32).toString("base64url");
        const hash = digest(token);
        issued.set(hash, {
          caller: { id: grant.id, permissions: [...grant.permissions] },
          ...(grant.threadId === undefined ? {} : { threadId: grant.threadId }),
        });
        return {
          url,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(grant.threadId === undefined ? {} : { [THREAD_HEADER]: grant.threadId }),
          },
          dispose: () => void issued.delete(hash),
        };
      },
    };
    context.services.provide(MCP_SERVER_CAPABILITY, service);
    /** An agent credential, else the node's own: its caller, and the thread it is bound to. */
    const authenticate = async (token: string | undefined): Promise<Issued | undefined> => {
      const agent = token === undefined ? undefined : issued.get(digest(token));
      if (agent !== undefined) return agent;
      const caller = await verifier.verify(token === undefined ? {} : { token });
      return caller === undefined ? undefined : { caller };
    };

    // Stateless Streamable HTTP: every POST is a complete MCP exchange.
    context.subscriptions.add(
      http.route("POST", MCP_PATH, async (request, response) => {
        const token = bearer(request);
        const authenticated = await authenticate(token);
        if (authenticated === undefined) {
          response
            .writeHead(401, {
              "content-type": "application/json",
              "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(http, request)}"`,
            })
            .end(JSON.stringify({ error: "unauthenticated" }));
          return;
        }
        let body: unknown;
        try {
          body = await readJson(request);
        } catch {
          response
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "bad body" }));
          return;
        }
        const header = request.headers["x-jhin-trace"];
        // Trace ids end up in logs: accept only short, plain ones.
        const traceId =
          typeof header === "string" && TRACE_ID.test(header) ? header : Crypto.randomUUID();
        const { caller } = authenticated;
        // An agent's credential is bound to its thread; only the node's own token names one.
        const named = request.headers[THREAD_HEADER];
        const threadId =
          authenticated.threadId ??
          (typeof named === "string" && THREAD_ID.test(named) ? named : undefined);
        // Aborted when the client goes away before its answer (D1501).
        const gone = new AbortController();
        const server = createMcpServer({
          list: async () =>
            context.commands.list().filter((command) => allowed(caller, command.permissions)),
          execute: (name, input) =>
            context.commands.execute(name, input, {
              traceId,
              caller,
              ...(threadId === undefined ? {} : { threadId }),
              signal: gone.signal,
            }),
        });
        // No session id generator: stateless mode.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        response.on("close", () => {
          if (!response.writableFinished) gone.abort();
          void transport.close();
          void server.close();
        });
        // The SDK's own types disagree under exactOptionalPropertyTypes; the objects match.
        await server.connect(transport as unknown as Transport);
        const handle = () => transport.handleRequest(request, response, body);
        await (trace === undefined ? handle() : trace.run(traceId, handle));
      }),
    );
    for (const method of ["GET", "DELETE"]) {
      context.subscriptions.add(
        http.route(method, MCP_PATH, (_request, response) => {
          response
            .writeHead(405, { "content-type": "application/json", allow: "POST" })
            .end(JSON.stringify({ error: "This server is stateless: POST only" }));
        }),
      );
    }
    context.log.info("mcp endpoint ready", { url });
  },
});
