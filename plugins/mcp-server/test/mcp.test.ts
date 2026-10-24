import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { MCP_SERVER_CAPABILITY, type McpServer } from "@jhin/mcp-api";
import { toolName } from "@jhin/mcp-bridge";
import { connectWebSocket, createRpcClient } from "@jhin/rpc";
import { definePlugin, z, type CancelSignal, type PluginDefinition } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  testManifest,
  type TestKernel,
} from "@jhin/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// The SDK's transport types disagree under exactOptionalPropertyTypes; the objects match.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vite-plus/test";

import agent from "../../agent-fake/src/index.ts";
import auth from "../../auth-token/src/index.ts";
import http from "../../http/src/index.ts";
import threads from "../../threads/src/index.ts";
import transport from "../../transport-ws/src/index.ts";
import mcp, { localEndpoint } from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;
const real = (dir: string, definition: PluginDefinition) => ({
  manifest: manifest(dir),
  definition,
});

let kernel: TestKernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
});

/** The `mcp.server@1` service, as a plugin that uses it gets it. */
let server: McpServer | undefined;
/** The signal of each `app.hang` call, as it starts. */
let hung: ((signal: CancelSignal | undefined) => void) | undefined;

async function startNode() {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-mcp-"));
  const storage = memoryStoragePlugin();
  kernel = await createTestKernel({
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
      real("threads", threads),
      real("agent-fake", agent),
      real("mcp-server", mcp),
      {
        manifest: testManifest("app.titled"),
        definition: definePlugin({
          activate(context) {
            context.commands.register({
              name: "app.hello",
              title: "Say hello",
              description: "Says hello",
              input: z.object({}),
              output: z.object({ text: z.string() }),
              handler: () => ({ text: "hello" }),
            });
          },
        }),
      },
      {
        manifest: testManifest("app.agent", { optional: { "mcp.server": "^1" } }),
        definition: definePlugin({
          activate(context) {
            server = context.services.tryGet<McpServer>(MCP_SERVER_CAPABILITY);
            context.commands.register({
              name: "app.hang",
              description: "Answers once its caller went away",
              input: z.object({}),
              output: z.object({}),
              handler: (_input, invocation) =>
                new Promise<Record<string, never>>((resolve) => {
                  invocation.signal?.addEventListener("abort", () => resolve({}));
                  hung?.(invocation.signal);
                }),
            });
            context.commands.register({
              name: "app.whoami",
              description: "Who calls",
              input: z.object({}),
              output: z.object({ id: z.string().optional(), threadId: z.string().optional() }),
              permissions: ["threads.read"],
              handler: (_input, invocation) => ({
                ...(invocation.caller === undefined ? {} : { id: invocation.caller.id }),
                ...(invocation.threadId === undefined ? {} : { threadId: invocation.threadId }),
              }),
            });
          },
        }),
      },
    ],
    config: { node: { "jhin.http": { port: 0 } } },
  });
  expect(kernel.inspect().plugins.filter((plugin) => plugin.status !== "active")).toEqual([]);
  const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
  const { token } = (await kernel.commands.execute("auth.token.show", {})) as { token: string };
  return { kernel, url, token };
}

