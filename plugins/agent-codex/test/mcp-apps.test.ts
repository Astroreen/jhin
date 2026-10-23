import { createMemoryStorage } from "@jhin/storage-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID, Config, appDocuments, createCodexRuntime } from "../src/index.ts";
import {
  injectMcpAppCsp,
  mcpAppContentSecurityPolicy,
  readMcpAppCsp,
  snapshotMcpApp,
} from "../src/mcp-apps.ts";
import { fakeCodex, node, payloads, stopAll, until, type Client } from "./support.ts";

afterEach(stopAll);

const APP_URI = "ui://board/view";
const appCall = (resourceUri = APP_URI) => ({
  notify: "item/completed",
  params: {
    threadId: "$thread",
    turnId: "$turn",
    item: {
      type: "mcpToolCall",
      id: "call-1",
      server: "board",
      tool: "show_board",
      status: "completed",
      arguments: { project: "jhin" },
      result: { content: [{ type: "text", text: "Board shown" }] },
      mcpAppUi: { resourceUri },
    },
  },
});

const BOARD_APP = {
  uri: APP_URI,
  mimeType: "text/html;profile=mcp-app",
  text: "<!doctype html><p>Board</p>",
};
/** The board server's tools: one apps may call, one only the model sees. */
const BOARD_TOOLS = {
  board: [
    { name: "move_card", inputSchema: {} },
    { name: "delete_board", inputSchema: {}, _meta: { ui: { visibility: ["model"] } } },
  ],
};

/** Runs one turn on a new Codex thread; answers the thread and the call's app. */
async function showBoard(client: Client) {
  const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
  const done = until(client, thread.id, "agent.turn.completed");
  await client.call("threads.send", { threadId: thread.id, text: "show the board" });
  const completed = payloads(await done, "agent.item.completed").find(
    (payload) => payload["itemId"] === "call-1",
  );
  return { thread, app: completed!["app"] as Record<string, unknown> | undefined };
}

