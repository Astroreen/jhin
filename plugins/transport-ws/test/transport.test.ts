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
import { WebSocket } from "ws";

import auth from "../../auth-token/src/index.ts";
import http from "../../http/src/index.ts";
import transport, { TransportConfig, originAllowed } from "../src/index.ts";

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

async function startNode(
  options: { tokenFile?: string; allowedOrigins?: string[]; trustProxy?: string[] } = {},
): Promise<Node> {
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
    config: {
      node: {
        "jhin.http": {
          port: 0,
          ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
        },
        ...(options.allowedOrigins === undefined
          ? {}
          : { "jhin.transport-ws": { allowedOrigins: options.allowedOrigins } }),
      },
    },
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

  it("revokes only tokens the caller could have issued, and bounds how long one lives", async () => {
    const node = await startNode();
    const owner = await issue(node, ["*"]);
    const narrow = await issue(node, ["app.read"]);
    const admin = connect(node.url, (await issue(node, ["auth.*", "app.read"])).token);

    await expect(admin.call("auth.clients.revoke", { id: owner.id })).rejects.toMatchObject({
      code: "PERMISSION_NOT_HELD",
      details: { missing: ["*"] },
    });
    expect(await admin.call("auth.clients.revoke-others")).toEqual({ revoked: [narrow.id] });

    await expect(
      node.kernel.commands.execute("auth.tokens.issue", {
        label: "forever-ish",
        permissions: ["app.read"],
        ttlDays: 1e300,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });

  it("lists clients without secrets, marks the caller's own and keeps it from revoking itself", async () => {
    const node = await startNode();
    const admin = await issue(node, ["auth.*", "app.read"]);
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
      "auth.pairing.create",
      "auth.pairing.revoke",
      "auth.tokens.issue",
    ]);
  });
});

