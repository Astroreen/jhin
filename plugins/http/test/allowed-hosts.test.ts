import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Os from "node:os";

import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { definePlugin } from "@jhin/sdk";
import { createTestKernel, testManifest, type TestKernel } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { fromBrowser, hostName, hostPolicy } from "../src/allowed-hosts.ts";
import http from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

const kernels: TestKernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

async function start(settings: Record<string, unknown> = {}) {
  let server: HttpServer | undefined;
  const kernel = await createTestKernel({
    plugins: [
      { manifest, definition: http },
      {
        manifest: testManifest("test.hosts", {
          side: "server",
          requires: { [HTTP_SERVER_CAPABILITY]: "^1.4" },
        }),
        definition: definePlugin({
          activate(context) {
            server = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
            context.subscriptions.add(
              server.route("GET", "/hello", (_request, response) => {
                response.writeHead(200, { "content-type": "text/plain" }).end("hello");
              }),
            );
            context.subscriptions.add(
              server.upgrade("/socket", (_request, socket) => {
                socket.end(
                  "HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n",
                );
              }),
            );
          },
        }),
      },
    ],
    config: { node: { "jhin.http": { port: 0, ...settings } } },
  });
  kernels.push(kernel);
  return { kernel, server: server!, port: new URL(server!.url).port };
}

