import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";
import * as Stream from "node:stream";

import {
  KEYBINDINGS_CONFIG_SECTION,
  KeybindingsConfig,
  UI_CONFIG_SECTION,
  UiConfig,
} from "@jhin/client-api";
import { HOST_PLUGINS_CAPABILITY, type HostPlugins } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpHandler, type HttpServer } from "@jhin/http-api";
import { definePlugin, z } from "@jhin/sdk";

import {
  MIN_COMPRESS_BYTES,
  bodyTag,
  compress,
  compressible,
  compressor,
  fileTag,
  matches,
  negotiate,
  type Coding,
} from "./encoding.ts";

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

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
const Config = z
  .object({
    dir: z.string().optional().meta({
      title: "Web client directory",
      description: "Directory of the built web client; defaults to the @jhin/web package's dist/.",
      advanced: true,
    }),
    // docs/plans/loading.md D1586.
    compression: z.boolean().default(true).meta({
      title: "Compression",
      description:
        "Send the web client and its plugins compressed (brotli or gzip) to browsers that accept it. Turn off when a reverse proxy compresses instead.",
      advanced: true,
    }),
  })
  .meta({ title: "Web client", description: "The web client this node serves." });

const CLIENT = "/client";

/** File types served from client plugin packages. */
const SERVABLE: Readonly<Record<string, true>> = {
  ".js": true,
  ".mjs": true,
  ".css": true,
  ".json": true,
  ".svg": true,
  ".png": true,
  ".woff2": true,
};

// Client plugin files and the client's config sections (`jhin.ui`,
// `jhin.keybindings`) are served without a token: the browser needs them before
// it has one, like the page itself. Nothing else of the node is.

/** True for plugins whose code runs in the web client. */
const forClient = (manifest: unknown) => {
  const side = (manifest as { side?: unknown } | undefined)?.side;
  return side === "client" || side === "both";
};