describe("a revoke while a token is checked (security.md D414)", () => {
  it("drops a connection whose principal was revoked before its check ended", async () => {
    let called!: () => void;
    const checking = new Promise<void>((resolve) => (called = resolve));
    let answer!: (principal: { id: string; permissions: string[] }) => void;
    const verified = new Promise<{ id: string; permissions: string[] }>(
      (resolve) => (answer = resolve),
    );
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("auth.verifier", {
          verify: () => {
            called();
            return verified;
          },
        }),
        { manifest: manifest("http"), definition: http },
        { manifest: manifest("transport-ws"), definition: transport },
        echo,
      ],
      config: { node: { "jhin.http": { port: 0 } } },
    });
    kernels.push(kernel);
    const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
    const device = connect(`${url.replace(/^http/, "ws")}/rpc`, "a-token-being-checked");

    await checking;
    kernel.events.emit("auth.client.revoked", { principal: "client:a" });
    answer({ id: "client:a", permissions: ["*"] });
    await closed(device);
    expect(device.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("Origin allowlist (security.md D418)", () => {
  /** Opens a socket as a browser page on `origin` would; resolves with the HTTP status or "open". */
  const openFrom = (node: Node, origin: string | undefined, headers: Record<string, string> = {}) =>
    new Promise<number | "open">((resolve, reject) => {
      const socket = new WebSocket(node.url, ["jhin.v1", `jhin.token.${node.token}`], {
        ...(origin === undefined ? {} : { origin }),
        headers,
      });
      socket.once("open", () => {
        socket.close();
        resolve("open");
      });
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", reject);
    });

  it("lets any page connect with a token while no origin is listed", async () => {
    const node = await startNode();
    expect(await openFrom(node, "https://elsewhere.example")).toBe("open");
    expect(await openFrom(node, undefined)).toBe("open");
  });

  it("refuses other pages with 403 once origins are listed, keeping the node's own and listed ones", async () => {
    const node = await startNode({ allowedOrigins: ["https://client.example"] });
    const own = new URL(node.url.replace(/^ws/, "http")).origin;

    expect(await openFrom(node, "https://elsewhere.example")).toBe(403);
    expect(await openFrom(node, "null")).toBe(403);
    expect(await openFrom(node, own)).toBe("open");
    expect(await openFrom(node, "https://client.example")).toBe("open");
    // The CLI and other nodes send no Origin.
    expect(await openFrom(node, undefined)).toBe("open");
  });

  it("knows the node's own page behind a trusted proxy by X-Forwarded-Host", async () => {
    const node = await startNode({
      allowedOrigins: ["https://client.example"],
      trustProxy: ["127.0.0.0/8", "::1"],
    });
    const behindProxy = (origin: string, forwardedHost = "jhin.example") =>
      openFrom(node, origin, { "x-forwarded-host": forwardedHost });
    expect(await behindProxy("https://jhin.example")).toBe("open");
    expect(await behindProxy("https://elsewhere.example")).toBe(403);
    // A forwarded host that parses as another host is no host at all.
    expect(await behindProxy("https://evil.example", "jhin.example@evil.example")).toBe(403);
    expect(await behindProxy("https://evil.example", "evil.example/x")).toBe(403);
  });

  it("keeps allowed origins as canonical origins and refuses anything else", () => {
    expect(
      TransportConfig.parse({
        allowedOrigins: ["https://Jhin.example.com/", "http://a.example:8080"],
      }),
    ).toEqual({ allowedOrigins: ["https://jhin.example.com", "http://a.example:8080"] });
    expect(TransportConfig.parse(undefined)).toEqual({ allowedOrigins: [] });
    for (const entry of [
      "https://jhin.example.com/path",
      "https://jhin.example.com/?q=1",
      "https://jhin.example.com/#x",
      "ftp://jhin.example.com",
      "not a url",
    ]) {
      expect(TransportConfig.safeParse({ allowedOrigins: [entry] }).success).toBe(false);
    }
  });

  it("compares listed origins by scheme, host and port, and the node's own by host and port", () => {
    const listed = ["https://client.example"];
    expect(originAllowed("https://client.example", "node:7777", listed)).toBe(true);
    expect(originAllowed("http://client.example", "node:7777", listed)).toBe(false);
    expect(originAllowed("https://client.example:8443", "node:7777", listed)).toBe(false);
    expect(originAllowed("http://node:7777", "node:7777", listed)).toBe(true);
    // The node's own page behind a TLS proxy: https, though the node speaks http.
    expect(originAllowed("https://node:7777", "node:7777", listed)).toBe(true);
    // A default port written out or left off is the same host; another port is not.
    expect(originAllowed("https://node.example", "node.example:443", listed)).toBe(true);
    expect(originAllowed("https://node.example", "node.example", listed)).toBe(true);
    expect(originAllowed("http://node.example", "node.example:443", listed)).toBe(false);
    // IPv6 hosts compare as hosts too.
    expect(originAllowed("http://[::1]:7777", "[::1]:7777", listed)).toBe(true);
    expect(originAllowed("http://[::1]:7777", "[::1]:7778", listed)).toBe(false);
    for (const hostile of [
      "node.example@evil.example",
      "evil.example/x",
      "evil.example?x",
      "a b",
    ]) {
      expect(originAllowed("https://evil.example", hostile, listed)).toBe(false);
    }
    expect(originAllowed("not an origin", "node:7777", [])).toBe(false);
    // `null` (a sandboxed frame, a file: page) is refused even while nothing is listed.
    expect(originAllowed("null", "node:7777", [])).toBe(false);
  });
});

describe("pairing (security.md D419–D422)", () => {
  const httpUrl = (node: Node) => node.url.replace(/^ws/, "http").replace(/\/rpc$/, "");
  const createCode = (node: Node, input: Record<string, unknown> = {}) =>
    node.kernel.commands.execute("auth.pairing.create", input) as Promise<{
      id: string;
      code: string;
      url: string;
      expiresAt: number;
    }>;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("exchanges a one-time code for a scoped device token over HTTP", async () => {
    const node = await startNode();
    const { code, url } = await createCode(node, {
      label: "Living room iPad",
      permissions: ["app.*"],
    });
    expect(url).toBe(`${httpUrl(node)}/pair#token=${code}`);

    const paired = await post(
      `${httpUrl(node)}/auth/pair`,
      { code, label: "ignored" },
      {
        origin: "https://client.example",
      },
    );
    expect(paired.status).toBe(200);
    expect(paired.headers.get("cache-control")).toBe("no-store");
    expect(paired.headers.get("access-control-allow-origin")).toBe("*");
    const issued = (await paired.json()) as { id: string; token: string; permissions: string[] };
    expect(issued.permissions).toEqual(["app.*"]);

    const device = connect(node.url, issued.token);
    expect(await device.call("app.write", { text: "paired" })).toEqual({ text: "paired" });
    const { clients: listed } = (await node.kernel.commands.execute("auth.clients.list", {})) as {
      clients: { id: string; label: string; method: string }[];
    };
    // The code's label wins over the device's, as in T3.
    expect(listed).toContainEqual(
      expect.objectContaining({ id: issued.id, label: "Living room iPad", method: "pairing" }),
    );

    const again = await post(`${httpUrl(node)}/auth/pair`, { code });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "PAIRING_CODE_INVALID" });
  });

  it("gives a pairing code no more than its creator holds", async () => {
    const node = await startNode();
    await expect(
      node.kernel.commands.execute(
        "auth.pairing.create",
        { permissions: ["*"] },
        { caller: { id: "someone", permissions: ["auth.write", "app.read"] } },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_NOT_HELD" });
    // Without permissions named: the creator's own grants.
    const { code } = (await node.kernel.commands.execute(
      "auth.pairing.create",
      {},
      { caller: { id: "someone", permissions: ["auth.write", "app.read"] } },
    )) as { code: string };
    const issued = (await (await post(`${httpUrl(node)}/auth/pair`, { code })).json()) as {
      permissions: string[];
    };
    expect(issued.permissions).toEqual(["auth.write", "app.read"]);
  });

  it("opens the page's own session as an httpOnly cookie the page never reads", async () => {
    const node = await startNode({ allowedOrigins: [] });
    const own = httpUrl(node);
    const { code } = await createCode(node);

    const foreign = await post(
      `${own}/auth/session`,
      { credential: code },
      {
        origin: "https://evil.example",
      },
    );
    expect(foreign.status).toBe(403);

    const opened = await post(`${own}/auth/session`, { credential: code }, { origin: own });
    expect(opened.status).toBe(200);
    const body = (await opened.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ authenticated: true });
    expect(body).not.toHaveProperty("token");
    const setCookie = opened.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^jhin_session_\d+=jhd1\./);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";")[0]!;

    expect(
      await (await fetch(`${own}/auth/session`, { headers: { cookie } })).json(),
    ).toMatchObject({ authenticated: true, permissions: ["*"] });

    // The cookie authenticates a socket from the node's own page, never from another one,
    // even while no origin is listed.
    const open = (origin: string) =>
      new Promise<number | "open">((resolve, reject) => {
        const socket = new WebSocket(node.url, ["jhin.v1"], { origin, headers: { cookie } });
        socket.once("message", () => {
          socket.close();
          resolve("open");
        });
        socket.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        socket.once("close", (status) => resolve(status));
        socket.once("error", reject);
      });
    expect(await open(own)).toBe("open");
    expect(await open("https://elsewhere.example")).toBe(403);

    // Signing out revokes the token behind the cookie.
    const signedOut = await fetch(`${own}/auth/session`, {
      method: "DELETE",
      headers: { cookie, origin: own },
    });
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(`${own}/auth/session`, { headers: { cookie } })).status).toBe(401);
  });

  it("never lets a session outlive the token it was opened with", async () => {
    const node = await startNode();
    const short = (await node.kernel.commands.execute("auth.tokens.issue", {
      label: "short",
      permissions: ["app.*"],
      ttlDays: 1,
    })) as { token: string; expiresAt: number };
    const opened = (await (
      await post(`${httpUrl(node)}/auth/session`, { credential: short.token })
    ).json()) as { expiresAt: number; id: string };
    expect(opened.expiresAt).toBeLessThanOrEqual(short.expiresAt);
    const { clients } = (await node.kernel.commands.execute("auth.clients.list", {})) as {
      clients: { id: string; method: string }[];
    };
    expect(clients.find((client) => client.id === opened.id)?.method).toBe("issued");
  });

  it("turns the owner's token from #token= into a session too", async () => {
    const node = await startNode();
    const opened = await post(`${httpUrl(node)}/auth/session`, { credential: node.token });
    expect(await opened.json()).toMatchObject({ authenticated: true, permissions: ["*"] });
    const refused = await post(`${httpUrl(node)}/auth/session`, { credential: "nope" });
    expect(refused.status).toBe(401);
  });
});
