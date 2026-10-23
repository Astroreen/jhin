import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import type { HttpHandler, HttpServer } from "@jhin/http-api";
import { toDisposable, type Logger } from "@jhin/sdk";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { serveAuthHttp } from "../src/http.ts";

const quiet = (): Logger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: quiet,
});

const servers: Http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * The session endpoints on a real listener, behind an `http.server` whose
 * `requestOrigin` answers `origin` (or which has none, as before 1.3).
 */
async function sessionCookie(origin: string | undefined): Promise<string> {
  const routes = new Map<string, HttpHandler>();
  const server = Http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    void routes.get(`${request.method} ${path}`)?.(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const http: HttpServer = {
    url,
    route(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
      return toDisposable(() => routes.delete(`${method} ${path}`));
    },
    upgrade: () => toDisposable(() => undefined),
    clientAddress: () => "127.0.0.1",
    requestedHost: (request) => request.headers.host,
    ...(origin === undefined ? {} : { requestOrigin: () => origin }),
  };
  serveAuthHttp({
    http,
    log: quiet(),
    attempts: new Map(),
    pair: () => undefined,
    openSession: async () => ({ id: "c", token: "jhd1.c.secret", permissions: ["*"] }),
    verify: async () => undefined,
    closeSession: () => undefined,
  });
  const response = await fetch(`${url}/auth/session`, {
    method: "POST",
    // A forwarded protocol the client sent itself: never what decides (D1363).
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ credential: "anything" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!;
}

describe("the session cookie's Secure flag (security.md D1363)", () => {
  it("follows requestOrigin, never the client's X-Forwarded-Proto", async () => {
    expect(await sessionCookie("https://node.example")).toContain("Secure");
    expect(await sessionCookie("http://node.example")).not.toContain("Secure");
  });

  it("without requestOrigin, is Secure on a TLS socket only", async () => {
    expect(await sessionCookie(undefined)).not.toContain("Secure");
  });
});
