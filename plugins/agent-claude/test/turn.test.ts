import type { AgentItem, TurnRequest } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { claudeTurn, permissionMode, transcript } from "../src/turn.ts";
import {
  drain,
  init,
  memorySessions,
  result,
  system,
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
      // Started in default and switched before the message, so the SDK does not warn (D343).
      permissionMode: "default",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    });
    expect(calls[0]!.controls).toEqual(["mode:bypassPermissions"]);
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.prompt[0]!.message.content).toBe("hello");
    expect(calls[0]!.closed).toBe(true);
    expect(sessions.ids.has(THREAD)).toBe(true);
  });

  it("says when Claude Code compacted the conversation (agents.md D709)", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 180_000 },
          uuid: "c1",
          session_id: THREAD,
        } as never;
        yield* streamedBlock("m1", 0, "text", ["Going on."]);
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind === "context.compacted")).toEqual([
      { kind: "context.compacted", trigger: "auto" },
    ]);
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

  it("keeps two blocks of one API message with the same text as two items (D342)", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["Done."]);
        yield* streamedBlock("m1", 1, "text", ["Done."], { start: false, snapshotLast: true });
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind === "message.completed")).toEqual([
      { kind: "message.completed", itemId: "m1:0", text: "Done." },
      { kind: "message.completed", itemId: "m1:1", text: "Done." },
    ]);
  });

  it("keeps two identical snapshots of one API message apart when nothing streamed", async () => {
    const snapshot = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", content: [{ type: "text", text: "Same" }] },
    } as never;
    const { turn } = start([
      async function* () {
        yield init();
        yield snapshot;
        yield snapshot;
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind === "message.completed")).toEqual([
      { kind: "message.completed", itemId: "m1:s0", text: "Same" },
      { kind: "message.completed", itemId: "m1:s1", text: "Same" },
    ]);
  });

  it("sends images and says which attachments Claude Code cannot take", async () => {
    const logged: unknown[] = [];
    const { query, calls } = scriptedQuery(async function* () {
      yield init();
      yield result();
    });
    const turn = claudeTurn(
      request({
        input: {
          text: "look",
          attachments: [
            {
              kind: "image",
              name: "a.png",
              mimeType: "image/png",
              dataUrl: "data:image/png;base64,AAAA",
            },
            {
              kind: "image",
              name: "b.bmp",
              mimeType: "image/bmp",
              dataUrl: "data:image/bmp;base64,BBBB",
            },
          ],
        },
      }),
      {
        query,
        sessions: memorySessions(),
        settings: {},
        defaultModel: "claude-fable-5-1",
        log: (message, data) => logged.push([message, data]),
      },
    );
    await drain(turn);
    expect(calls[0]!.prompt[0]!.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "look" },
    ]);
    expect(logged).toEqual([
      ["claude takes no such attachment, skipped", { name: "b.bmp", mimeType: "image/bmp" }],
    ]);
  });

  it("sends uploaded images as blocks and names every attachment's file after the text", async () => {
    const { turn, calls } = start(
      [
        async function* () {
          yield init();
          yield result();
        },
      ],
      {
        input: {
          text: "look",
          attachments: [
            {
              kind: "image",
              id: "att-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 3,
              read: async () => new Uint8Array([1, 2, 3]),
              path: "/data/blobs/thread/t1/att-1.png",
            },
            {
              kind: "file",
              id: "att-2",
              name: "notes.md",
              mimeType: "text/markdown",
              sizeBytes: 5,
              read: async () => new Uint8Array(),
              path: "/data/blobs/thread/t1/att-2.md",
            },
          ],
        },
      },
    );
    await drain(turn);
    expect(calls[0]!.prompt[0]!.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      {
        type: "text",
        text: 'look\n\n[Attached image "shot.png" is saved at: /data/blobs/thread/t1/att-1.png]\n\n[Attached file "notes.md" is saved at: /data/blobs/thread/t1/att-2.md]',
      },
    ]);
    // Claude may read them where the node keeps them.
    expect(calls[0]!.options.additionalDirectories).toEqual(["/data/blobs/thread/t1"]);
  });

  it("sends a $skill as /skill at the start of the message's last block", async () => {
    const { query, calls } = scriptedQuery(async function* () {
      yield init();
      yield result();
    });
    const turn = claudeTurn(request({ input: { text: "ship it with $deploy now" } }), {
      query,
      sessions: memorySessions(),
      settings: {},
      defaultModel: "claude-fable-5-1",
      skills: async () => new Set(["deploy"]),
    });
    await drain(turn);
    expect(calls[0]!.prompt[0]!.message.content).toEqual([
      { type: "text", text: "ship it with" },
      { type: "text", text: "/deploy now" },
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
    const lookup = sessions.get;
    sessions.get = async (threadId) => {
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

  it("appends a defined agent's instructions to the system prompt (D605)", async () => {
    const { turn, calls } = start(
      [
        async function* () {
          yield init();
          yield result();
        },
      ],
      { instructions: "You are Builder." },
    );
    await drain(turn);
    const prompt = calls[0]!.options.systemPrompt as { append: string };
    expect(prompt.append.endsWith("\n\nYou are Builder.")).toBe(true);
  });

  it("counts a defined agent's turns as its runtime's (D610)", () => {
    const history = [
      {
        type: "agent.turn.started",
        payload: {
          turnId: "a",
          agentId: "builder",
          runtimeId: "jhin.agent-claude",
          input: { text: "q" },
        },
      },
      { type: "agent.item.completed", payload: { turnId: "a", kind: "message", text: "a" } },
    ] as unknown as StoredEvent[];
    expect(transcript(history, "jhin.agent-claude")).toBeUndefined();
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
      kind: "plan.proposed",
      itemId: "p-1:plan",
      markdown: "1. Read\n2. Change",
    });
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  it("runs with the turn's model options: effort, settings, the model id and Ultrathink", async () => {
    const script = async function* () {
      yield init();
      yield result();
    };
    const { turn, calls } = start([script], {
      model: "claude-opus-5-5",
      modelOptions: [
        { id: "effort", value: "ultracode" },
        { id: "fastMode", value: true },
      ],
    });
    await drain(turn);
    expect(calls[0]!.options).toMatchObject({
      model: "claude-opus-5-5",
      effort: "xhigh",
      settings: { fastMode: true, ultracode: true },
      thinking: { type: "adaptive", display: "summarized" },
    });

    const thinking = start([script], {
      model: "claude-fable-5-1",
      modelOptions: [{ id: "effort", value: "ultrathink" }],
      input: { text: "fix it" },
    });
    await drain(thinking.turn);
    expect(thinking.calls[0]!.options.effort).toBeUndefined();
    expect(thinking.calls[0]!.options.settings).toBeUndefined();
    expect(thinking.calls[0]!.prompt[0]!.message.content).toBe("Ultrathink:\nfix it");
  });

  it("asks before a change in plan mode even with full access", async () => {
    let decision: unknown;
    const { turn } = start(
      [
        async function* (player) {
          yield init();
          decision = await player.canUseTool("Write", { file_path: "/work/a.txt" }, "w-1");
          yield result();
        },
      ],
      { runtimeMode: "full-access", interactionMode: "plan" },
    );
    const items = await drain(turn, () => ({ kind: "approval", decision: "decline" }));
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "request.opened", requestId: "w-1:approval" }),
    );
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

  it("shows a subagent's own work as its items, apart from the turn's (D878)", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-1", "Agent", { description: "Explore", prompt: "look" });
        yield toolUse("sub", "inner", "Read", { file_path: "/x" }, "agent-1");
        yield toolResult("inner", "contents", { parent: "agent-1" });
        // The subagent's own subagent: its call shows in the subagent, its messages nowhere.
        yield toolUse(
          "sub2",
          "nested",
          "Agent",
          { description: "Deeper", prompt: "dig" },
          "agent-1",
        );
        yield toolUse("deep", "deep-read", "Read", { file_path: "/y" }, "nested");
        yield toolResult("agent-1", "found it");
        yield result();
      },
    ]);
    const items = await drain(turn);
    // The turn's own tool calls: the Agent call and its result.
    expect(items.filter((item) => item.kind.startsWith("tool."))).toEqual([
      expect.objectContaining({ kind: "tool.started", itemId: "agent-1" }),
      { kind: "tool.completed", itemId: "agent-1", status: "completed", output: "found it" },
    ]);
    expect(items.filter((item) => item.kind.startsWith("subagent."))).toEqual([
      { kind: "subagent.started", subagentId: "agent-1", title: "Explore", prompt: "look" },
      {
        kind: "subagent.item",
        subagentId: "agent-1",
        item: expect.objectContaining({ kind: "tool.started", itemId: "inner" }),
      },
      {
        kind: "subagent.item",
        subagentId: "agent-1",
        item: { kind: "tool.completed", itemId: "inner", status: "completed", output: "contents" },
      },
      {
        kind: "subagent.item",
        subagentId: "agent-1",
        item: expect.objectContaining({ kind: "tool.started", itemId: "nested" }),
      },
      { kind: "subagent.ended", subagentId: "agent-1", status: "completed" },
    ]);
  });

  it("hands its subagents in the background over to afterwards, until each ended (D1165)", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-bg", "Agent", {
          description: "Dig",
          prompt: "dig",
          run_in_background: true,
        });
        yield system("task_started", {
          task_id: "task-1",
          tool_use_id: "agent-bg",
          description: "Dig",
          is_backgrounded: true,
        });
        // Its background work keeps the per-turn session (D348).
        yield system("background_tasks_changed", { tasks: [{ task_id: "task-1" }] });
        yield toolResult("agent-bg", "Async agent launched");
        // A foreground one Claude Code moved to the background (D805).
        yield toolUse("m2", "agent-fg", "Agent", { description: "Look", prompt: "look" });
        yield system("task_started", { task_id: "task-2", tool_use_id: "agent-fg" });
        // Its progress, found by its task (D1343); an empty one or another task's says nothing.
        yield system("task_progress", { task_id: "task-2", description: " Looking around " });
        yield system("task_progress", { task_id: "task-2", description: "  " });
        yield system("task_progress", { task_id: "task-9", description: "Elsewhere" });
        yield system("task_updated", { task_id: "task-2", patch: { is_backgrounded: true } });
        yield toolResult("agent-fg", "Running in the background");
        yield result();
        // After the turn: their own work, their progress and their ends.
        yield toolUse("sub", "inner", "Read", { file_path: "/x" }, "agent-bg");
        yield system("task_progress", {
          task_id: "task-1",
          tool_use_id: "agent-bg",
          description: "Digging",
        });
        yield system("task_notification", {
          task_id: "task-1",
          tool_use_id: "agent-bg",
          status: "completed",
          summary: "dug",
          output_file: "",
        });
        yield system("task_notification", {
          task_id: "task-2",
          status: "failed",
          summary: "broke",
          output_file: "",
        });
        yield system("background_tasks_changed", { tasks: [] });
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind.startsWith("subagent."))).toEqual([
      { kind: "subagent.started", subagentId: "agent-bg", title: "Dig", prompt: "dig" },
      { kind: "subagent.backgrounded", subagentId: "agent-bg" },
      { kind: "subagent.started", subagentId: "agent-fg", title: "Look", prompt: "look" },
      { kind: "subagent.progress", subagentId: "agent-fg", progress: "Looking around" },
      { kind: "subagent.backgrounded", subagentId: "agent-fg" },
    ]);
    // Their calls' quick results end the calls, not the subagents.
    expect(items.filter((item) => item.kind === "tool.completed")).toHaveLength(2);
    const afterwards = [];
    for await (const item of turn.afterwards!) afterwards.push(item);
    expect(afterwards).toEqual([
      {
        kind: "subagent.item",
        subagentId: "agent-bg",
        item: expect.objectContaining({ kind: "tool.started", itemId: "inner" }),
      },
      { kind: "subagent.progress", subagentId: "agent-bg", progress: "Digging" },
      { kind: "subagent.ended", subagentId: "agent-bg", status: "completed" },
      { kind: "subagent.ended", subagentId: "agent-fg", status: "failed", error: "broke" },
    ]);
  });

  it("reads a background subagent's frames once each, before and after the turn's result", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-bg", "Agent", {
          description: "Dig",
          prompt: "dig",
          run_in_background: true,
        });
        yield system("background_tasks_changed", { tasks: [{ task_id: "task-1" }] });
        yield toolResult("agent-bg", "Async agent launched");
        // Its work while the turn still runs goes with the turn's items…
        yield toolUse("sub1", "read-1", "Read", { file_path: "/a" }, "agent-bg");
        yield result();
        // …and after the result to afterwards, each frame once.
        yield toolUse("sub2", "read-2", "Read", { file_path: "/b" }, "agent-bg");
        yield system("task_notification", {
          task_id: "task-1",
          tool_use_id: "agent-bg",
          status: "stopped",
          summary: "",
          output_file: "",
        });
        yield system("background_tasks_changed", { tasks: [] });
      },
    ]);
    const items = await drain(turn);
    const reads = (list: readonly AgentItem[]) =>
      list.flatMap((item) =>
        item.kind === "subagent.item" && item.item.kind === "tool.started"
          ? [item.item.itemId]
          : [],
      );
    expect(reads(items)).toEqual(["read-1"]);
    const afterwards: AgentItem[] = [];
    for await (const item of turn.afterwards!) afterwards.push(item);
    expect(reads(afterwards)).toEqual(["read-2"]);
    expect(afterwards.at(-1)).toEqual({
      kind: "subagent.ended",
      subagentId: "agent-bg",
      status: "interrupted",
    });
  });

  it("ends afterwards when Claude Code exits while a subagent works in the background", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-bg", "Agent", {
          description: "Dig",
          prompt: "dig",
          run_in_background: true,
        });
        yield system("background_tasks_changed", { tasks: [{ task_id: "task-1" }] });
        yield toolResult("agent-bg", "Async agent launched");
        yield result();
        yield toolUse("sub", "read-1", "Read", { file_path: "/a" }, "agent-bg");
        // Claude Code exits: no notification ever comes.
      },
    ]);
    await drain(turn);
    const afterwards: AgentItem[] = [];
    for await (const item of turn.afterwards!) afterwards.push(item);
    // Its thread is ended as interrupted by whoever reads it (the threads plugin, D1164).
    expect(afterwards.map((item) => item.kind)).toEqual(["subagent.item"]);
  });

  it("lets go of the session when afterwards is left early", async () => {
    let more!: () => void;
    const unblocked = new Promise<void>((resolve) => (more = resolve));
    const { turn, calls } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-bg", "Agent", {
          description: "Dig",
          prompt: "dig",
          run_in_background: true,
        });
        yield system("background_tasks_changed", { tasks: [{ task_id: "task-1" }] });
        yield toolResult("agent-bg", "Async agent launched");
        yield result();
        yield toolUse("sub", "read-1", "Read", { file_path: "/a" }, "agent-bg");
        await unblocked;
        yield toolUse("sub2", "read-2", "Read", { file_path: "/b" }, "agent-bg");
        yield system("background_tasks_changed", { tasks: [] });
      },
    ]);
    await drain(turn);
    for await (const item of turn.afterwards!) {
      expect(item.kind).toBe("subagent.item");
      break;
    }
    // Later frames reach no reader, and the session ends once its work does.
    more();
    await calls[0]!.whenClosed;
  });

  it("does not move a subagent whose call already returned to the background", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield toolUse("m1", "agent-1", "Agent", { description: "Look", prompt: "look" });
        yield system("task_started", { task_id: "task-1", tool_use_id: "agent-1" });
        yield toolResult("agent-1", "found it");
        // A late move (a steer's Ctrl+B that came after the result) changes nothing.
        yield system("task_updated", { task_id: "task-1", patch: { is_backgrounded: true } });
        yield result();
      },
    ]);
    const items = await drain(turn);
    expect(items.filter((item) => item.kind.startsWith("subagent."))).toEqual([
      { kind: "subagent.started", subagentId: "agent-1", title: "Look", prompt: "look" },
      { kind: "subagent.ended", subagentId: "agent-1", status: "completed" },
    ]);
    const afterwards = [];
    for await (const item of turn.afterwards!) afterwards.push(item);
    expect(afterwards).toEqual([]);
  });

  it("ends afterwards at once when no subagent went to the background", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield result();
      },
    ]);
    await drain(turn);
    const afterwards = [];
    for await (const item of turn.afterwards!) afterwards.push(item);
    expect(afterwards).toEqual([]);
  });

  it("fails when Claude Code ends the turn without a result", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["Half"]);
      },
    ]);
    await expect(drain(turn)).rejects.toThrow("Claude Code ended the turn without a result.");
  });

  it("fails a turn Claude Code aborts on its own", async () => {
    const { turn } = start([
      async function* () {
        yield init();
        yield result({
          subtype: "error_during_execution",
          errors: ["Request interrupted by hook"],
        });
      },
    ]);
    await expect(drain(turn)).rejects.toThrow("Request interrupted by hook");
  });

  it("keeps a turn going when its session cannot be recorded", async () => {
    const sessions = memorySessions();
    sessions.set = async () => {
      throw new Error("disk full");
    };
    const { turn } = start(
      [
        async function* () {
          yield init();
          yield* streamedBlock("m1", 0, "text", ["fine"]);
          yield result();
        },
      ],
      {},
      sessions,
    );
    expect(await drain(turn)).toContainEqual({
      kind: "message.completed",
      itemId: "m1:0",
      text: "fine",
    });
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
