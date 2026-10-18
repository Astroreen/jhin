import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import { definePlugin, z, type PluginDefinition } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  testManifest,
  type TestKernel,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import auth from "../../auth-token/src/index.ts";
import http from "../../http/src/index.ts";
import transport from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const echo = {
  manifest: testManifest("app.echo"),
  definition: definePlugin({
    activate(context) {
      context.commands.register({
        name: "app.echo",
        description: "Echoes",
        input: z.object({ text: z.string() }),
        output: z.object({ text: z.string() }),
        handler: (input) => input,
      });
    },
  }),
};

interface Node {
  readonly kernel: TestKernel;
  readonly url: string;
  readonly token: string;
  readonly storage: ReturnType<typeof memoryStoragePlugin>["storage"];
}

const kernels: TestKernel[] = [];
const clients: RpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

async function startNode(options: { tokenFile?: string } = {}): Promise<Node> {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-transport-"));
  if (options.tokenFile !== undefined) {
    Fs.mkdirSync(Path.join(data, "jhin.auth-token"), { recursive: true });
    Fs.writeFileSync(Path.join(data, "jhin.auth-token", "token"), options.tokenFile);
  }
  const storage = memoryStoragePlugin();
  const real = (dir: string, definition: PluginDefinition) => ({
    manifest: manifest(dir),
    definition,
  });
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      storage,
      real("http", http),
      real("auth-token", auth),
      real("transport-ws", transport),
      echo,
    ],
    config: { node: { "jhin.http": { port: 0 } } },
  });
  kernels.push(kernel);
  const failed = kernel.inspect().plugins.filter((plugin) => plugin.status !== "active");
  expect(failed).toEqual([]);
  const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
  const { token } = (await kernel.commands.execute("auth.token.show", {})) as { token: string };
  return { kernel, url: `${url.replace(/^http/, "ws")}/rpc`, token, storage: storage.storage };
}

function connect(url: string, token: string | undefined): RpcClient {
  const created = createRpcClient({
    connect: () => connectWebSocket(url, token),
    retryDelay: () => 0,
  });
  clients.push(created);
  return created;
}

const closed = (target: RpcClient) =>
  new Promise<void>((resolve) => {
    if (target.state === "closed") resolve();
    target.onState((state) => state === "closed" && resolve());
  });
const reopened = (target: RpcClient) =>
  new Promise<void>((resolve) => {
    let dropped = false;
    target.onState((state) => {
      if (state !== "open") dropped = true;
      else if (dropped) resolve();
    });
  });

describe("jhin.transport-ws", () => {
  it("refuses a client without a token or with a wrong one", async () => {
    const node = await startNode();

    for (const token of [undefined, "wrong-token"]) {
      const refused = connect(node.url, token);
      await closed(refused);
      expect(refused.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("runs any command as an RPC method for a client with the token", async () => {
    const node = await startNode();
    const owner = connect(node.url, node.token);

    expect(await owner.call("app.echo", { text: "hi" })).toEqual({ text: "hi" });
    expect(await owner.call("rpc.hello")).toEqual({ protocol: "jhin.v1" });
    await expect(owner.call("app.echo", { text: 1 })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
  });

  it("resumes a subscription after the transport restarts, without gaps or duplicates", async () => {
    const node = await startNode();
    const owner = connect(node.url, node.token);
    const events: StoredEvent[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    owner.subscribe("thread/1", {}, (event) => {
      events.push(event);
      for (const waiter of waiters.filter((item) => item.count <= events.length)) waiter.resolve();
    });
    const reach = (count: number) =>
      new Promise<void>((resolve) =>
        events.length >= count ? resolve() : waiters.push({ count, resolve }),
      );
    const append = (from: number, to: number) =>
      node.storage.log.append(
        "thread/1",
        Array.from({ length: to - from + 1 }, (_, index) => ({
          type: "app.n",
          payload: from + index,
        })),
      );

    await append(1, 3);
    await reach(3);
    const back = reopened(owner);
    await node.kernel.reload("jhin.transport-ws"); // closes every socket with 1012
    await append(4, 6);
    await back;
    await append(7, 8);
    await reach(8);

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("never accepts an empty token, even from an empty token file", async () => {
    const node = await startNode({ tokenFile: "\n" });

    expect(node.token).toHaveLength(43);
    const refused = connect(node.url, "");
    await closed(refused);
    expect(refused.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("drops open connections when the token is rotated", async () => {
    const node = await startNode();
    const owner = connect(node.url, node.token);
    expect(await owner.call("app.echo", { text: "before" })).toEqual({ text: "before" });

    const gone = closed(owner);
    await node.kernel.commands.execute("auth.token.rotate", {});
    await gone;

    expect(owner.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