describe("jhin.agent-codex: MCP apps (D1401, D1402)", () => {
  it("keeps the app a tool call returned, and calls its server for it", async () => {
    const fake = fakeCodex({
      turns: [[appCall(), { complete: "completed" }]],
      mcpTools: BOARD_TOOLS,
      resources: {
        [APP_URI]: [
          {
            uri: APP_URI,
            mimeType: "text/html;profile=mcp-app",
            text: "<!doctype html><p>Board</p>",
            _meta: {
              ui: {
                csp: { connectDomains: ["https://api.board.dev", "javascript:alert(1)"] },
                permissions: { clipboardWrite: {} },
                prefersBorder: true,
              },
            },
          },
        ],
      },
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "show the board" });
    const completed = payloads(await done, "agent.item.completed").find(
      (payload) => payload["itemId"] === "call-1",
    );
    const app = completed!["app"] as Record<string, unknown>;
    expect(app).toEqual({
      server: "board",
      tool: "show_board",
      resourceUri: APP_URI,
      documentId: expect.any(String),
      csp: { connectDomains: ["https://api.board.dev"] },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
    });
    expect(fake.received("mcpServer/resource/read")[0]!.params).toMatchObject({
      server: "board",
      uri: APP_URI,
    });
    // Its document carries the policy, first thing after the doctype.
    const { html } = await client.call<{ html: string }>("agents.mcp-app.document", {
      threadId: thread.id,
      documentId: app["documentId"],
    });
    expect(html).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    expect(html).toContain("connect-src https://api.board.dev");
    expect(html.endsWith("<p>Board</p>")).toBe(true);
    // The app's calls go to its own server on the thread's running Codex.
    const { result } = await client.call<{ result: Record<string, unknown> }>(
      "agents.mcp-app.call-tool",
      {
        threadId: thread.id,
        documentId: app["documentId"],
        tool: "move_card",
        arguments: { card: 3 },
      },
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "called" }],
      structuredContent: { server: "board", tool: "move_card", arguments: { card: 3 } },
    });
    const read = await client.call<{ result: { contents: unknown[] } }>(
      "agents.mcp-app.read-resource",
      { threadId: thread.id, documentId: app["documentId"], uri: APP_URI },
    );
    expect(read.result.contents).toHaveLength(1);
    expect(fake.received("mcpServer/resource/read")[1]!.params).toMatchObject({ server: "board" });
    for (const documentId of ["../x", "A".repeat(64), "0b6c5e5e-0000-4000-8000-000000000001"]) {
      await expect(
        client.call("agents.mcp-app.document", { threadId: thread.id, documentId }),
      ).rejects.toMatchObject({ code: "MCP_APP_NOT_FOUND" });
    }
  });

  it("sends an app's calls only to its own server, and only tools apps may call", async () => {
    const fake = fakeCodex({
      turns: [
        [appCall(), { complete: "completed" }],
        [appCall(), { complete: "completed" }],
      ],
      resources: { [APP_URI]: [BOARD_APP] },
      mcpTools: BOARD_TOOLS,
    });
    const { client } = await node(fake);
    const { thread, app } = await showBoard(client);
    const documentId = app!["documentId"] as string;
    const call = (tool: string, threadId = thread.id, id = documentId) =>
      client.call("agents.mcp-app.call-tool", { threadId, documentId: id, tool, arguments: {} });
    // Hidden from apps, or not the server's at all: refused before Codex is asked.
    await expect(call("delete_board")).rejects.toMatchObject({ code: "MCP_APP_TOOL_NOT_CALLABLE" });
    await expect(call("rm_rf")).rejects.toMatchObject({ code: "MCP_APP_TOOL_NOT_CALLABLE" });
    expect(fake.received("mcpServer/tool/call")).toHaveLength(0);
    // An app no tool call of the thread returned names nothing: not even the thread's own
    // app's id on another thread.
    const other = await showBoard(client);
    expect(other.app!["documentId"]).toBe(documentId);
    await expect(call("move_card", thread.id, "f".repeat(64))).rejects.toMatchObject({
      code: "MCP_APP_NOT_FOUND",
    });
    await expect(
      client.call("agents.mcp-app.read-resource", {
        threadId: thread.id,
        documentId: "f".repeat(64),
        uri: APP_URI,
      }),
    ).rejects.toMatchObject({ code: "MCP_APP_NOT_FOUND" });
  });

  it("keeps an app the thread's calls return again once", async () => {
    const fake = fakeCodex({
      turns: [
        [appCall(), { complete: "completed" }],
        [appCall(), { complete: "completed" }],
      ],
      resources: { [APP_URI]: [BOARD_APP] },
    });
    const { client, storage } = await node(fake);
    const { thread, app } = await showBoard(client);
    const done = until(client, thread.id, "agent.turn.completed", 2);
    await client.call("threads.send", { threadId: thread.id, text: "again" });
    const again = payloads(await done, "agent.item.completed").filter(
      (payload) => payload["itemId"] === "call-1",
    );
    expect(again.map((payload) => (payload["app"] as { documentId: string }).documentId)).toEqual([
      app!["documentId"],
      app!["documentId"],
    ]);
    const kept = await storage.storage.kv.list("jhin.agent-codex", { prefix: "mcp-app/" });
    expect(kept).toHaveLength(1);
  });

  it("keeps documents per thread, and forgets a thread's", async () => {
    const documents = appDocuments(createMemoryStorage().kv);
    const board = { html: "<p>Board</p>", server: "board", tool: "show" };
    const id = await documents.keep("t1", board);
    expect(await documents.keep("t1", board)).toBe(id);
    // Another server's app of the same document is another app.
    expect(await documents.keep("t1", { ...board, server: "other" })).not.toBe(id);
    await documents.keep("t2", board);
    expect(await documents.get("t1", id)).toEqual(board);
    await documents.forget("t1");
    expect(await documents.get("t1", id)).toBeUndefined();
    expect(await documents.get("t2", id)).toEqual(board);
  });

  it("ends an interrupted turn without waiting for an app's read", async () => {
    const fake = fakeCodex({
      turns: [[appCall(), { waitForInterrupt: true }, { complete: "interrupted" }]],
      hangOn: ["mcpServer/resource/read"],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const started = until(client, thread.id, "agent.item.started");
    const done = until(client, thread.id, "agent.turn.interrupted");
    await client.call("threads.send", { threadId: thread.id, text: "show the board" });
    await started;
    await client.call("threads.interrupt", { threadId: thread.id });
    // The turn ended on the interrupt, not after the read Codex never answers: no app shows.
    const events = await done;
    expect(payloads(events, "agent.item.completed").some((payload) => "app" in payload)).toBe(
      false,
    );
  });

  it("says an app's call needs the thread's Codex running", async () => {
    const documents = appDocuments(createMemoryStorage().kv);
    const documentId = await documents.keep("t1", {
      html: "<p>x</p>",
      server: "board",
      tool: "show",
    });
    const codex = createCodexRuntime({
      threads: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
      },
      appDocuments: documents,
      config: () => Config.parse({}),
    });
    await expect(
      codex.mcpApps!.callTool({ threadId: "t1", documentId, tool: "move_card", arguments: {} }),
    ).rejects.toMatchObject({ name: "McpAppRequestError", reason: "session-stopped" });
    await expect(
      codex.mcpApps!.readResource({ threadId: "t2", documentId, uri: APP_URI }),
    ).rejects.toMatchObject({ reason: "not-an-app" });
    codex.dispose();
  });

  it("reads an app's document as text or base64, up to 5 MiB", async () => {
    const snapshot = (content: Record<string, unknown>) =>
      snapshotMcpApp({
        server: "board",
        tool: "show",
        resourceUri: APP_URI,
        contents: [{ uri: APP_URI, mimeType: "text/html;profile=mcp-app", ...content }],
        keep: async (html) => html,
      });
    const blob = await snapshot({ blob: Buffer.from("<p>from base64</p>").toString("base64") });
    expect(blob?.documentId).toContain("<p>from base64</p>");
    expect(await snapshot({ text: "x".repeat(5 * 1024 * 1024 + 1) })).toBeUndefined();
    expect(
      await snapshot({ blob: Buffer.from("x".repeat(5 * 1024 * 1024 + 1)).toString("base64") }),
    ).toBeUndefined();
    // Multibyte text over the limit in bytes, under it in characters.
    expect(await snapshot({ text: "é".repeat(3 * 1024 * 1024) })).toBeUndefined();
  });

  it("completes a call whose app cannot be read without one", async () => {
    const fake = fakeCodex({ turns: [[appCall("ui://board/missing"), { complete: "completed" }]] });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "show" });
    const completed = payloads(await done, "agent.item.completed").find(
      (payload) => payload["itemId"] === "call-1",
    );
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed).not.toHaveProperty("app");
  });

  it("builds T3's policy and drops origins that could widen it", () => {
    const csp = readMcpAppCsp({
      resourceDomains: ["https://cdn.example.com", "'unsafe-eval'"],
      frameDomains: "https://x.dev",
    });
    expect(csp).toEqual({ resourceDomains: ["https://cdn.example.com"] });
    expect(mcpAppContentSecurityPolicy(csp)).toBe(
      "default-src 'none'; script-src 'unsafe-inline' https://cdn.example.com; style-src 'unsafe-inline' https://cdn.example.com; img-src data: blob: https://cdn.example.com; font-src data: https://cdn.example.com; media-src data: blob: https://cdn.example.com; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(injectMcpAppCsp("<p>x</p>", undefined)).toMatch(/^<!doctype html><meta /);
  });
});
