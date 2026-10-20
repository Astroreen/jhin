import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { RpcClient } from "@jhin/rpc";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  type TestKernel,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import http from "../../http/src/index.ts";
import mesh from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

let kernel: TestKernel | undefined;
let client: RpcClient | undefined;
afterEach(async () => {
  client?.close();
  await kernel?.stop();
  kernel = client = undefined;
});

/** One mesh node in this process, on a free port, with `jhin.http` set to `httpConfig`. */
async function node(httpConfig: Record<string, unknown>) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-mesh-join-"));
  const storage = memoryStoragePlugin();
  kernel = await createTestKernel({
    config: { node: { "jhin.http": { port: 0, ...httpConfig }, "jhin.mesh": { name: "b" } } },
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      mockCapability("host.identity", { nodeId: "node-b" }),
      storage,
      { manifest: manifest("http"), definition: http },
      { manifest: manifest("mesh"), definition: mesh },
    ],
  });
  client = connectInMemory(kernel, { log: storage.storage.log }).client;
  const { url } = await client.call<{ url: string }>("http.info");
  return url;
}

/**
 * Statuses of `attempts` wrong-code joins, each sent with the headers
 * `headersOf(attempt)` returns. 41 attempts cross the limit of 20 a minute
 * from one address even when they straddle a minute boundary.
 */
async function guesses(url: string, headersOf: (attempt: number) => Record<string, string>) {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 41; attempt += 1) {
    const response = await fetch(`${url}/mesh/join`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headersOf(attempt) },
      body: JSON.stringify({ code: "guess", record: {} }),
    });
    statuses.push(response.status);
  }
  return statuses;
}

describe("/mesh/join rate limit behind a reverse proxy", () => {
  it("keys on the socket address by default, so a forged header gets no fresh bucket", async () => {
    const url = await node({});
    const statuses = await guesses(url, (attempt) => ({
      "x-forwarded-for": `198.51.100.${attempt}`,
    }));
    expect(statuses).toContain(429);
  });

  it("gives each client of a trusted proxy its own bucket", async () => {
    const url = await node({ trustProxy: ["127.0.0.1", "::1"] });
    const distinct = await guesses(url, (attempt) => ({
      "x-forwarded-for": `198.51.100.${attempt}`,
    }));
    expect(distinct.every((status) => status === 400)).toBe(true);

    // One client behind the proxy is still limited, whatever it prepends itself.
    const same = await guesses(url, (attempt) => ({
      "x-forwarded-for": `10.9.9.${attempt}, 203.0.113.7`,
    }));
    expect(same).toContain(429);
  });
});

describe("config fan-out authority (security.md D416)", () => {
  it("needs host.config.write from its caller, since delivery runs with the node's own", async () => {
    await node({});
    const narrow = connectInMemory(kernel!, {
      caller: { id: "client:narrow", permissions: ["mesh.*"] },
    }).client;
    await expect(
      narrow.call("mesh.config.patch", {
        nodes: "all",
        layer: "node",
        section: "jhin.example",
        values: { greeting: "x" },
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { missing: ["host.config.write"] },
    });
    narrow.close();
  });
});
