import * as Fs from "node:fs";
import * as Http from "node:http";

import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { definePlugin } from "@jhin/sdk";
import { createTestKernel, testManifest, type TestKernel } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { clientAddress, trustList } from "../src/client-address.ts";
import http from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

describe("clientAddress", () => {
  const xff = (peer: string, header: string | undefined, trust: string[]) =>
    clientAddress(peer, header === undefined ? {} : { "x-forwarded-for": header }, {
      trust: trustList(trust),
      header: "x-forwarded-for",
    });

  it("is the socket's peer when no proxy is trusted, whatever the client sends", () => {
    expect(xff("203.0.113.9", "198.51.100.1", [])).toBe("203.0.113.9");
    expect(
      clientAddress(
        "203.0.113.9",
        { forwarded: "for=198.51.100.1" },
        {
          trust: trustList([]),
          header: "forwarded",
        },
      ),
    ).toBe("203.0.113.9");
  });

  it("ignores the header when the peer is not a trusted proxy (spoofing)", () => {
    expect(xff("203.0.113.9", "198.51.100.1", ["10.0.0.0/8"])).toBe("203.0.113.9");
  });

  it("takes the client from a trusted proxy, and only the hop the proxy appended", () => {
    expect(xff("10.0.0.2", "198.51.100.1", ["10.0.0.0/8"])).toBe("198.51.100.1");
    // A client prepending its own entry does not move its bucket: the proxy's entry is last.
    expect(xff("10.0.0.2", "1.2.3.4, 198.51.100.1", ["10.0.0.0/8"])).toBe("198.51.100.1");
    // Proxies behind proxies are skipped as long as they are trusted.
    expect(xff("10.0.0.2", "198.51.100.1, 10.0.0.3", ["10.0.0.0/8"])).toBe("198.51.100.1");
    // A trusted proxy that forwards nothing is the client itself.
    expect(xff("10.0.0.2", undefined, ["10.0.0.0/8"])).toBe("10.0.0.2");
  });

  it("matches IPv4-mapped peers, IPv6 ranges and ports", () => {
    expect(xff("::ffff:127.0.0.1", "198.51.100.1:5555", ["127.0.0.1"])).toBe("198.51.100.1");
    expect(xff("fd00::1", "2001:db8::7", ["fd00::/8"])).toBe("2001:db8::7");
  });

  it("gives one client one spelling, and an empty hop no address", () => {
    expect(xff("10.0.0.2", "2001:0DB8:0:0:0:0:0:1", ["10.0.0.0/8"])).toBe("2001:db8::1");
    expect(xff("10.0.0.2", "[2001:db8::1]:443", ["10.0.0.0/8"])).toBe("2001:db8::1");
    expect(xff("10.0.0.2", "0:0:0:0:0:ffff:c633:6401", ["10.0.0.0/8"])).toBe("198.51.100.1");
    expect(xff("0:0:0:0:0:0:0:1", "198.51.100.1", ["::1"])).toBe("198.51.100.1");
    expect(xff("10.0.0.2", "198.51.100.1, ", ["10.0.0.0/8"])).toBe("unknown");
    expect(xff("10.0.0.2", " ,", ["10.0.0.0/8"])).toBe("unknown");
  });

  it("reads RFC 7239 Forwarded only when configured", () => {
    const forwarded = (header: string) =>
      clientAddress(
        "10.0.0.2",
        { forwarded: header, "x-forwarded-for": "6.6.6.6" },
        {
          trust: trustList(["10.0.0.0/8"]),
          header: "forwarded",
        },
      );
    expect(forwarded("for=192.0.2.60;proto=http;by=203.0.113.43")).toBe("192.0.2.60");
    expect(forwarded('for="[2001:db8:cafe::17]:4711"')).toBe("2001:db8:cafe::17");
    expect(forwarded("for=6.6.6.6, for=192.0.2.60")).toBe("192.0.2.60");
    expect(forwarded("for=_hidden")).toBe("_hidden");
  });

  it("refuses entries that are not addresses or ranges", () => {
    expect(() => trustList(["localhost"])).toThrow(/not an IP address/);
    expect(() => trustList(["10.0.0.0/33"])).toThrow(/not an IP address/);
    expect(() => trustList(["10.0.0.0/x"])).toThrow(/not an IP address/);
  });
});