export default definePlugin({
  activate(context) {
    context.config.define("jhin.web-ui", Config);
    context.config.define(UI_CONFIG_SECTION, UiConfig);
    context.config.define(KEYBINDINGS_CONFIG_SECTION, KeybindingsConfig);
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const hostPlugins = context.services.get<HostPlugins>(HOST_PLUGINS_CAPABILITY);
    const dir = Path.resolve(
      context.config.get<z.output<typeof Config>>("jhin.web-ui").dir ??
        Path.join(Path.dirname(require.resolve("@jhin/web/package.json")), "dist"),
    );
    const index = Path.join(dir, "index.html");
    const compression = () =>
      context.config.get<z.output<typeof Config>>("jhin.web-ui").compression !== false;
    /** The compressed siblings the build wrote next to `file` (D1582). */
    const SIBLING: Record<Coding, string> = { br: ".br", gzip: ".gz" };
    const siblings = (file: string): Coding[] =>
      (["br", "gzip"] as const).filter((coding) => Fs.existsSync(`${file}${SIBLING[coding]}`));
    /**
     * The headers every response of a no-cache body shares, and whether the
     * request already holds it (D1585): then it gets `304` and no body.
     */
    const validated = (
      request: Parameters<HttpHandler>[0],
      response: Parameters<HttpHandler>[1],
      headers: Record<string, string | number>,
      tag: string,
    ): boolean => {
      headers["etag"] = tag;
      if (!matches(request.headers["if-none-match"], tag)) return false;
      response.writeHead(304, headers).end();
      return true;
    };
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
      const stat = Fs.statSync(target);
      const zipped = compression() && compressible(Path.extname(target));
      const headers: Record<string, string | number> = {
        "content-type": TYPES[Path.extname(target)] ?? "application/octet-stream",
        "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      };
      // Also on a plain body: a cache in between must not hand it a compressed one (D1583).
      if (zipped) headers["vary"] = "accept-encoding";
      if (!hashed && validated(request, response, headers, fileTag(stat))) return;
      const coding = zipped
        ? negotiate(request.headers["accept-encoding"], siblings(target))
        : undefined;
      const body = coding === undefined ? target : `${target}${SIBLING[coding]}`;
      if (coding !== undefined) headers["content-encoding"] = coding;
      headers["content-length"] = coding === undefined ? stat.size : Fs.statSync(body).size;
      response.writeHead(200, headers);
      if (request.method === "HEAD") response.end();
      else Fs.createReadStream(body).pipe(response);
    };
    // --- Client plugins (D16): listed, served under a revision, changes pushed. ---
    // Revisions are times: they only grow, also across node restarts, so a
    // browser never meets a revision path it already cached from older code.
    const startedAt = Date.now();
    const revisions = new Map<string, number>();
    // Browsers run JavaScript: a client plugin whose entry is not .js/.mjs (e.g. a
    // TypeScript source of a `both` plugin) is reported in the log, not served.
    const warned = new Set<string>();
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
    const clientPlugins = () =>
      hostPlugins.list().filter((plugin) => forClient(plugin.manifest) && runnable(plugin));
    /** A no-cache JSON body: tagged by its hash (D1585), compressed as it is sent (D1584). */
    const json = (
      request: Parameters<HttpHandler>[0],
      response: Parameters<HttpHandler>[1],
      value: unknown,
    ): void => {
      const body = Buffer.from(JSON.stringify(value));
      const headers: Record<string, string | number> = {
        "content-type": "application/json",
        "cache-control": "no-cache",
      };
      const zipped = compression();
      if (zipped) headers["vary"] = "accept-encoding";
      if (validated(request, response, headers, bodyTag(body))) return;
      const coding =
        zipped && body.length >= MIN_COMPRESS_BYTES
          ? negotiate(request.headers["accept-encoding"])
          : undefined;
      if (coding === undefined) {
        response.writeHead(200, { ...headers, "content-length": body.length }).end(body);
        return;
      }
      compress(coding, body).then(
        (compressed) =>
          response
            .writeHead(200, {
              ...headers,
              "content-encoding": coding,
              "content-length": compressed.length,
            })
            .end(compressed),
        (error: unknown) => {
          context.log.error("compressing a response failed", { error: String(error) });
          response.writeHead(500).end();
        },
      );
    };

    context.subscriptions.add(
      http.route("GET", `${CLIENT}/plugins`, (request, response) =>
        json(
          request,
          response,
          clientPlugins().map((plugin) => {
            const rev = revisions.get(plugin.id) ?? startedAt;
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
        const notFound = () =>
          response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        // Only what a browser loads: no dotfiles, no node_modules, known types only.
        const segments = relative.split(/[\\/]/);
        if (
          plugin === undefined ||
          segments.some((segment) => segment.startsWith(".") || segment === "node_modules") ||
          SERVABLE[Path.extname(relative)] !== true
        ) {
          notFound();
          return;
        }
        let real: string;
        try {
          // Containment is checked on real paths: a symlink cannot lead outside the plugin.
          real = Fs.realpathSync(Path.join(plugin.root, Path.normalize(relative)));
          if (
            !real.startsWith(`${Fs.realpathSync(plugin.root)}${Path.sep}`) ||
            !Fs.statSync(real).isFile()
          ) {
            notFound();
            return;
          }
        } catch {
          // Missing, or gone between discovery and this request.
          notFound();
          return;
        }
        const stat = Fs.statSync(real);
        const zipped = compression() && compressible(Path.extname(real));
        const headers: Record<string, string | number> = {
          "content-type": TYPES[Path.extname(real)] ?? "application/octet-stream",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        };
        if (zipped) headers["vary"] = "accept-encoding";
        if (validated(request, response, headers, fileTag(stat))) return;
        // Not built by @jhin/web, so compressed as it is read (D1584).
        const coding =
          zipped && stat.size >= MIN_COMPRESS_BYTES
            ? negotiate(request.headers["accept-encoding"])
            : undefined;
        if (coding === undefined) {
          response.writeHead(200, { ...headers, "content-length": stat.size });
          Fs.createReadStream(real).pipe(response);
          return;
        }
        response.writeHead(200, { ...headers, "content-encoding": coding });
        Stream.pipeline(Fs.createReadStream(real), compressor(coding), response, () => undefined);
      }),
    );
    context.subscriptions.add(
      http.route("GET", `${CLIENT}/config`, (request, response) =>
        json(request, response, {
          [UI_CONFIG_SECTION]: context.config.get(UI_CONFIG_SECTION),
          [KEYBINDINGS_CONFIG_SECTION]: context.config.get(KEYBINDINGS_CONFIG_SECTION),
        }),
      ),
    );

    // Server-sent events, never compressed: a compressor buffers, and an event
    // must arrive when it is written (D1584). `plugin` {id, rev} when a client plugin's files change,
    // `plugins` when client plugins are added, removed or change manifest (clients re-read the
    // list), `config` when the jhin.ui or jhin.keybindings section changes.
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
    const bump = (id: string) => {
      const rev = Math.max(Date.now(), (revisions.get(id) ?? startedAt) + 1);
      revisions.set(id, rev);
      return rev;
    };
    // The ids of the client plugins clients were last told about.
    let listed = new Set(clientPlugins().map((plugin) => plugin.id));
    context.subscriptions.add(
      hostPlugins.onChange(({ id, files }) => {
        const current = new Set(clientPlugins().map((plugin) => plugin.id));
        // A plugin added, removed or with a new manifest changes the list: clients re-read it.
        const manifest = files.some((file) => Path.basename(file) === "package.json");
        if (manifest || listed.has(id) !== current.has(id)) {
          const concerned = listed.has(id) || current.has(id);
          listed = current;
          if (!concerned) return;
          // A fresh revision path: the package may be another one than before.
          // Kept after a removal on purpose (one number per id): a package
          // re-added under that id must not get a path a browser has cached.
          bump(id);
          context.log.info("client plugins changed", { plugin: id });
          broadcast("plugins", {});
          return;
        }
        if (!current.has(id)) return;
        const rev = bump(id);
        context.log.info("client plugin changed", { plugin: id, rev });
        broadcast("plugin", { id, rev });
      }),
    );
    context.config.onDidChange(UI_CONFIG_SECTION, () => broadcast("config", {}));
    context.config.onDidChange(KEYBINDINGS_CONFIG_SECTION, () => broadcast("config", {}));
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
