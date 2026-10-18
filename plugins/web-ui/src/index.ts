import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

import { UI_CONFIG_SECTION, UiConfig } from "@jhin/client-api";
import { HOST_PLUGINS_CAPABILITY, type HostPlugins } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpHandler, type HttpServer } from "@jhin/http-api";
import { definePlugin, z } from "@jhin/sdk";

const require = Module.createRequire(import.meta.url);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const Config = z.object({
  /** Directory of the built web client; defaults to the @jhin/web package's dist/. */
  dir: z.string().optional(),
});

const CLIENT = "/client";

// Client plugin files and `jhin.ui` are served without a token: the browser needs
// them before it has one, like the page itself. Nothing else of the node is.

/** True for plugins whose code runs in the web client. */
const forClient = (manifest: unknown) => {
  const side = (manifest as { side?: unknown } | undefined)?.side;
  return side === "client" || side === "both";
};

export default definePlugin({
  activate(context) {
    context.config.define("jhin.web-ui", Config);
    context.config.define(UI_CONFIG_SECTION, UiConfig);
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const hostPlugins = context.services.get<HostPlugins>(HOST_PLUGINS_CAPABILITY);
    const dir = Path.resolve(
      context.config.get<z.output<typeof Config>>("jhin.web-ui").dir ??
        Path.join(Path.dirname(require.resolve("@jhin/web/package.json")), "dist"),
    );
    const index = Path.join(dir, "index.html");
    if (!Fs.existsSync(index)) {
      throw new Error(
        `The web client is not built: ${index} is missing (run: vp run --filter @jhin/web build)`,
      );
    }

    const serve: HttpHandler = (request, response) => {
      const send = (status: number, text: string) =>
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      } catch {
        send(400, "Bad path");
        return;
      }
      const file = Path.join(dir, Path.normalize(pathname));
      // Never outside the client's directory.
      const inside = file.startsWith(`${dir}${Path.sep}`);
      const exists = inside && Fs.existsSync(file) && Fs.statSync(file).isFile();
      // A missing file is a 404; only extensionless paths are app routes served by index.html.
      if (!exists && Path.extname(pathname) !== "") {
        send(404, "Not found");
        return;
      }
      const target = exists ? file : index;
      const hashed = target.includes(`${Path.sep}assets${Path.sep}`);
      response.writeHead(200, {
        "content-type": TYPES[Path.extname(target)] ?? "application/octet-stream",
        "content-length": Fs.statSync(target).size,
        "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      if (request.method === "HEAD") response.end();
      else Fs.createReadStream(target).pipe(response);
    };
    // --- Client plugins (D16): listed, served under a revision, changes pushed. ---
    const revisions = new Map<string, number>();
    // Browsers run JavaScript: a client plugin whose entry is not .js/.mjs (e.g. a
    // TypeScript source of a `both` plugin) is reported in the log, not served.
    const runnable = (plugin: { id: string; manifest: unknown }) => {
      const entry = String((plugin.manifest as { entry?: unknown }).entry ?? "");
      if (/\.m?js$/.test(entry)) return true;
      if (!warned.has(plugin.id)) {
        warned.add(plugin.id);
        context.log.warn("client plugin not served: its entry is not JavaScript", {
          plugin: plugin.id,
          entry,
        });
      }
      return false;
    };
    const warned = new Set<string>();
    const clientPlugins = () =>
      hostPlugins.list().filter((plugin) => forClient(plugin.manifest) && runnable(plugin));
    const json = (response: Parameters<HttpHandler>[1], value: unknown): void => {
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" })
        .end(JSON.stringify(value));
    };

    context.subscriptions.add(
      http.route("GET", `${CLIENT}/plugins`, (_request, response) =>
        json(
          response,
          clientPlugins().map((plugin) => {
            const rev = revisions.get(plugin.id) ?? 1;
            const entry = String((plugin.manifest as { entry?: unknown }).entry ?? "index.js");
            return {
              manifest: plugin.manifest,
              rev,
              entry: `${CLIENT}/plugins/${plugin.id}/${rev}/${entry}`,
            };
          }),
        ),
      ),
    );
    // `/client/plugins/<id>/<rev>/<file>`: the revision is part of the path, so a
    // changed plugin's relative imports resolve to fresh URLs as well.
    context.subscriptions.add(
      http.route("GET", `${CLIENT}/plugins/*`, (request, response) => {
        const parts = new URL(request.url ?? "/", "http://localhost").pathname.split("/").slice(3);
        const [id, _rev, ...rest] = parts;
        const plugin = clientPlugins().find((candidate) => candidate.id === id);
        let relative: string;
        try {
          relative = decodeURIComponent(rest.join("/"));
        } catch {
          response.writeHead(400).end();
          return;
        }
        const file =
          plugin === undefined ? undefined : Path.join(plugin.root, Path.normalize(relative));
        // Containment is checked on real paths: a symlink cannot lead outside the plugin.
        const real = file !== undefined && Fs.existsSync(file) ? Fs.realpathSync(file) : undefined;
        if (
          plugin === undefined ||
          real === undefined ||
          !real.startsWith(`${Fs.realpathSync(plugin.root)}${Path.sep}`) ||
          !Fs.statSync(real).isFile()
        ) {
          response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
          return;
        }
        response.writeHead(200, {
          "content-type": TYPES[Path.extname(real)] ?? "application/octet-stream",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        });
        Fs.createReadStream(real).pipe(response);
      }),
    );
    context.subscriptions.add(
      http.route("GET", `${CLIENT}/config`, (_request, response) =>
        json(response, { [UI_CONFIG_SECTION]: context.config.get(UI_CONFIG_SECTION) }),
      ),
    );

    // Server-sent events: `plugin` {id, rev} when a client plugin's files change,
    // `config` when the jhin.ui section changes.
    const streams = new Set<Parameters<HttpHandler>[1]>();
    const broadcast = (event: string, data: unknown) => {
      for (const stream of streams)
        stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    context.subscriptions.add(
      http.route("GET", `${CLIENT}/events`, (request, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");
        streams.add(response);
        request.on("close", () => streams.delete(response));
      }),
    );
    context.subscriptions.add(
      hostPlugins.onChange(({ id }) => {
        if (!clientPlugins().some((plugin) => plugin.id === id)) return;
        const rev = (revisions.get(id) ?? 1) + 1;
        revisions.set(id, rev);
        context.log.info("client plugin changed", { plugin: id, rev });
        broadcast("plugin", { id, rev });
      }),
    );
    context.config.onDidChange(UI_CONFIG_SECTION, () => broadcast("config", {}));
    // Comments keep idle proxies from closing the stream.
    const keepAlive = setInterval(() => {
      for (const stream of streams) stream.write(": keep-alive\n\n");
    }, 25_000);
    context.subscriptions.add({
      dispose() {
        clearInterval(keepAlive);
        for (const stream of streams) stream.end();
        streams.clear();
      },
    });

    context.subscriptions.add(http.route("GET", "/*", serve));
    context.subscriptions.add(http.route("HEAD", "/*", serve));
    context.commands.register({
      name: "web-ui.info",
      description: "Where this node serves the web client",
      input: z.object({}),
      output: z.object({ url: z.string(), dir: z.string() }),
      handler: () => ({ url: `${http.url}/`, dir }),
    });
    context.log.info("web client served", { url: `${http.url}/`, dir });
  },
});
