import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
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

    context.subscriptions.add(
      http.route("GET", "/*", (request, response) => {
        const pathname = decodeURIComponent(
          new URL(request.url ?? "/", "http://localhost").pathname,
        );
        const file = Path.join(dir, Path.normalize(pathname));
        // Never outside the client's directory; unknown paths are app routes.
        const inside = file.startsWith(`${dir}${Path.sep}`);
        const target = inside && Fs.existsSync(file) && Fs.statSync(file).isFile() ? file : index;
        const hashed = target.includes(`${Path.sep}assets${Path.sep}`);
        response.writeHead(200, {
          "content-type": TYPES[Path.extname(target)] ?? "application/octet-stream",
          "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        Fs.createReadStream(target).pipe(response);
      }),
    );
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
