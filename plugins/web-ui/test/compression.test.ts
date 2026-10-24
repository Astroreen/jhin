import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import type { HostPlugin } from "@jhin/host-api";
import { createTestKernel, mockCapability, type TestKernel } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import http from "../../http/src/index.ts";
import { negotiate } from "../src/encoding.ts";
import webUi from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

/** Text that compresses, at least `bytes` long. */
const filler = (bytes: number) => "const jhin = 'compress me';\n".repeat(Math.ceil(bytes / 28));
const INDEX = `<!doctype html><html><body><script>${filler(4096)}</script></body></html>`;
const APP = filler(8192);
const PLUGIN = filler(4096);

/** A built web client: index.html and a hashed asset with their siblings, an icon. */
function webDist(): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-web-ui-"));
  Fs.mkdirSync(Path.join(dir, "assets"));
  const write = (file: string, body: string) => {
    Fs.writeFileSync(Path.join(dir, file), body);
    Fs.writeFileSync(Path.join(dir, `${file}.br`), Zlib.brotliCompressSync(body));
    Fs.writeFileSync(Path.join(dir, `${file}.gz`), Zlib.gzipSync(body));
  };
  write("index.html", INDEX);
  write("assets/app-abc123.js", APP);
  Fs.writeFileSync(Path.join(dir, "favicon.png"), Buffer.alloc(2048, 7));
  return dir;
}

/** A client plugin package with a large and a small file. */
function clientPlugin(): HostPlugin {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-client-plugin-"));
  Fs.writeFileSync(Path.join(root, "index.js"), PLUGIN);
  Fs.writeFileSync(Path.join(root, "small.js"), "export {};\n");
  return {
    id: "user.big",
    root,
    layer: "user",
    // A long description makes /client/plugins larger than 1 KiB.
    manifest: { id: "user.big", side: "client", entry: "index.js", description: filler(2048) },
  };
}

const kernels: TestKernel[] = [];
/** The `dist/` of the node started last. */
let dist = "";
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

async function startNode(webUiConfig: Record<string, unknown> = {}): Promise<string> {
  const served = clientPlugin();
  const kernel = await createTestKernel({
    plugins: [
      { manifest: manifest("http"), definition: http },
      mockCapability("host.plugins", { list: () => [served], onChange: () => ({ dispose() {} }) }),
      { manifest: manifest("web-ui"), definition: webUi },
    ],
    config: {
      node: {
        "jhin.http": { port: 0 },
        "jhin.web-ui": { dir: (dist = webDist()), ...webUiConfig },
      },
    },
  });
  kernels.push(kernel);
  expect(kernel.inspect().plugins.filter((plugin) => plugin.status !== "active")).toEqual([]);
  return ((await kernel.commands.execute("http.info", {})) as { url: string }).url;
}

interface Reply {
  readonly status: number;
  readonly headers: Http.IncomingHttpHeaders;
  /** The body as it travelled. */
  readonly raw: Buffer;
  /** The body after its content-encoding is undone. */
  readonly text: string;
}

/** A request whose body is read as it arrived: fetch would decode it unasked. */
function request(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    Http.request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks);
        const coding = response.headers["content-encoding"];
        const decoded =
          raw.length === 0
            ? raw
            : coding === "br"
              ? Zlib.brotliDecompressSync(raw)
              : coding === "gzip"
                ? Zlib.gunzipSync(raw)
                : raw;
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          raw,
          text: decoded.toString(),
        });
      });
    })
      .on("error", reject)
      .end();
  });
}

describe("negotiate (loading.md D1583)", () => {
  it("prefers br, then gzip, honours q=0 and *", () => {
    expect(negotiate("gzip, deflate, br")).toBe("br");
    expect(negotiate("gzip;q=0.1, br;q=0.9")).toBe("br");
    expect(negotiate("br;q=0, gzip")).toBe("gzip");
    expect(negotiate("BR")).toBe("br");
    expect(negotiate("*")).toBe("br");
    expect(negotiate("*;q=0, gzip")).toBe("gzip");
    expect(negotiate("br;q=0, gzip;q=0")).toBeUndefined();
    expect(negotiate("identity")).toBeUndefined();
    expect(negotiate(undefined)).toBeUndefined();
    expect(negotiate("br, gzip", ["gzip"])).toBe("gzip");
  });
});

