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
      context.commands.register({
        name: "app.write",
        description: "Echoes, for a caller allowed to write",
        input: z.object({ text: z.string() }),
        output: z.object({ text: z.string() }),
        permissions: ["app.write"],
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

describe("device tokens (security.md D411–D414)", () => {
  const issue = (node: Node, permissions: string[], caller?: string[]) =>
    node.kernel.commands.execute(
      "auth.tokens.issue",
      { label: "test", permissions },
      caller === undefined ? {} : { caller: { id: "someone", permissions: caller } },
    ) as Promise<{ id: string; token: string; expiresAt?: number }>;

  it("runs only the commands a token's grants cover", async () => {
    const node = await startNode();
    const issued = await issue(node, ["app.read"]);
    expect(issued.token).toMatch(/^jhd1\./);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());

    const device = connect(node.url, issued.token);
    // No permission named: anyone connected may run it.
    expect(await device.call("app.echo", { text: "hi" })).toEqual({ text: "hi" });
    await expect(device.call("app.write", { text: "no" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { missing: ["app.write"] },
    });
    await expect(device.call("auth.clients.list")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    const patterned = connect(node.url, (await issue(node, ["app.*"])).token);
    expect(await patterned.call("app.write", { text: "yes" })).toEqual({ text: "yes" });
  });

  it("never grants more than the caller holds", async () => {
    const node = await startNode();
    await expect(
      issue(node, ["app.write", "git.read"], ["auth.write", "app.*"]),
    ).rejects.toMatchObject({ code: "PERMISSION_NOT_HELD", details: { missing: ["git.read"] } });
    await expect(issue(node, ["*"], ["auth.write", "app.*"])).rejects.toMatchObject({
      code: "PERMISSION_NOT_HELD",
    });
    await expect(issue(node, ["app.write"], ["auth.write", "app.*"])).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("lists clients without secrets, marks the caller's own and keeps it from revoking itself", async () => {
    const node = await startNode();
    const admin = await issue(node, ["auth.*"]);
    const other = await issue(node, ["app.read"]);
    const device = connect(node.url, admin.token);

    const { clients: listed } = await device.call<{ clients: Record<string, unknown>[] }>(
      "auth.clients.list",
    );
    expect(listed.map((client) => [client["id"], client["current"]])).toEqual([
      [admin.id, true],
      [other.id, false],
    ]);
    for (const client of listed) expect(client).not.toHaveProperty("secretHash");
    expect(JSON.stringify(listed)).not.toContain(admin.token.split(".")[2]);

    await expect(device.call("auth.clients.revoke", { id: admin.id })).rejects.toMatchObject({
      code: "CURRENT_CLIENT_REVOKE_NOT_ALLOWED",
    });
    expect(await device.call("auth.clients.revoke-others")).toEqual({ revoked: [other.id] });
  });

  it("drops a revoked token's open connections and refuses it afterwards", async () => {
    const node = await startNode();
    const issued = await issue(node, ["app.*"]);
    const device = connect(node.url, issued.token);
    const owner = connect(node.url, node.token);
    expect(await device.call("app.write", { text: "before" })).toEqual({ text: "before" });

    const gone = closed(device);
    expect(await owner.call("auth.clients.revoke", { id: issued.id })).toEqual({
      revoked: [issued.id],
    });
    await gone;
    expect(device.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
    // The owner's connection stays.
    expect(await owner.call("app.echo", { text: "still" })).toEqual({ text: "still" });

    const again = connect(node.url, issued.token);
    await closed(again);
    expect(again.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("drops a connection when its token expires", async () => {
    const node = await startNode();
    // Expires within a millisecond: refused at connect, or dropped right after it.
    const { token } = (await node.kernel.commands.execute("auth.tokens.issue", {
      label: "brief",
      permissions: ["app.*"],
      ttlDays: 1e-9,
    })) as { token: string };
    const device = connect(node.url, token);
    await closed(device);
    expect(device.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("keeps device tokens open when the owner token rotates", async () => {
    const node = await startNode();
    const device = connect(node.url, (await issue(node, ["app.*"])).token);
    const owner = connect(node.url, node.token);
    await owner.call("app.echo", { text: "x" });
    expect(await device.call("app.write", { text: "x" })).toEqual({ text: "x" });

    const gone = closed(owner);
    await node.kernel.commands.execute("auth.token.rotate", {});
    await gone;
    expect(await device.call("app.write", { text: "after" })).toEqual({ text: "after" });
  });

  it("lists the permissions the node's commands need", async () => {
    const node = await startNode();
    const { permissions } = (await node.kernel.commands.execute("auth.permissions.list", {})) as {
      permissions: { permission: string; commands: string[] }[];
    };
    expect(permissions).toContainEqual({ permission: "app.write", commands: ["app.write"] });
    expect(permissions).toContainEqual({ permission: "events.read", commands: [] });
    expect(permissions.find((entry) => entry.permission === "auth.write")?.commands).toEqual([
      "auth.clients.revoke",
      "auth.clients.revoke-others",
      "auth.tokens.issue",
    ]);
  });
});
