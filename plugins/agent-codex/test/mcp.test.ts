import { AGENT_PERMISSIONS, type McpGrant, type McpServer } from "@jhin/mcp-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID, Config, createCodexRuntime } from "../src/index.ts";
import { fakeCodex, stopAll } from "./support.ts";

afterEach(stopAll);

const threads = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
};

/** An `mcp.server@1` that records what it issued and what was revoked. */
function mcpServer() {
  const issued: McpGrant[] = [];
  const revoked: string[] = [];
  let onRevoke = () => {};
  const server: McpServer = {
    url: "http://127.0.0.1:4100/mcp",
    issue(grant) {
      issued.push(grant);
      return {
        url: "http://127.0.0.1:4100/mcp",
        headers: { Authorization: `Bearer token-${issued.length}` },
        dispose: () => {
          revoked.push(grant.id);
          onRevoke();
        },
      };
    },
  };
  /** Resolves at the next revocation. */
  const nextRevoke = () => new Promise<void>((resolve) => (onRevoke = resolve));
  return { server, issued, revoked, nextRevoke };
}

async function runTurn(config: Record<string, unknown> = {}) {
  const fake = fakeCodex({});
  const mcp = mcpServer();
  const codex = createCodexRuntime({
    threads,
    mcp: mcp.server,
    config: () => Config.parse({ ...fake.config, ...config }),
  });
  const turn = codex.startTurn({
    threadId: "thread-1",
    turnId: "turn-1",
    input: { text: "hi" },
    history: [],
    cwd: process.cwd(),
    model: "gpt-6-astra",
    instructions: "Be brief.",
  });
  for await (const _ of turn.items) void _;
  return { fake, mcp, codex };
}

describe("jhin.agent-codex: the node's MCP server", () => {
  it("gives each app-server a credential of its own in the thread's config, revoked when it ends", async () => {
    const { fake, mcp, codex } = await runTurn();
    expect(mcp.issued).toEqual([
      { id: `${CODEX_AGENT_ID}:thread-1`, permissions: AGENT_PERMISSIONS, threadId: "thread-1" },
    ]);
    expect(fake.received("thread/start")[0]?.params).toMatchObject({
      config: {
        "tools.update_plan.enabled": true,
        mcp_servers: {
          jhin: {
            url: "http://127.0.0.1:4100/mcp",
            tool_timeout_sec: 3900,
            http_headers: { Authorization: "Bearer token-1" },
          },
        },
      },
    });
    const started = fake.received("turn/start")[0]!.params as {
      collaborationMode: { settings: { developer_instructions: string } };
    };
    const instructions = started.collaborationMode.settings.developer_instructions;
    expect(instructions).toMatch(/^## Jhin tools\n/);
    expect(instructions).toMatch(/\n\nBe brief\.$/);
    // Not on the command line: the token stays out of argv.
    expect(JSON.stringify(fake.log()[0])).not.toContain("token-1");
    expect(mcp.revoked).toEqual([]);
    const revoked = mcp.nextRevoke();
    codex.dispose();
    await revoked;
    expect(mcp.revoked).toEqual([`${CODEX_AGENT_ID}:thread-1`]);
  });

  it("gives none when the config turns it off", async () => {
    const { fake, mcp } = await runTurn({ mcp: false });
    expect(mcp.issued).toEqual([]);
    expect(fake.received("thread/start")[0]?.params).not.toHaveProperty("config.mcp_servers");
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      collaborationMode: { settings: { developer_instructions: "Be brief." } },
    });
  });
});