describe("jhin.web-ui compression (loading.md D1582–D1586)", () => {
  it("sends the built sibling the browser accepts, with vary and its own length", async () => {
    const url = await startNode();
    const cases: [string | undefined, string | undefined][] = [
      ["gzip, deflate, br", "br"],
      ["gzip", "gzip"],
      ["br;q=0, gzip", "gzip"],
      [undefined, undefined],
    ];
    for (const [accept, coding] of cases) {
      const reply = await request(
        `${url}/assets/app-abc123.js`,
        accept === undefined ? {} : { "accept-encoding": accept },
      );
      expect(reply.status).toBe(200);
      expect(reply.headers["content-encoding"]).toBe(coding);
      expect(reply.headers["vary"]).toBe("accept-encoding");
      expect(Number(reply.headers["content-length"])).toBe(reply.raw.length);
      expect(reply.text).toBe(APP);
      expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(reply.headers["etag"]).toBeUndefined();
    }
    const icon = await request(`${url}/favicon.png`, { "accept-encoding": "br" });
    expect(icon.headers["content-encoding"]).toBeUndefined();
    expect(icon.headers["vary"]).toBeUndefined();
  });

  it("negotiates index.html for an app route, validates it, and answers HEAD alike", async () => {
    const url = await startNode();
    const page = await request(`${url}/threads/t1`, { "accept-encoding": "br" });
    expect(page.headers["content-encoding"]).toBe("br");
    expect(page.text).toBe(INDEX);
    expect(page.headers["cache-control"]).toBe("no-cache");
    const tag = page.headers["etag"];
    expect(tag).toMatch(/^W\/"/);

    const plain = await request(`${url}/`);
    expect(plain.headers["etag"]).toBe(tag);
    expect(plain.headers["vary"]).toBe("accept-encoding");

    const again = await request(`${url}/threads/t1`, {
      "accept-encoding": "br",
      "if-none-match": tag!,
    });
    expect(again.status).toBe(304);
    expect(again.raw.length).toBe(0);
    expect(again.headers["etag"]).toBe(tag);

    const head = await request(`${url}/threads/t1`, { "accept-encoding": "gzip" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.raw.length).toBe(0);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(Number(head.headers["content-length"])).toBe(Zlib.gzipSync(INDEX).length);
  });

  it("skips a sibling older than its file", async () => {
    const url = await startNode();
    const file = Path.join(dist, "index.html");
    Fs.writeFileSync(file, `${INDEX}<!-- edited -->`);
    const later = new Date(Fs.statSync(`${file}.br`).mtimeMs + 10_000);
    Fs.utimesSync(file, later, later);
    const page = await request(`${url}/`, { "accept-encoding": "br, gzip" });
    expect(page.headers["content-encoding"]).toBeUndefined();
    expect(page.text).toBe(`${INDEX}<!-- edited -->`);
  });

  it("compresses client plugin files and /client JSON on the fly, never the event stream", async () => {
    const url = await startNode();
    const list = await request(`${url}/client/plugins`, { "accept-encoding": "br" });
    expect(list.headers["content-encoding"]).toBe("br");
    expect(Number(list.headers["content-length"])).toBe(list.raw.length);
    const [entry] = JSON.parse(list.text) as { entry: string }[];

    const file = await request(`${url}${entry!.entry}`, { "accept-encoding": "gzip" });
    expect(file.headers["content-encoding"]).toBe("gzip");
    expect(file.headers["vary"]).toBe("accept-encoding");
    expect(file.text).toBe(PLUGIN);
    expect(file.raw.length).toBeLessThan(PLUGIN.length / 4);
    const unchanged = await request(`${url}${entry!.entry}`, {
      "if-none-match": file.headers["etag"]!,
    });
    expect(unchanged.status).toBe(304);

    const small = await request(`${url}${entry!.entry.replace("index.js", "small.js")}`, {
      "accept-encoding": "br",
    });
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.text).toBe("export {};\n");

    const config = await request(`${url}/client/config`, { "accept-encoding": "br" });
    expect(config.status).toBe(200);
    expect(config.headers["etag"]).toMatch(/^W\/"/);
    const same = await request(`${url}/client/config`, {
      "if-none-match": config.headers["etag"]!,
    });
    expect(same.status).toBe(304);

    const events = await new Promise<Http.IncomingMessage>((resolve, reject) => {
      const sent = Http.get(
        `${url}/client/events`,
        { headers: { "accept-encoding": "br, gzip" } },
        (response) => {
          resolve(response);
          sent.destroy();
        },
      );
      sent.on("error", (error) => (error.message === "socket hang up" ? undefined : reject(error)));
    });
    expect(events.headers["content-type"]).toBe("text/event-stream");
    expect(events.headers["content-encoding"]).toBeUndefined();
  });

  it("sends everything as it is when compression is off, and keeps the validators", async () => {
    const url = await startNode({ compression: false });
    const page = await request(`${url}/`, { "accept-encoding": "br, gzip" });
    expect(page.headers["content-encoding"]).toBeUndefined();
    expect(page.headers["vary"]).toBeUndefined();
    expect(page.text).toBe(INDEX);
    expect((await request(`${url}/`, { "if-none-match": page.headers["etag"]! })).status).toBe(304);
    const list = await request(`${url}/client/plugins`, { "accept-encoding": "br" });
    expect(list.headers["content-encoding"]).toBeUndefined();
  });
});
