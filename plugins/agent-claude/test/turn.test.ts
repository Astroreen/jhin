import type { AgentItem, TurnRequest } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { claudeTurn, permissionMode, transcript } from "../src/turn.ts";
import {
  drain,
  init,
  memorySessions,
  result,
  scriptedQuery,
  streamedBlock,
  toolResult,
  toolUse,
  type Script,
} from "./support.ts";

const THREAD = "0b6c5e5e-0000-4000-8000-000000000001";

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    threadId: THREAD,
    turnId: "turn-1",
    input: { text: "hello" },
    history: [],
    cwd: "/work",
    ...overrides,
  };
}

function start(
  scripts: Script[],
  overrides: Partial<TurnRequest> = {},
  sessions = memorySessions(),
) {
  const { query, calls } = scriptedQuery(...scripts);
  const turn = claudeTurn(request(overrides), {
    query,
    sessions,
    settings: {},
    defaultModel: "claude-fable-5-1",
    contextWindow: () => 1_000_000,
  });
  return { turn, calls, sessions };
}

const kinds = (items: readonly AgentItem[]) => items.map((item) => item.kind);

describe("jhin.agent-claude: a turn", () => {
  it("streams reasoning and text once each, then reports usage", async () => {
    const { turn, calls, sessions } = start([
      async function* () {
        yield init();
        yield* streamedBlock("m1", 0, "thinking", ["Let me ", "think"]);
        yield* streamedBlock("m1", 1, "text", ["Hel", "lo!"], { start: false });
        yield result();
      },
    ]);
    const items = await drain(turn);

    expect(kinds(items)).toEqual([
      "usage",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.completed",
      "message.delta",
      "message.delta",
      "message.completed",
      "usage",
    ]);
    expect(items).toContainEqual({ kind: "message.completed", itemId: "m1:1", text: "Hello!" });
    expect(items.at(-1)).toEqual({
      kind: "usage",
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        cachedInputTokens: 90,
        contextTokens: 100,
        contextWindow: 1_000_000,
        costUsd: 0.01,
      },
    });
    // A new session named after the thread, recorded once Claude Code started it.
    expect(calls[0]!.options).toMatchObject({
      sessionId: THREAD,
      cwd: "/work",
      model: "claude-fable-5-1",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    });
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.prompt[0]!.message.content).toBe("hello");
    expect(calls[0]!.closed).toBe(true);
    expect(sessions.ids.has(THREAD)).toBe(true);
  });

  it("completes a block once when its snapshot comes after its stop", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["Hi"], { snapshotLast: true });
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind === "message.completed")).toEqual([
      { kind: "message.completed", itemId: "m1:0", text: "Hi" },
    ]);
  });

  it("resumes the thread's session on a later turn", async () => {
    const { turn, calls } = start(
      [
        async function* () {
          yield init();
          yield result();
        },
      ],
      {},
      memorySessions([THREAD]),
    );
    await drain(turn);
    expect(calls[0]!.options.resume).toBe(THREAD);
    expect(calls[0]!.options.sessionId).toBeUndefined();
  });

  it("starts over once when Claude Code has no session to resume", async () => {
    const sessions = memorySessions([THREAD]);
    const { turn, calls } = start(
      [
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error("No conversation found with session ID: x");
        },
        async function* () {
          yield init();
          yield* streamedBlock("m1", 0, "text", ["fresh"]);
          yield result();
        },
      ],
      {},
      sessions,
    );
    const items = await drain(turn);
    expect(calls.map((call) => [call.options.resume, call.options.sessionId])).toEqual([
      [THREAD, undefined],
      [undefined, THREAD],
    ]);
    expect(items).toContainEqual({ kind: "message.completed", itemId: "m1:0", text: "fresh" });
  });

  it("starts no second query when stopped while the first failed on its session", async () => {
    const sessions = memorySessions([THREAD]);
    const { turn, calls } = start(
      [
        // oxlint-disable-next-line require-yield
        async function* () {
          throw new Error("No conversation found with session ID: x");
        },
        async function* () {
          yield init();
          yield result();
        },
      ],
      {},
      sessions,
    );
    // The stop comes while the turn forgets the session it could not resume.
    const forget = sessions.delete;
    sessions.delete = async (threadId) => {
      turn.interrupt();
      await forget(threadId);
    };
    expect(await drain(turn)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("never starts Claude Code when stopped before the session lookup ends", async () => {
    const sessions = memorySessions();
    let stop = () => {};
    const lookup = sessions.has;
    sessions.has = async (threadId) => {
      const found = await lookup(threadId);
      stop();
      return found;
    };
    const { turn, calls } = start(
      [
        async function* () {
          yield init();
          yield result();
        },
      ],
      {},
      sessions,
    );
    stop = () => turn.interrupt();
    expect(await drain(turn)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("gives Claude the earlier conversation of a thread it joins", async () => {
    const history = [
      { type: "agent.turn.started", payload: { turnId: "a", input: { text: "first question" } } },
      {
        type: "agent.item.completed",
        payload: { turnId: "a", kind: "message", text: "first answer" },
      },
    ] as unknown as StoredEvent[];
    const { turn, calls } = start(
      [
        async function* () {
          yield init();
          yield result();
        },
      ],
      { history, input: { text: "next" } },
    );
    await drain(turn);
    const prompt = calls[0]!.prompt[0]!.message.content as string;
    expect(prompt).toContain("User: first question\nAssistant: first answer");
    expect(prompt.endsWith("next")).toBe(true);
    expect(transcript([])).toBeUndefined();
  });

  it("asks before a tool runs and reports the tool's output", async () => {
    let decision: unknown;
    const { turn, calls } = start(
      [
        async function* (player) {
          yield init();
          yield toolUse("m1", "tool-1", "Bash", { command: "ls -la" });
          decision = await player.canUseTool("Bash", { command: "ls -la" }, "tool-1");
          yield toolResult("tool-1", [{ type: "text", text: "a.txt\nb.txt" }]);
          yield result();
        },
      ],
      { runtimeMode: "approval-required" },
    );
    const items = await drain(turn, () => ({ kind: "approval", decision: "accept" }));

    expect(calls[0]!.options.permissionMode).toBe("default");
    expect(items).toContainEqual({
      kind: "tool.started",
      itemId: "tool-1",
      tool: {
        name: "Bash",
        kind: "command",
        title: "Ran command",
        detail: "ls -la",
        input: { command: "ls -la" },
      },
    });
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "request.opened",
        requestId: "tool-1:approval",
        request: {
          kind: "approval",
          tool: expect.objectContaining({ title: "Run command", detail: "ls -la" }),
        },
      }),
    );
    expect(decision).toMatchObject({ behavior: "allow", updatedInput: { command: "ls -la" } });
    expect(items).toContainEqual({
      kind: "tool.completed",
      itemId: "tool-1",
      status: "completed",
      output: "a.txt\nb.txt",
    });
  });

  it("records a declined tool as declined", async () => {
    let decision: unknown;
    const { turn } = start(
      [
        async function* (player) {
          yield init();
          yield toolUse("m1", "tool-1", "Write", { file_path: "/work/a.txt", content: "x" });
          decision = await player.canUseTool("Write", { file_path: "/work/a.txt" }, "tool-1");
          yield toolResult("tool-1", "User declined tool execution.", { isError: true });
          yield result();
        },
      ],
      { runtimeMode: "auto-accept-edits" },
    );
    const items = await drain(turn, () => ({ kind: "approval", decision: "decline" }));
    expect(decision).toMatchObject({ behavior: "deny", message: "User declined tool execution." });
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "tool.completed", itemId: "tool-1", status: "declined" }),
    );
  });

  it("turns AskUserQuestion into questions and hands the answers back", async () => {
    let decision: unknown;
    const questions = [
      {
        header: "Color",
        question: "Which color?",
        options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
        multiSelect: false,
      },
    ];
    const { turn } = start([
      async function* (player) {
        yield init();
        yield toolUse("m1", "ask-1", "AskUserQuestion", { questions });
        decision = await player.canUseTool("AskUserQuestion", { questions }, "ask-1");
        yield toolResult("ask-1", "User answered");
        yield result();
      },
    ]);
    const items = await drain(turn, () => ({
      kind: "user-input",
      answers: { "Which color?": ["Red", "Blue"] },
    }));

    expect(items.filter((item) => item.kind.startsWith("tool."))).toEqual([]);
    expect(items).toContainEqual({
      kind: "request.opened",
      requestId: "ask-1",
      request: {
        kind: "user-input",
        questions: [
          {
            id: "Which color?",
            header: "Color",
            question: "Which color?",
            options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
            multiSelect: false,
          },
        ],
      },
    });
    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: { questions, answers: { "Which color?": "Red, Blue" } },
    });
  });

  it("shows a proposed plan and keeps Claude in plan mode", async () => {
    let decision: unknown;
    const { turn, calls } = start(
      [
        async function* (player) {
          yield init();
          decision = await player.canUseTool("ExitPlanMode", { plan: "1. Read\n2. Change" }, "p-1");
          yield result();
        },
      ],
      { interactionMode: "plan" },
    );
    const items = await drain(turn);
    expect(calls[0]!.options.permissionMode).toBe("plan");
    expect(items).toContainEqual({
      kind: "message.completed",
      itemId: "p-1:plan",
      text: "1. Read\n2. Change",
    });
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  it("turns TodoWrite and the Task tools into plan updates", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "todo-1", "TodoWrite", {
          todos: [
            { content: "Read", status: "completed" },
            { content: "Write", status: "in_progress" },
          ],
        });
        yield toolResult("todo-1", "ok");
        yield toolUse("m2", "task-1", "TaskCreate", { subject: "Test" });
        yield toolResult("task-1", "ok", { structured: { task: { id: "1", subject: "Test" } } });
        yield toolUse("m3", "task-2", "TaskUpdate", { taskId: "1", status: "completed" });
        yield toolResult("task-2", "ok", { structured: { success: true } });
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind !== "usage")).toEqual([
      {
        kind: "plan.updated",
        steps: [
          { text: "Read", status: "completed" },
          { text: "Write", status: "in_progress" },
        ],
      },
      { kind: "plan.updated", steps: [{ text: "Test", status: "pending" }] },
      { kind: "plan.updated", steps: [{ text: "Test", status: "completed" }] },
    ]);
  });

  it("keeps a subagent's own messages inside its tool call", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-1", "Agent", { description: "Explore", prompt: "look" });
        yield toolUse("sub", "inner", "Read", { file_path: "/x" }, "agent-1");
        yield toolResult("agent-1", "found it");
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind.startsWith("tool."))).toEqual([
      expect.objectContaining({ kind: "tool.started", itemId: "agent-1" }),
      { kind: "tool.completed", itemId: "agent-1", status: "completed", output: "found it" },
    ]);
  });

  it("fails with Claude Code's error", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield result({ is_error: true, api_error_status: 529, result: "API Error: 529" });
      },
    ]);
    await expect(drain(turn)).rejects.toThrow("Claude API is overloaded (529). Try again shortly.");
  });

  it("stops on an interrupt, keeping nothing Claude Code sends afterwards", async () => {
    const { turn, calls } = start([
      async function* (player) {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["1\n", "2\n"]);
        await player.interrupted;
        yield* streamedBlock("m2", 0, "text", ["3\n"]);
        yield result({
          subtype: "error_during_execution",
          errors: [],
          terminal_reason: "aborted_streaming",
        });
      },
    ]);
    const items: AgentItem[] = [];
    for await (const item of turn.items) {
      items.push(item);
      if (item.kind === "message.completed") turn.interrupt();
    }
    expect(calls[0]!.interrupts).toBe(1);
    expect(items.at(-1)).toEqual({ kind: "message.completed", itemId: "m1:0", text: "1\n2\n" });
  });

  it("stops waiting for an approval Claude Code withdraws", async () => {
    const withdrawn = new AbortController();
    let decision: unknown;
    const { turn } = start(
      [
        async function* (player) {
          yield init();
          const asking = player.canUseTool("Bash", { command: "ls" }, "t-1", withdrawn.signal);
          withdrawn.abort();
          decision = await asking;
          yield result();
        },
      ],
      { runtimeMode: "approval-required" },
    );
    const items = await drain(turn);
    expect(items).toContainEqual(expect.objectContaining({ kind: "request.opened" }));
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("cancels an open approval when interrupted", async () => {
    let decision: unknown;
    const { turn } = start(
      [
        async function* (player) {
          yield init();
          decision = await player.canUseTool("Bash", { command: "rm -rf build" }, "t-1");
          await player.interrupted;
          yield result({ terminal_reason: "aborted_tools" });
        },
      ],
      { runtimeMode: "approval-required" },
    );
    for await (const item of turn.items) if (item.kind === "request.opened") turn.interrupt();
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
  });
});

describe("jhin.agent-claude: permission modes", () => {
  it("maps runtime and interaction modes as T3 Code does", () => {
    expect(permissionMode("approval-required", "default")).toBe("default");
    expect(permissionMode("auto-accept-edits", "default")).toBe("acceptEdits");
    expect(permissionMode("full-access", "default")).toBe("bypassPermissions");
    expect(permissionMode("full-access", "plan")).toBe("plan");
  });
});