/** A request with exactly these headers, as a browser on a rebound name would send it. */
function get(
  port: string,
  headers: Record<string, string>,
  path = "/hello",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = Http.request(
      { host: "127.0.0.1", port, path, headers, setHost: false, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** An upgrade with these headers; resolves with the status line's code. */
function upgrade(port: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = Http.request({
      host: "127.0.0.1",
      port,
      path: "/socket",
      setHost: false,
      agent: false,
      headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("the names a node answers to (security.md D1362)", () => {
  it("refuses a browser's request for a rebound name before any route or upgrade", async () => {
    const { port } = await start();
    const evil = `evil.example:${port}`;
    const refused = await get(port, { host: evil, origin: `http://${evil}` });
    expect(refused.status).toBe(403);
    expect(refused.body).toBe(
      `Blocked request: this node does not answer to the host ${evil}. Add it to jhin.http.allowedHosts.`,
    );
    // Sec-Fetch-Site marks a browser's GET without Origin,
    expect((await get(port, { host: evil, "sec-fetch-site": "same-origin" })).status).toBe(403);
    // and a page on plain http: gets no Sec-Fetch-* and sends no Origin with a
    // same-origin GET: its User-Agent still says it is a browser.
    expect(
      (
        await get(port, {
          host: evil,
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0",
        })
      ).status,
    ).toBe(403);
    expect(await upgrade(port, { host: evil, origin: `http://${evil}` })).toBe(403);

    // Not a browser: the CLI, nodes and MCP clients choose their Host freely.
    expect(await get(port, { host: evil })).toEqual({ status: 200, body: "hello" });
    expect(await get(port, { host: evil, "sec-fetch-mode": "cors" })).toMatchObject({
      status: 200,
    });
    expect(await upgrade(port, { host: evil })).toBe(101);
  });

  it("answers browsers by its addresses, loopback, machine and Tailscale names", async () => {
    const { port } = await start();
    const machine = Os.hostname().toLowerCase();
    for (const host of [
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `192.168.1.20:${port}`,
      `localhost:${port}`,
      `app.localhost:${port}`,
      `${machine}:${port}`,
      `${machine.split(".")[0]}.local:${port}`,
      "studio.tail1234.ts.net",
    ]) {
      expect(await get(port, { host, origin: `http://${host}` }), host).toMatchObject({
        status: 200,
      });
      expect(await upgrade(port, { host, origin: `http://${host}` }), host).toBe(101);
    }
  });

  it("answers names listed in jhin.http.allowedHosts or added by a plugin, until disposed", async () => {
    const { server, port } = await start({ allowedHosts: ["nas.lan", ".example.com"] });
    const status = async (host: string) =>
      (await get(port, { host, "sec-fetch-site": "none" })).status;
    expect(await status(`NAS.lan:${port}`)).toBe(200);
    expect(await status("example.com")).toBe(200);
    expect(await status("jhin.example.com")).toBe(200);
    expect(await status("badexample.com")).toBe(403);

    expect(await status("mesh.example.org")).toBe(403);
    const allowed = server.allowHost!("mesh.example.org:7777");
    expect(await status(`mesh.example.org:${port}`)).toBe(200);
    allowed.dispose();
    expect(await status("mesh.example.org")).toBe(403);
    // Only the owner turns the check off.
    expect(() => server.allowHost!("*")).toThrow("allowHost takes a name, not *");
  });

  it("refuses an entry it could never match, instead of ignoring it", async () => {
    for (const entry of [
      "*.example.com",
      "https://nas.lan",
      "nas lan",
      ".example.com.",
      ".example.com:8080",
    ]) {
      await expect(start({ allowedHosts: [entry] }), entry).rejects.toThrow();
    }
  });

  it("turns the check off with *", async () => {
    const off = await start({ allowedHosts: ["*"] });
    expect((await get(off.port, { host: "anything.example", origin: "http://x" })).status).toBe(
      200,
    );
  });

  it("checks a trusted proxy's forwarded host, and a browser reaching a trusted loopback directly", async () => {
    const proxied = await start({
      trustProxy: ["127.0.0.0/8", "::1"],
      allowedHosts: ["jhin.example.org"],
    });
    const status = async (headers: Record<string, string>) =>
      (await get(proxied.port, { "sec-fetch-site": "same-origin", ...headers })).status;
    expect(await status({ host: "127.0.0.1", "x-forwarded-host": "jhin.example.org" })).toBe(200);
    expect(await status({ host: "jhin.example.org", "x-forwarded-host": "jhin.example.org" })).toBe(
      200,
    );
    expect(await status({ host: "127.0.0.1", "x-forwarded-host": "other.example.org" })).toBe(403);
    // A rebinding page in the owner's browser comes from loopback too, with no forwarded host,
    expect(await status({ host: `evil.example:${proxied.port}` })).toBe(403);
    // or with one it set itself on a same-origin fetch: its own Host still names it.
    expect(
      await status({
        host: `evil.example:${proxied.port}`,
        "x-forwarded-host": "jhin.example.org",
      }),
    ).toBe(403);
  });

  it("compares names without port, brackets, case or a trailing dot", () => {
    expect(hostName("Example.COM.:8080")).toBe("example.com");
    expect(hostName("[::1]:7777")).toBe("::1");
    expect(hostName("::1")).toBe("::1");
    expect(hostName("2001:db8::1")).toBe("2001:db8::1");
    expect(hostName(" ")).toBeUndefined();
    const policy = hostPolicy({ configured: [], machineName: "Studio.home" });
    expect(policy.allows("studio")).toBe(true);
    expect(policy.allows("studio.home.local")).toBe(true);
    expect(policy.allows("studio.local")).toBe(true);
    expect(policy.allows("other.local")).toBe(false);
    expect(policy.allows("localhost.evil.example")).toBe(false);
    expect(policy.allows("evil.ts.net.example")).toBe(false);
    const remove = policy.add("twice.example");
    const again = policy.add("twice.example");
    remove();
    expect(policy.allows("twice.example")).toBe(true);
    again();
    expect(policy.allows("twice.example")).toBe(false);
    expect(fromBrowser({})).toBe(false);
    expect(fromBrowser({ "sec-fetch-mode": "cors" })).toBe(false);
    expect(fromBrowser({ "sec-fetch-site": "cross-site" })).toBe(true);
    expect(fromBrowser({ "user-agent": "Mozilla/5.0 (Macintosh)" })).toBe(true);
    expect(fromBrowser({ "user-agent": "claude-code/2.0" })).toBe(false);
    expect(fromBrowser({ "user-agent": "node" })).toBe(false);
  });

  it("answers only the owner's tailnet when jhin.http.tailnet names it (D1516)", async () => {
    const policy = hostPolicy({
      configured: ["shared.tailfeed.ts.net"],
      machineName: "studio",
      tailnet: ".Tail1A2B3C.ts.net",
    });
    expect(policy.allows("studio.tail1a2b3c.ts.net")).toBe(true);
    expect(policy.allows("STUDIO.tail1a2b3c.ts.net.:443")).toBe(true);
    // Another tailnet's name, and a name that only ends like the owner's, are refused,
    expect(policy.allows("studio.tail9z8y7x.ts.net")).toBe(false);
    expect(policy.allows("eviltail1a2b3c.ts.net")).toBe(false);
    // unless the owner lists it.
    expect(policy.allows("shared.tailfeed.ts.net")).toBe(true);
    // Unset, every tailnet's names are answered, as before.
    const open = hostPolicy({ configured: [], machineName: "studio" });
    expect(open.allows("studio.tail9z8y7x.ts.net")).toBe(true);

    const { port } = await start({ tailnet: "tail1a2b3c.ts.net" });
    const status = async (host: string) =>
      (await get(port, { host, origin: `https://${host}` })).status;
    expect(await status("studio.tail1a2b3c.ts.net")).toBe(200);
    expect(await status("studio.tail9z8y7x.ts.net")).toBe(403);
  });

  it("refuses a tailnet that is not a .ts.net name", async () => {
    for (const tailnet of ["example.com", "ts.net", "*.ts.net", "https://tail1a2b3c.ts.net"]) {
      await expect(start({ tailnet }), tailnet).rejects.toThrow();
    }
  });
});
