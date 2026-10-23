import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import {
  PERMISSIONS_DESCRIBE_HOOK,
  definePlugin,
  describePermissions,
  z,
  type PermissionEntry,
  type PluginDefinition,
} from "@jhin/sdk";
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
      describePermissions(context, { "app.write": { title: "Write echoes" } });
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
  options: {
    tokenFile?: string;
    allowedOrigins?: string[];
    trustProxy?: string[];
    allowedHosts?: string[];
    plugins?: { manifest: unknown; definition: PluginDefinition }[];
  } = {},
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
      ...(options.plugins ?? []),
    ],
    config: {
      node: {
        "jhin.http": {
          port: 0,
          ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
          ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
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
      permissions: PermissionEntry[];
    };
    expect(permissions).toContainEqual({
      permission: "app.write",
      commands: ["app.write"],
      title: "Write echoes",
    });
    expect(permissions).toContainEqual({
      permission: "events.read",
      commands: [],
      title: "Read event streams",
      description: "Subscribe to event streams no other permission guards.",
    });
    // T3's wording for a permission that matches its scope (security.md D961).
    expect(permissions.find((entry) => entry.permission === "auth.write")).toMatchObject({
      title: "Manage access",
      description: "Issue and revoke credentials for other clients.",
    });
    expect(permissions.find((entry) => entry.permission === "auth.write")?.commands).toEqual([
      "auth.clients.revoke",
      "auth.clients.revoke-others",
      "auth.pairing.create",
      "auth.pairing.revoke",
      "auth.tokens.issue",
    ]);
  });

  it("marks a permission with shell access, and nothing else (security.md D1364)", async () => {
    const shell = {
      manifest: testManifest("app.shell"),
      definition: definePlugin({
        activate(context) {
          for (const name of ["app.shell", "app.maybe"]) {
            context.commands.register({
              name,
              description: "A test command",
              input: z.object({}),
              output: z.object({}),
              permissions: [name],
              handler: () => ({}),
            });
          }
          describePermissions(context, {
            "app.shell": { title: "Run things", shellAccess: true },
          });
          // Only `true` counts: anything else a hook answers is dropped.
          context.hooks.after<unknown, PermissionEntry[]>(PERMISSIONS_DESCRIBE_HOOK, (entries) =>
            entries.map((entry) =>
              entry.permission === "app.maybe"
                ? ({ ...entry, title: "Maybe", shellAccess: "yes" } as unknown as PermissionEntry)
                : entry,
            ),
          );
        },
      }),
    };
    const node = await startNode({ plugins: [shell] });
    const { permissions } = (await node.kernel.commands.execute("auth.permissions.list", {})) as {
      permissions: PermissionEntry[];
    };
    expect(permissions).toContainEqual({
      permission: "app.shell",
      commands: ["app.shell"],
      title: "Run things",
      shellAccess: true,
    });
    expect(permissions).toContainEqual({
      permission: "app.maybe",
      commands: ["app.maybe"],
      title: "Maybe",
    });
  });

  it("lists the permissions without titles when a description hook throws (D961)", async () => {
    const broken = {
      manifest: testManifest("app.broken"),
      definition: definePlugin({
        activate(context) {
          context.hooks.after(PERMISSIONS_DESCRIBE_HOOK, () => {
            throw new Error("broken");
          });
        },
      }),
    };
    const node = await startNode({ plugins: [broken] });
    const { permissions } = (await node.kernel.commands.execute("auth.permissions.list", {})) as {
      permissions: PermissionEntry[];
    };
    expect(permissions).toContainEqual({ permission: "app.write", commands: ["app.write"] });
  });

  it("keeps the list when a description hook answers something else (D961)", async () => {
    const careless = {
      manifest: testManifest("app.careless"),
      definition: definePlugin({
        activate(context) {
          // An `after` hook written without a return.
          context.hooks.after(PERMISSIONS_DESCRIBE_HOOK, () => undefined);
        },
      }),
    };
    const node = await startNode({ plugins: [careless] });
    const { permissions } = (await node.kernel.commands.execute("auth.permissions.list", {})) as {
      permissions: PermissionEntry[];
    };
    expect(permissions).toContainEqual({ permission: "app.write", commands: ["app.write"] });
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
      // The proxy's public name (security.md D1362).
      allowedHosts: ["jhin.example"],
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

  it("marks the cookie Secure only when the request came over HTTPS as http.server says (D1363)", async () => {
    const node = await startNode();
    const own = httpUrl(node);
    const open = async (headers: Record<string, string>) => {
      const { code } = await createCode(node);
      const opened = await post(`${own}/auth/session`, { credential: code }, headers);
      expect(opened.status).toBe(200);
      return opened.headers.get("set-cookie")!;
    };
    expect(await open({})).not.toContain("Secure");
    // Loopback forwards the protocol (Tailscale Serve, a local proxy); the HTTP plugin's
    // test shows the header ignored from any other untrusted peer.
    expect(await open({ "x-forwarded-proto": "https" })).toContain("Secure");
  });

  it("answers the preflight, refuses a malformed body and limits attempts per route", async () => {
    const node = await startNode();
    const preflight = await fetch(`${httpUrl(node)}/auth/pair`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect((await post(`${httpUrl(node)}/auth/pair`, { nope: 1 })).status).toBe(400);
    const huge = await post(`${httpUrl(node)}/auth/pair`, { code: "x".repeat(20_000) });
    expect(huge.status).toBe(413);

    // A foreign page refused at /auth/session spends no attempts.
    for (let attempt = 0; attempt < 25; attempt++) {
      const refused = await post(
        `${httpUrl(node)}/auth/session`,
        { credential: "x" },
        {
          origin: "https://evil.example",
        },
      );
      expect(refused.status).toBe(403);
    }
    // Only failures count, per route. The limit is per clock minute, so these
    // tests rely on a margin: 41 wrong codes cross 20 a minute even when they
    // straddle a minute boundary (as /mesh/join's test does).
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 41; attempt++) {
      statuses.push((await post(`${httpUrl(node)}/auth/pair`, { code: "WRONGCODE234" })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    // The session bucket is untouched.
    expect((await post(`${httpUrl(node)}/auth/session`, { credential: "x" })).status).toBe(401);
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
    const listed = (await node.kernel.commands.execute("auth.clients.list", {})) as {
      clients: { id: string; method: string }[];
    };
    expect(listed.clients.find((client) => client.id === opened.id)?.method).toBe("issued");
  });

  it("counts parallel attempts as they come in, not once each has failed", async () => {
    const node = await startNode();
    const parallel = await Promise.all(
      Array.from({ length: 50 }, () =>
        post(`${httpUrl(node)}/auth/pair`, { code: "WRONGCODE234" }).then((r) => r.status),
      ),
    );
    // Counted only once failed, all 50 would pass and fail with 401. Counted on
    // arrival, at most 20 a minute pass: even split by a minute boundary, 10 get 429.
    expect(parallel.filter((status) => status === 429).length).toBeGreaterThanOrEqual(10);
  });

  it("ends the open codes of a token when it is revoked", async () => {
    const node = await startNode();
    const admin = (await node.kernel.commands.execute("auth.tokens.issue", {
      label: "admin",
      permissions: ["auth.*", "app.*"],
    })) as { id: string; token: string };
    const device = connect(node.url, admin.token);
    const { code } = await device.call<{ code: string }>("auth.pairing.create", {});
    device.close();
    await node.kernel.commands.execute("auth.clients.revoke", { id: admin.id });
    expect((await post(`${httpUrl(node)}/auth/pair`, { code })).status).toBe(401);
  });

  it("limits failed sign-ins on its own route, through a reload of the token plugin", async () => {
    const node = await startNode();
    const attempt = () => post(`${httpUrl(node)}/auth/session`, { credential: "wrong" });
    const responses: Response[] = [];
    for (let index = 0; index < 15; index++) responses.push(await attempt());
    // Counted failures stay counted when the plugin reloads.
    await node.kernel.reload("jhin.auth-token");
    for (let index = 0; index < 26; index++) responses.push(await attempt());
    // 41 failures cross 20 a minute even split by a minute boundary.
    const limited = responses.find((response) => response.status === 429);
    expect(limited).toBeDefined();
    expect(limited!.headers.get("access-control-allow-origin")).toBeNull();
    expect(await limited!.json()).toMatchObject({ code: "TOO_MANY_SESSION_ATTEMPTS" });
  });

  it("keeps open codes through a reload of the token plugin", async () => {
    const node = await startNode();
    const { code } = await createCode(node);
    await node.kernel.reload("jhin.auth-token");
    expect((await post(`${httpUrl(node)}/auth/pair`, { code })).status).toBe(200);
  });

  it("refuses to sign a page out from another origin", async () => {
    const node = await startNode();
    const refused = await fetch(`${httpUrl(node)}/auth/session`, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(refused.status).toBe(403);
  });

  it("refuses a base URL with credentials, a query or a fragment", async () => {
    const node = await startNode();
    for (const baseUrl of [
      "https://user:pw@jhin.example",
      "https://jhin.example/?x=1",
      "https://jhin.example/#x",
      "ftp://jhin.example",
    ]) {
      await expect(createCode(node, { baseUrl })).rejects.toMatchObject({
        code: "COMMAND_INPUT_INVALID",
      });
    }
    expect((await createCode(node, { baseUrl: "https://jhin.example/node/" })).url).toMatch(
      /^https:\/\/jhin\.example\/node\/pair#token=/,
    );
  });

  it("ends a page session with the token that opened it", async () => {
    const node = await startNode();
    const source = (await node.kernel.commands.execute("auth.tokens.issue", {
      label: "source",
      permissions: ["app.*"],
    })) as { id: string; token: string };
    const fromSource = (await (
      await post(`${httpUrl(node)}/auth/session`, { credential: source.token })
    ).json()) as { id: string };
    const fromOwner = (await (
      await post(`${httpUrl(node)}/auth/session`, { credential: node.token })
    ).json()) as { id: string };
    const ids = async () =>
      (
        (await node.kernel.commands.execute("auth.clients.list", {})) as {
          clients: { id: string }[];
        }
      ).clients.map((client) => client.id);

    await node.kernel.commands.execute("auth.clients.revoke", { id: source.id });
    expect(await ids()).not.toContain(fromSource.id);
    expect(await ids()).toContain(fromOwner.id);
    await node.kernel.commands.execute("auth.token.rotate", {});
    expect(await ids()).not.toContain(fromOwner.id);
  });

  it("turns the owner's token from #token= into a session too", async () => {
    const node = await startNode();
    const opened = await post(`${httpUrl(node)}/auth/session`, { credential: node.token });
    expect(await opened.json()).toMatchObject({ authenticated: true, permissions: ["*"] });
    const refused = await post(`${httpUrl(node)}/auth/session`, { credential: "nope" });
    expect(refused.status).toBe(401);
  });
});

describe("clients and links (security.md D1187, D1188, D1190)", () => {
  const httpUrl = (node: Node) => node.url.replace(/^ws/, "http").replace(/\/rpc$/, "");
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

  it("records what a paired device says about itself, and lists it", async () => {
    const node = await startNode();
    const phone = (await node.kernel.commands.execute("auth.pairing.create", {
      label: "Phone",
    })) as { code: string };
    const paired = (await (
      await post(`${httpUrl(node)}/auth/pair`, { code: phone.code }, { "user-agent": IPHONE })
    ).json()) as { id: string };
    const tablet = (await node.kernel.commands.execute("auth.pairing.create", {})) as {
      code: string;
    };
    const presented = (await (
      await post(
        `${httpUrl(node)}/auth/pair`,
        { code: tablet.code, deviceType: "tablet", os: "Android" },
        { "user-agent": "curl/8.0" },
      )
    ).json()) as { id: string };
    const session = (await (
      await post(
        `${httpUrl(node)}/auth/session`,
        { credential: node.token },
        {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
      )
    ).json()) as { id: string };
    const issued = (await node.kernel.commands.execute("auth.tokens.issue", {
      label: "ci",
      permissions: ["app.*"],
    })) as { id: string };

    const { clients: listed } = (await node.kernel.commands.execute("auth.clients.list", {})) as {
      clients: { id: string; metadata?: Record<string, unknown> }[];
    };
    const byId = new Map(listed.map((client) => [client.id, client.metadata]));
    expect(byId.get(paired.id)).toEqual({
      deviceType: "mobile",
      os: "iOS",
      browser: "Safari",
      userAgent: IPHONE,
      ipAddress: "127.0.0.1",
    });
    // What the device presents wins over what its User-Agent suggests (T3).
    expect(byId.get(presented.id)).toMatchObject({ deviceType: "tablet", os: "Android" });
    expect(byId.get(session.id)).toMatchObject({
      deviceType: "desktop",
      os: "Linux",
      browser: "Chrome",
    });
    // An issued token carries none.
    expect(byId.get(issued.id)).toBeUndefined();
  });

  it("tells subscribers holding auth.read that the clients changed, and nobody else", async () => {
    const node = await startNode();
    const owner = connect(node.url, node.token);
    const changes: StoredEvent[] = [];
    let changed: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      owner.subscribe("auth/clients", { onReady: () => resolve() }, (event) => {
        changes.push(event);
        changed();
      });
    });
    await ready;
    const next = () => new Promise<void>((resolve) => (changed = resolve));

    let seen = next();
    const { code } = (await node.kernel.commands.execute("auth.pairing.create", {})) as {
      code: string;
    };
    await seen;
    seen = next();
    const paired = (await (await post(`${httpUrl(node)}/auth/pair`, { code })).json()) as {
      id: string;
    };
    await seen;
    seen = next();
    await node.kernel.commands.execute("auth.clients.revoke", { id: paired.id });
    await seen;
    expect(changes.map((event) => event.type)).toEqual([
      "auth.clients.changed",
      "auth.clients.changed",
      "auth.clients.changed",
    ]);
    expect(JSON.stringify(changes)).not.toContain(code);

    const narrow = (await node.kernel.commands.execute("auth.tokens.issue", {
      label: "narrow",
      permissions: ["app.read"],
    })) as { token: string };
    const refused = await new Promise<unknown>((resolve) => {
      connect(node.url, narrow.token).subscribe("auth/clients", { onError: resolve }, () => {});
    });
    expect(refused).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("keeps only the latest change for a subscriber that joins later", async () => {
    const node = await startNode();
    for (let index = 0; index < 3; index += 1) {
      await node.kernel.commands.execute("auth.pairing.create", {});
    }
    const late = connect(node.url, node.token);
    const seen: StoredEvent[] = [];
    let head = Number.POSITIVE_INFINITY;
    let marked: () => void = () => {};
    const next = new Promise<void>((resolve) => (marked = resolve));
    await new Promise<void>((resolve) => {
      late.subscribe(
        "auth/clients",
        {
          after: 0,
          onReady: (at) => {
            head = at;
            resolve();
          },
        },
        (event) => {
          seen.push(event);
          // The change made after joining is above the head; all kept ones come first.
          if (event.sequence > head) marked();
        },
      );
    });
    await node.kernel.commands.execute("auth.pairing.create", {});
    await next;
    // Three changes before joining left one event; then the new one.
    expect(seen.map((event) => event.type)).toEqual([
      "auth.clients.changed",
      "auth.clients.changed",
    ]);
  });

  it("adds T3's client-page link when the node knows where a jhin client page is", async () => {
    const node = await startNode();
    const plain = (await node.kernel.commands.execute("auth.pairing.create", {})) as {
      clientLink?: string;
    };
    expect(plain.clientLink).toBeUndefined();
    const linked = (await node.kernel.commands.execute("auth.pairing.create", {
      label: "Living room iPad",
      baseUrl: "https://studio.tail1234.ts.net/",
      clientUrl: "https://jhin.example.com/app/",
    })) as { code: string; url: string; clientLink: string };
    expect(linked.url).toBe(`https://studio.tail1234.ts.net/pair#token=${linked.code}`);
    expect(linked.clientLink).toBe(
      `https://jhin.example.com/app/pair?host=${encodeURIComponent("https://studio.tail1234.ts.net")}&label=Living+room+iPad#token=${linked.code}`,
    );
    await expect(
      node.kernel.commands.execute("auth.pairing.create", {
        clientUrl: "https://jhin.example.com/?x=1",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });
});
