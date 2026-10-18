import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

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

export default definePlugin({
  activate(context) {
    context.config.define("jhin.web-ui", Config);
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
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
