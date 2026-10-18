import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import {
  HTTP_SERVER_CAPABILITY,
  type HttpHandler,
  type HttpServer,
  type UpgradeHandler,
} from "@jhin/http-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";

const Config = z.object({
  /** Interface to listen on. The default only accepts local connections. */
  host: z.string().default("127.0.0.1"),
  /** 0 picks a free port. */
  port: z.number().int().min(0).max(65_535).default(7777),
});

interface Route {
  readonly method: string;
  readonly path: string;
  readonly prefix: boolean;
  readonly handler: HttpHandler;
}

function pathOf(request: Http.IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

export default definePlugin({
  async activate(context) {
    context.config.define("jhin.http", Config);
    const config = context.config.get<z.output<typeof Config>>("jhin.http");
    const routes = new Set<Route>();
    const upgrades = new Map<string, UpgradeHandler>();

    const server = Http.createServer((request, response) => {
      const path = pathOf(request);
      const method = request.method ?? "GET";
      const route = [...routes]
        .filter(
          (candidate) =>
            candidate.method === method &&
            (candidate.prefix ? path.startsWith(candidate.path) : path === candidate.path),
        )
        .toSorted((a, b) => b.path.length - a.path.length)[0];
      if (route === undefined) {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      Promise.resolve(route.handler(request, response)).catch((error: unknown) => {
        context.log.error("http handler failed", { method, path, error: String(error) });
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end("Internal error");
      });
    });
    server.on("upgrade", (request, socket, head) => {
      const handler = upgrades.get(pathOf(request));
      if (handler === undefined) {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      handler(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "EADDRINUSE"
            ? new Error(`Port ${config.port} on ${config.host} is in use; set jhin.http.port`)
            : error,
        ),
      );
      server.listen(config.port, config.host, () => resolve());
    });
    const address = server.address() as AddressInfo;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    const url = `http://${host}:${address.port}`;
    context.subscriptions.add({
      dispose() {
        server.closeAllConnections();
        server.close();
      },
    });

    const api: HttpServer = {
      url,
      route(method, path, handler) {
        const prefix = path.endsWith("/*");
        const route: Route = {
          method: method.toUpperCase(),
          path: prefix ? path.slice(0, -1) : path,
          prefix,
          handler,
        };
        routes.add(route);
        return toDisposable(() => routes.delete(route));
      },
      upgrade(path, handler) {
        if (upgrades.has(path)) throw new Error(`An upgrade handler for ${path} already exists`);
        upgrades.set(path, handler);
        return toDisposable(() => {
          if (upgrades.get(path) === handler) upgrades.delete(path);
        });
      },
    };
    context.services.provide(HTTP_SERVER_CAPABILITY, api);
    context.commands.register({
      name: "http.info",
      description: "Where this node's HTTP server listens",
      input: z.object({}),
      output: z.object({ url: z.string() }),
      handler: () => ({ url }),
    });
    context.log.info("http listening", { url });
  },
});
