import type { TurnRequest } from "@jhin/agent-api";
import type { McpGrant, McpServer } from "@jhin/mcp-api";
import type { z } from "@jhin/sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AGENT_PERMISSIONS, Config, createClaudeRuntime } from "../src/index.ts";
import {
  drain,
  init,
  memorySessions,
  result,
  scriptedQuery,
  streamedBlock,
  type Script,
} from "./support.ts";

const THREAD = "0b6c5e5e-0000-4000-8000-000000000004";

/** Claude Code answering one turn after another on one process, then waiting until closed. */
const answering = (...answers: string[]): Script =>
  async function* (player) {
    for (const [index, answer] of answers.entries()) {
      if (index > 0 && (await player.nextPrompt()) === undefined) return;
      yield init();
      yield* streamedBlock(`m${index}`, 0, "text", [answer]);
      yield result();
    }
    await player.nextPrompt();
  };

/** An `mcp.server@1` that hands out numbered tokens and records which are still valid. */
function fakeServer() {
  const grants: McpGrant[] = [];
  const valid = new Set<string>();
  const state = { refuse: false };
  const server: McpServer = {
    url: "http://127.0.0.1:4100/mcp",
    issue(grant) {
      if (state.refuse) throw new Error("no credentials today");
      grants.push(grant);
      const token = `token-${grants.length}`;
      valid.add(token);
      return {
        url: server.url,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(grant.threadId === undefined ? {} : { "x-jhin-thread": grant.threadId }),
        },
        dispose: () => void valid.delete(token),
      };
    },
  };
  return { server, grants, valid, state };
}