describe("http.server clientAddress", () => {
  let kernel: TestKernel | undefined;
  afterEach(async () => {
    await kernel?.stop();
    kernel = undefined;
  });

  /** A node whose `/who` answers with the client address the http plugin sees. */
  async function node(config: Record<string, unknown>) {
    let server: HttpServer | undefined;
    kernel = await createTestKernel({
      config: { node: { "jhin.http": { port: 0, ...config } } },
      plugins: [
        { manifest, definition: http },
        {
          manifest: testManifest("test.who", {
            side: "server",
            requires: { [HTTP_SERVER_CAPABILITY]: "^1.1" },
          }),
          definition: definePlugin({
            activate(context) {
              server = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
              context.subscriptions.add(
                server.route("GET", "/who", (request, response) => {
                  response.end(server!.clientAddress(request));
                }),
              );
            },
          }),
        },
      ],
    });
    return async (headers: Record<string, string>) =>
      (await fetch(`${server!.url}/who`, { headers })).text();
  }

  it("never trusts forwarded headers by default", async () => {
    const who = await node({});
    expect(await who({ "x-forwarded-for": "198.51.100.1" })).toBe("127.0.0.1");
  });

  it("reads the configured header behind a trusted proxy", async () => {
    const who = await node({ trustProxy: ["127.0.0.0/8"] });
    expect(await who({ "x-forwarded-for": "198.51.100.1" })).toBe("198.51.100.1");
    expect(await who({ forwarded: "for=198.51.100.2" })).toBe("127.0.0.1");
  });
});

describe("http.server requestedHost (security.md D418)", () => {
  let kernel: TestKernel | undefined;
  afterEach(async () => {
    await kernel?.stop();
    kernel = undefined;
  });

  /** A node whose `/host` answers with the host the http plugin says the client asked for. */
  async function node(config: Record<string, unknown>) {
    let server: HttpServer | undefined;
    kernel = await createTestKernel({
      config: { node: { "jhin.http": { port: 0, ...config } } },
      plugins: [
        { manifest, definition: http },
        {
          manifest: testManifest("test.host", {
            side: "server",
            requires: { [HTTP_SERVER_CAPABILITY]: "^1.2" },
          }),
          definition: definePlugin({
            activate(context) {
              server = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
              context.subscriptions.add(
                server.route("GET", "/host", (request, response) => {
                  response.end(server!.requestedHost(request) ?? "(none)");
                }),
              );
            },
          }),
        },
      ],
    });
    const { port } = new URL(server!.url);
    // `fetch` cannot set Host; a raw request can, as a proxy or a browser does.
    return (headers: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const request = Http.request(
          { host: "127.0.0.1", port, path: "/host", headers },
          (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => resolve(body));
          },
        );
        request.on("error", reject);
        request.end();
      });
  }

  it("is the Host header, lowercased, and ignores X-Forwarded-Host from an untrusted peer", async () => {
    const host = await node({});
    expect(await host({ host: "Node.Example:7777" })).toBe("node.example:7777");
    expect(await host({ host: "node.example", "x-forwarded-host": "evil.example" })).toBe(
      "node.example",
    );
  });

  it("is the first X-Forwarded-Host behind a trusted proxy", async () => {
    const host = await node({ trustProxy: ["127.0.0.0/8"] });
    expect(
      await host({ host: "10.0.0.5:7777", "x-forwarded-host": "Jhin.Example, inner.example" }),
    ).toBe("jhin.example");
    // An empty forwarded host falls back to Host.
    expect(await host({ host: "10.0.0.5:7777", "x-forwarded-host": "" })).toBe("10.0.0.5:7777");
  });
});
