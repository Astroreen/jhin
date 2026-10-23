import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { injectMcpAppCsp, mcpAppContentSecurityPolicy, readMcpAppCsp } from "../src/mcp-apps.ts";
import { fakeCodex, node, payloads, stopAll, until } from "./support.ts";

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

describe("jhin.agent-codex: MCP apps (D1401–D1403)", () => {
  it("keeps the app a tool call returned, and calls its server for it", async () => {
    const fake = fakeCodex({
      turns: [[appCall(), { complete: "completed" }]],
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
    // The app's calls go to the thread's running Codex.
    const { result } = await client.call<{ result: Record<string, unknown> }>(
      "agents.mcp-app.call-tool",
      { threadId: thread.id, server: "board", tool: "move_card", arguments: { card: 3 } },
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "called" }],
      structuredContent: { server: "board", tool: "move_card", arguments: { card: 3 } },
    });
    const read = await client.call<{ result: { contents: unknown[] } }>(
      "agents.mcp-app.read-resource",
      { threadId: thread.id, server: "board", uri: APP_URI },
    );
    expect(read.result.contents).toHaveLength(1);
    await expect(
      client.call("agents.mcp-app.document", { threadId: thread.id, documentId: "../x" }),
    ).rejects.toMatchObject({ code: "MCP_APP_NOT_FOUND" });
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
