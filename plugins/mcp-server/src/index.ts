import * as Crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import { AUTH_VERIFIER_CAPABILITY, type AuthVerifier } from "@jhin/auth-api";
import { HOST_TRACE_CAPABILITY, type HostTrace } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { createMcpServer } from "@jhin/mcp-bridge";
import { definePlugin } from "@jhin/sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const MCP_PATH = "/mcp";
const MAX_BODY = 4 * 1024 * 1024;
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length).trim() : undefined;
}

export default definePlugin({
  activate(context) {
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const verifier = context.services.get<AuthVerifier>(AUTH_VERIFIER_CAPABILITY);
    const trace = context.services.tryGet<HostTrace>(HOST_TRACE_CAPABILITY);

    // Stateless Streamable HTTP: every POST is a complete MCP exchange.
    context.subscriptions.add(
      http.route("POST", MCP_PATH, async (request, response) => {
        const token = bearer(request);
        const caller = await verifier.verify(token === undefined ? {} : { token });
        if (caller === undefined) {
          response
            .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
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
        const server = createMcpServer({
          list: async () => context.commands.list(),
          execute: (name, input) => context.commands.execute(name, input, { traceId, caller }),
        });
        // No session id generator: stateless mode.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        response.on("close", () => {
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
    context.log.info("mcp endpoint ready", { url: `${http.url}${MCP_PATH}` });
  },
});