function node(scripts: Script[], config: z.input<typeof Config> = {}) {
  const scripted = scriptedQuery(...scripts);
  const settings = { config: Config.parse(config) };
  const mcp = fakeServer();
  const warnings: { message: string; data?: Record<string, unknown> }[] = [];
  const claude = createClaudeRuntime({
    query: scripted.query,
    sessions: memorySessions(),
    config: () => settings.config,
    mcp: mcp.server,
    readOnlyTool: (tool) => tool === "threads_list",
    log: (message, data) => warnings.push({ message, ...(data === undefined ? {} : { data }) }),
  });
  let turns = 0;
  const request = (overrides: Partial<TurnRequest> = {}): TurnRequest => ({
    threadId: THREAD,
    turnId: `t${++turns}`,
    input: { text: `turn ${turns}` },
    history: [],
    cwd: "/work",
    model: "claude-haiku-5-5",
    runtimeMode: "approval-required",
    ...overrides,
  });
  const turn = () => drain(claude.startTurn(request()));
  return { claude, turn, request, settings, mcp, warnings, ...scripted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("jhin.agent-claude: the node's MCP server (D340)", () => {
  it("gives a Claude Code it starts the server over the control channel, with a credential of its own", async () => {
    const { claude, turn, calls, mcp } = node([answering("one", "two"), answering("three")]);
    await turn();
    await turn();

    expect(calls).toHaveLength(1);
    // Registered once, after the start: the token is in neither argv nor the environment.
    expect(calls[0]!.mcpServers).toEqual([
      {
        jhin: {
          type: "http",
          url: "http://127.0.0.1:4100/mcp",
          headers: { Authorization: "Bearer token-1", "x-jhin-thread": THREAD },
          timeout: 65 * 60_000,
        },
      },
    ]);
    expect(calls[0]!.options).not.toHaveProperty("mcpServers");
    expect(JSON.stringify(calls[0]!.options.env)).not.toContain("token-1");
    // Not through allowedTools: the SDK would warn on every query.
    expect(calls[0]!.options).not.toHaveProperty("allowedTools");
    expect(calls[0]!.options.systemPrompt).toMatchObject({
      append: expect.stringContaining("## Jhin tools"),
    });
    expect(mcp.grants).toEqual([
      { id: `jhin.agent-claude:${THREAD}`, permissions: AGENT_PERMISSIONS, threadId: THREAD },
    ]);
    expect(AGENT_PERMISSIONS).not.toContain("*");
    expect(AGENT_PERMISSIONS).not.toContain("host.inspect");

    // The credential lives as long as that Claude Code.
    expect(mcp.valid).toEqual(new Set(["token-1"]));
    claude.live.close(THREAD);
    expect(mcp.valid).toEqual(new Set());

    // Disposing the runtime (the plugin deactivating or reloading) revokes them too.
    await turn();
    expect(mcp.valid).toEqual(new Set(["token-2"]));
    claude.dispose();
    expect(mcp.valid).toEqual(new Set());
  });

  it("approves the node's tools without asking, and only with the server attached", async () => {
    const decisions: unknown[] = [];
    const asking: Script = async function* (player) {
      yield init();
      decisions.push(await player.canUseTool("mcp__jhin__threads_list", {}, "tool-1"));
      yield result();
      await player.nextPrompt();
    };
    const attached = node([asking]);
    const items = await attached.turn();
    expect(decisions).toEqual([{ behavior: "allow", updatedInput: {}, toolUseID: "tool-1" }]);
    expect(items.some((item) => item.kind === "request.opened")).toBe(false);

    // Without the server a tool of that name is anyone's: it asks, as any other.
    const detached = node([asking], { mcp: false });
    const turn = detached.claude.startTurn(detached.request());
    for await (const item of turn.items) {
      if (item.kind === "request.opened") {
        expect(item.requestId).toBe("tool-1:approval");
        turn.respond!(item.requestId, { kind: "approval", decision: "decline" });
      }
    }
    expect(decisions[1]).toMatchObject({ behavior: "deny" });
  });

  it("approves only the node's tools that read; the others ask in every mode but full access", async () => {
    const decisions: unknown[] = [];
    const { claude, request } = node([
      async function* (player) {
        yield init();
        decisions.push(await player.canUseTool("mcp__jhin__threads_list", {}, "tool-1"));
        decisions.push(await player.canUseTool("mcp__jhin__threads_send", {}, "tool-2"));
        yield result();
        await player.nextPrompt();
      },
    ]);
    const turn = claude.startTurn(request());
    const asked: string[] = [];
    for await (const item of turn.items) {
      if (item.kind === "request.opened") {
        asked.push(item.requestId);
        turn.respond!(item.requestId, { kind: "approval", decision: "decline" });
      }
    }
    expect(asked).toEqual(["tool-2:approval"]);
    expect(decisions[0]).toMatchObject({ behavior: "allow" });
    expect(decisions[1]).toMatchObject({ behavior: "deny" });
  });

  it("lets a writing tool of the node run without asking only with full access", async () => {
    const decisions: unknown[] = [];
    const { claude, request } = node([
      async function* (player) {
        yield init();
        decisions.push(await player.canUseTool("mcp__jhin__threads_send", {}, "tool-1"));
        yield result();
        await player.nextPrompt();
      },
    ]);
    const items = await drain(claude.startTurn(request({ runtimeMode: "full-access" })));
    expect(items.some((item) => item.kind === "request.opened")).toBe(false);
    expect(decisions).toEqual([{ behavior: "allow", updatedInput: {}, toolUseID: "tool-1" }]);
  });

  it("leaves no Claude Code behind when the credential cannot be issued", async () => {
    const { turn, calls, mcp, claude } = node([answering("one")]);
    mcp.state.refuse = true;
    await expect(turn()).rejects.toThrow("no credentials today");
    expect(calls[0]!.closed).toBe(true);
    expect(claude.live.list()).toEqual([]);
  });

  it("issues a new credential for every Claude Code and revokes each with it", async () => {
    const { turn, calls, mcp } = node([answering("one"), answering("two")], {
      session: "per-turn",
    });
    await turn();
    expect(calls[0]!.closed).toBe(true);
    expect(mcp.valid).toEqual(new Set());
    await turn();
    expect(calls[1]!.mcpServers[0]).toMatchObject({
      jhin: { headers: { Authorization: "Bearer token-2" } },
    });
    expect(mcp.valid).toEqual(new Set());
  });

  it("attaches nothing when the config turns it off, and restarts a live session on the change", async () => {
    const { turn, calls, mcp, settings } = node([answering("one"), answering("two")], {
      mcp: false,
    });
    await turn();
    expect(calls[0]!.mcpServers).toEqual([]);
    expect(calls[0]!.options.systemPrompt).toMatchObject({
      append: expect.not.stringContaining("## Jhin tools"),
    });
    expect(mcp.grants).toEqual([]);

    settings.config = Config.parse({ mcp: true });
    await turn();
    expect(calls[0]!.closed).toBe(true);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD });
    expect(calls[1]!.mcpServers).toHaveLength(1);
  });

  it("runs without the server when Claude Code cannot connect it, with a warning", async () => {
    const { turn, state, warnings, calls } = node([answering("one")]);
    state.mcp = "fail";
    const items = await turn();
    expect(items).toContainEqual({ kind: "message.completed", itemId: "m0:0", text: "one" });
    expect(warnings).toContainEqual({
      message: "claude code could not connect mcp servers",
      data: { threadId: THREAD, servers: ["jhin"] },
    });
    // The warning names servers only: error texts can echo the headers.
    expect(JSON.stringify(warnings)).not.toContain("token-1");
    expect(calls[0]!.closed).toBe(false);
  });

  it("fails the turn when Claude Code never answers the registration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { turn, state, calls, mcp } = node([answering("one")]);
    state.mcp = "silent";
    const failed = expect(turn()).rejects.toThrow(
      "Claude Code did not answer the MCP server registration.",
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await failed;
    expect(calls[0]!.closed).toBe(true);
    expect(calls[0]!.prompt).toEqual([]);
    expect(mcp.valid).toEqual(new Set());
  });
});
