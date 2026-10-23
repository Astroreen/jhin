import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Os from "node:os";
import * as Path from "node:path";

import {
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
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
});

/** The status of a browser's GET of `/.well-known/jhin` asking for `host`. */
function status(port: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = Http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/.well-known/jhin",
        setHost: false,
        agent: false,
        headers: { host, "sec-fetch-site": "same-origin" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("the mesh's advertised names (security.md D1362)", () => {
  it("lets browsers reach the node by the hosts it advertises", async () => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-mesh-hosts-"));
    kernel = await createTestKernel({
      config: {
        node: {
          "jhin.http": { port: 0 },
          "jhin.mesh": { name: "b", advertise: ["wss://mesh.example.org/mesh"] },
        },
      },
      plugins: [
        mockCapability("host.paths", {
          home: data,
          dataDir: (id: string) => {
            Fs.mkdirSync(Path.join(data, id), { recursive: true });
            return Path.join(data, id);
          },
        }),
        mockCapability("host.identity", { nodeId: "node-b" }),
        memoryStoragePlugin(),
        { manifest: manifest("http"), definition: http },
        { manifest: manifest("mesh"), definition: mesh },
      ],
    });
    const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
    const port = new URL(url).port;
    expect(await status(port, "mesh.example.org")).toBe(200);
    expect(await status(port, "other.example.org")).toBe(403);
  });
});
