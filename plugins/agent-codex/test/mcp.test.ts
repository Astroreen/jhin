import { AGENT_PERMISSIONS, type McpGrant, type McpServer } from "@jhin/mcp-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID, Config, createCodexRuntime } from "../src/index.ts";
import { fakeCodex, stopAll, type Scenario } from "./support.ts";

const runtimes: { dispose(): void }[] = [];
afterEach(async () => {
  for (const codex of runtimes.splice(0)) codex.dispose();
  await stopAll();
});

/** An `mcp.server@1` that records what it issued and what was revoked. */
function mcpServer() {
  const issued: McpGrant[] = [];
  const revoked: string[] = [];
  let onRevoke = () => {};
  const server: McpServer = {
    url: "http://127.0.0.1:4100/mcp",
    issue(grant) {
      issued.push(grant);
      const token = `token-${issued.length}`;
      return {
        url: "http://127.0.0.1:4100/mcp",
        headers: { Authorization: `Bearer ${token}` },
        dispose: () => {
          revoked.push(token);
          onRevoke();
        },
      };
    },
  };
  /** Resolves at the next revocation. */
  const nextRevoke = () => new Promise<void>((resolve) => (onRevoke = resolve));
  return { server, issued, revoked, nextRevoke };
}

function setup(config: Record<string, unknown> = {}, scenario: Scenario = {}) {
  const fake = fakeCodex(scenario);
  const mcp = mcpServer();
  const records = new Map<string, string>();
  const settings = { ...fake.config, ...config };
  const codex = createCodexRuntime({
    threads: {
      get: async (threadId) => records.get(threadId),
      set: async (threadId, codexThreadId) => void records.set(threadId, codexThreadId),
      delete: async (threadId) => void records.delete(threadId),
    },
    mcp: mcp.server,
    config: () => Config.parse(settings),
  });
  runtimes.push(codex);
  const run = async (turnId: string) => {
    let failed: unknown;
    const turn = codex.startTurn({
      threadId: "thread-1",
      turnId,
      input: { text: "hi" },
      history: [],
      cwd: process.cwd(),
      model: "gpt-6-astra",
      instructions: "Be brief.",
    });
    try {
      for await (const _ of turn.items) void _;
    } catch (error) {
      failed = error;
    }
    return failed;
  };
  return { fake, mcp, codex, settings, run };
}

const jhinServer = (token: string) => ({
  jhin: {
    url: "http://127.0.0.1:4100/mcp",
    tool_timeout_sec: 3900,
    http_headers: { Authorization: `Bearer ${token}` },
  },
});

describe("jhin.agent-codex: the node's MCP server", () => {
  it("gives an app-server a credential of its own in the thread's config", async () => {
    const { fake, mcp, run } = setup();
    await run("turn-1");
    expect(mcp.issued).toEqual([
      { id: `${CODEX_AGENT_ID}:thread-1`, permissions: AGENT_PERMISSIONS, threadId: "thread-1" },
    ]);
    expect(fake.received("thread/start")[0]?.params).toMatchObject({
      config: { "tools.update_plan.enabled": true, mcp_servers: jhinServer("token-1") },
    });
    const started = fake.received("turn/start")[0]!.params as {
      collaborationMode: { settings: { developer_instructions: string } };
    };
    const instructions = started.collaborationMode.settings.developer_instructions;
    expect(instructions).toMatch(/^## Jhin tools\n/);
    expect(instructions).toMatch(/\n\nBe brief\.$/);
    // Neither on the command line nor in the environment Codex and its commands get.
    const launched = fake.log().find((entry) => entry["started"] !== undefined);
    expect(launched).toMatchObject({ started: ["app-server"], sawBearer: false });
  });

  it("keeps one credential while the app-server runs, and a new app-server gets a new one", async () => {
    const { fake, mcp, codex, run } = setup();
    await run("turn-1");
    await run("turn-2");
    expect(mcp.issued).toHaveLength(1);

    const revoked = mcp.nextRevoke();
    codex.sessions.close("thread-1");
    await revoked;
    expect(mcp.revoked).toEqual(["token-1"]);

    // The next turn starts another app-server, which resumes the Codex thread.
    await run("turn-3");
    expect(mcp.issued).toHaveLength(2);
    expect(fake.received("thread/resume")[0]?.params).toMatchObject({
      config: { mcp_servers: jhinServer("token-2") },
    });
  });

  it("revokes the credential of an app-server that exits", async () => {
    const { mcp, run } = setup({}, { turns: [[{ exit: 3 }]] });
    const revoked = mcp.nextRevoke();
    expect(await run("turn-1")).toBeInstanceOf(Error);
    await revoked;
    expect(mcp.revoked).toEqual(["token-1"]);
  });

  it("starts no app-server when the credential cannot be issued", async () => {
    const { fake, mcp, run } = setup();
    mcp.server.issue = () => {
      throw new Error("no credentials today");
    };
    expect(await run("turn-1")).toMatchObject({ message: "no credentials today" });
    expect(fake.log().filter((entry) => entry["started"] !== undefined)).toEqual([]);
  });

  it("starts a new app-server without it once the config turns it off", async () => {
    const { fake, mcp, settings, run } = setup();
    await run("turn-1");
    const revoked = mcp.nextRevoke();
    Object.assign(settings, { mcp: false });
    await run("turn-2");
    await revoked;
    expect(mcp.issued).toHaveLength(1);
    expect(mcp.revoked).toEqual(["token-1"]);
    expect(fake.received("thread/resume")[0]?.params).not.toHaveProperty("config.mcp_servers");
    expect(fake.received("turn/start")[1]?.params).toMatchObject({
      collaborationMode: { settings: { developer_instructions: "Be brief." } },
    });
  });
});
