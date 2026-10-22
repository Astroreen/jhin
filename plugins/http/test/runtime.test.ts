import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { IncomingMessage } from "node:http";

import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { definePlugin } from "@jhin/sdk";
import { createTestKernel, mockCapability, testManifest, type TestKernel } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import http from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

const kernels: TestKernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

async function start(data: string): Promise<{ kernel: TestKernel; url: string }> {
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      { manifest, definition: http },
    ],
    config: { node: { "jhin.http": { port: 0 } } },
  });
  kernels.push(kernel);
  const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
  return { kernel, url };
}

const runtimeFile = (data: string) => Path.join(data, "jhin.http", "runtime.json");
const read = (data: string) =>
  JSON.parse(Fs.readFileSync(runtimeFile(data), "utf8")) as Record<string, unknown>;

describe("where a running node listens (security.md D1184)", () => {
  it("writes runtime.json (0600, no secret) and answers /.well-known/jhin with its instance", async () => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-http-runtime-"));
    const { kernel, url } = await start(data);
    const state = read(data);
    expect(state).toEqual({
      url,
      pid: process.pid,
      instance: expect.stringMatching(/^[\w-]{22}$/),
      startedAt: expect.any(Number),
    });
    expect(Fs.statSync(runtimeFile(data)).mode & 0o777).toBe(0o600);

    const response = await fetch(`${url}/.well-known/jhin`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ instance: state["instance"] });

    await kernel.stop();
    kernels.splice(kernels.indexOf(kernel), 1);
    expect(Fs.existsSync(runtimeFile(data))).toBe(false);
  });

  it("leaves the file of a newer start alone, and makes a new instance each start", async () => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-http-runtime-"));
    const first = await start(data);
    const firstInstance = read(data)["instance"];
    const second = await start(data);
    const secondState = read(data);
    expect(secondState["instance"]).not.toBe(firstInstance);
    expect(secondState["url"]).toBe(second.url);

    await first.kernel.stop();
    kernels.splice(kernels.indexOf(first.kernel), 1);
    expect(read(data)).toEqual(secondState);
  });
});

describe("a home that cannot take runtime.json (security.md D1184)", () => {
  it("still serves, without the file", async () => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-http-runtime-"));
    // The data directory is a file: nothing can be written under it.
    Fs.writeFileSync(Path.join(data, "jhin.http"), "");
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("host.paths", { home: data, dataDir: (id: string) => Path.join(data, id) }),
        { manifest, definition: http },
      ],
      config: { node: { "jhin.http": { port: 0 } } },
    });
    kernels.push(kernel);
    const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
    expect((await fetch(`${url}/.well-known/jhin`)).status).toBe(200);
  });
});

describe("the origin a client asked for (security.md D1191)", () => {
  it("is the requested host; https only for TLS or a forwarded https from a trusted or loopback peer", async () => {
    let server: HttpServer | undefined;
    const kernel = await createTestKernel({
      plugins: [
        { manifest, definition: http },
        {
          manifest: testManifest("test.origin", {
            side: "server",
            requires: { [HTTP_SERVER_CAPABILITY]: "^1.3" },
          }),
          definition: definePlugin({
            activate(context) {
              server = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
            },
          }),
        },
      ],
      config: { node: { "jhin.http": { port: 0 } } },
    });
    kernels.push(kernel);
    const request = (headers: Record<string, string>, remoteAddress: string) =>
      ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;
    const listening = new URL(server!.url).host;
    expect(server!.requestOrigin!(request({ host: "node:7777" }, "127.0.0.1"))).toBe(
      "http://node:7777",
    );
    expect(
      server!.requestOrigin!(
        request({ host: "studio.ts.net", "x-forwarded-proto": "https" }, "127.0.0.1"),
      ),
    ).toBe("https://studio.ts.net");
    // From a peer that is neither loopback nor trusted, the header is ignored.
    expect(
      server!.requestOrigin!(
        request({ host: "studio.ts.net", "x-forwarded-proto": "https" }, "10.0.0.9"),
      ),
    ).toBe("http://studio.ts.net");
    // A Host that is not a plain host and port falls back to the listening address.
    expect(server!.requestOrigin!(request({ host: 'evil"/x' }, "127.0.0.1"))).toBe(
      `http://${listening}`,
    );
  });
});