async function mcpClient(
  url: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<Client> {
  const client = new Client({ name: "jhin-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { ...headers, authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

describe("jhin.mcp-server", () => {
  it("lists every command as a tool and reads back a turn driven over RPC", async () => {
    const node = await startNode();
    const rpc = createRpcClient({
      connect: () => connectWebSocket(`${node.url.replace(/^http/, "ws")}/rpc`, node.token),
    });

    // Drive a full turn over RPC (WebSocket).
    const thread = await rpc.call<{ id: string }>("threads.create", { title: "Over RPC" });
    const seen: StoredEvent[] = [];
    const completed = new Promise<void>((resolve) =>
      rpc.subscribe(`thread/${thread.id}`, {}, (event) => {
        seen.push(event);
        if (event.type === "agent.turn.completed") resolve();
      }),
    );
    await rpc.call("threads.send", { threadId: thread.id, text: "ping" });
    await completed;
    rpc.close();

    // Read it back over MCP.
    const client = await mcpClient(node.url, node.token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      node.kernel.commands
        .list()
        .map((command) => toolName(command.name))
        .toSorted(),
    );
    // A command's title is the tool's title.
    expect(tools.find((tool) => tool.name === "app_hello")?.title).toBe("Say hello");
    expect(tools.find((tool) => tool.name === "threads_send")?.title).toBeUndefined();
    expect(tools.find((tool) => tool.name === "threads_send")?.inputSchema).toMatchObject({
      type: "object",
      properties: { threadId: { type: "string" }, text: { type: "string" } },
    });

    const result = await client.callTool({
      name: "threads_events",
      arguments: { threadId: thread.id },
    });
    const events = JSON.parse((result.content as { text: string }[])[0]!.text) as StoredEvent[];
    expect(events).toEqual(seen);
    expect(events.at(-2)?.payload).toMatchObject({ text: "Echo: ping" });

    const failure = await client.callTool({
      name: "threads_send",
      arguments: { threadId: "missing", text: "x" },
    });
    expect(failure.isError).toBe(true);
    expect(JSON.parse((failure.content as { text: string }[])[0]!.text)).toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
    await client.close();
  });

  it("gives an agent a credential of its own, limited to its permissions and revoked on dispose", async () => {
    const node = await startNode();
    expect(server?.url).toBe(`${node.url}/mcp`);
    const credential = server!.issue({
      id: "jhin.agent-claude:thread-1",
      permissions: ["threads.read"],
      threadId: "thread-1",
    });
    expect(credential.url).toBe(`${node.url}/mcp`);
    expect(credential.headers["x-jhin-thread"]).toBe("thread-1");
    const token = credential.headers["Authorization"]!.replace(/^Bearer /, "");
    // A header naming another thread does not move the credential off its own.
    const client = await mcpClient(node.url, token, { "x-jhin-thread": "thread-2" });

    // Only the tools it may run: no auth.token.show, no threads.send.
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("threads_list");
    expect(names).toContain("app_whoami");
    expect(names).not.toContain("auth_token_show");
    expect(names).not.toContain("threads_send");

    const whoami = await client.callTool({ name: "app_whoami", arguments: {} });
    expect(whoami.structuredContent).toEqual({
      id: "jhin.agent-claude:thread-1",
      threadId: "thread-1",
    });
    const refused = await client.callTool({ name: "auth_token_show", arguments: {} });
    expect(refused.isError).toBe(true);
    // Not even there for it; the kernel would refuse the call anyway.
    expect(refused.content).toEqual([{ type: "text", text: "Unknown tool auth_token_show" }]);
    await client.close();

    credential.dispose();
    await expect(mcpClient(node.url, token)).rejects.toThrow();
    expect(() => server!.issue({ id: "agent", permissions: ["*"] })).toThrow();
  });

  it("takes the thread from the header for the node's own token", async () => {
    const node = await startNode();
    const client = await mcpClient(node.url, node.token, { "x-jhin-thread": "thread-3" });
    const whoami = await client.callTool({ name: "app_whoami", arguments: {} });
    expect(whoami.structuredContent).toEqual({ id: "owner", threadId: "thread-3" });
    await client.close();
  });

  it("aborts a call's signal when its client goes away before the answer (D1501)", async () => {
    const node = await startNode();
    const client = await mcpClient(node.url, node.token);
    const started = new Promise<CancelSignal | undefined>((resolve) => (hung = resolve));

    const call = client.callTool({ name: "app_hang", arguments: {} }).catch(() => undefined);
    const signal = await started;
    expect(signal?.aborted).toBe(false);
    const aborted = new Promise<void>((resolve) =>
      signal!.addEventListener("abort", () => resolve()),
    );
    await client.close();

    await aborted;
    expect(signal!.aborted).toBe(true);
    await call;
  });

  it("names the endpoint by loopback when HTTP listens on every address", () => {
    expect(localEndpoint("http://0.0.0.0:4100")).toBe("http://127.0.0.1:4100/mcp");
    expect(localEndpoint("http://[::]:4100")).toBe("http://[::1]:4100/mcp");
    expect(localEndpoint("http://192.168.1.5:4100")).toBe("http://192.168.1.5:4100/mcp");
  });

  it("refuses MCP requests without the token", async () => {
    const node = await startNode();

    const response = await fetch(`${node.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    await expect(
      mcpClient(node.url, "wrong-token-wrong-token-wrong-token-wrong-to"),
    ).rejects.toThrow();
  });
});
