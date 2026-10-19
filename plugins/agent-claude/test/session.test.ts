import type { AgentItem, TurnRequest } from "@jhin/agent-api";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createClaudeRuntime, transcript, type Config } from "../src/index.ts";
import {
  drain,
  init,
  memorySessions,
  result,
  scriptedQuery,
  streamedBlock,
  type Script,
} from "./support.ts";

const THREAD = "0b6c5e5e-0000-4000-8000-000000000003";

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

function node(scripts: Script[], config: Config = {}) {
  const scripted = scriptedQuery(...scripts);
  const settings = { config };
  const sessions = memorySessions();
  const claude = createClaudeRuntime({
    query: scripted.query,
    sessions,
    config: () => settings.config,
  });
  let turns = 0;
  const turn = (overrides: Partial<TurnRequest> = {}) =>
    drain(
      claude.startTurn({
        threadId: THREAD,
        turnId: `t${++turns}`,
        input: { text: `turn ${turns}` },
        history: [],
        cwd: "/work",
        model: "claude-haiku-5-5",
        runtimeMode: "approval-required",
        ...overrides,
      }),
    );
  return { claude, turn, settings, sessions, ...scripted };
}

const answers = (items: readonly AgentItem[]) =>
  items.flatMap((item) => (item.kind === "message.completed" ? [item.text] : []));
const prompts = (call: { prompt: { message: { content: unknown } }[] }) =>
  call.prompt.map((sent) => sent.message.content);

afterEach(() => {
  vi.useRealTimers();
});

describe("jhin.agent-claude: live sessions", () => {
  it("keeps a thread's Claude Code running between its turns", async () => {
    const { claude, turn, calls } = node([answering("one", "two")]);
    expect(answers(await turn())).toEqual(["one"]);
    expect(answers(await turn())).toEqual(["two"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ sessionId: THREAD });
    expect(prompts(calls[0]!)).toEqual(["turn 1", "turn 2"]);
    expect(calls[0]!.closed).toBe(false);
    expect(claude.live.list()).toEqual([
      {
        threadId: THREAD,
        model: "claude-haiku-5-5",
        permissionMode: "default",
        busy: false,
        idleSince: expect.any(String),
      },
    ]);
  });

  it("changes the model and the permission mode of the running Claude Code", async () => {
    const { turn, calls } = node([answering("one", "two", "three")]);
    await turn();
    await turn({ model: "claude-sonnet-5-5", runtimeMode: "auto-accept-edits" });
    await turn({ model: "claude-sonnet-5-5", interactionMode: "plan" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.controls).toEqual([
      "model:claude-sonnet-5-5",
      "mode:acceptEdits",
      "mode:plan",
    ]);
  });

  it("puts Claude back in the thread's mode after it switched by itself", async () => {
    const { turn, calls } = node([
      async function* (player) {
        yield init();
        // Claude entered plan mode on its own (EnterPlanMode).
        yield { type: "system", subtype: "status", permissionMode: "plan" } as SDKMessage;
        yield result();
        await player.nextPrompt();
        yield init();
        yield result();
        await player.nextPrompt();
      },
    ]);
    await turn();
    await turn();
    expect(calls[0]!.controls).toEqual(["mode:default"]);
  });

  it("starts Claude Code again, resuming, when full access changes how it is launched", async () => {
    const { turn, calls } = node([answering("one"), answering("two")]);
    await turn();
    expect(answers(await turn({ runtimeMode: "full-access" }))).toEqual(["two"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.closed).toBe(true);
    expect(calls[1]!.options).toMatchObject({
      resume: THREAD,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it("starts Claude Code again, resuming, when it cannot change the model live", async () => {
    const { turn, calls, state } = node([answering("one"), answering("two")]);
    await turn();
    state.refuseControls = true;
    expect(answers(await turn({ model: "claude-opus-5-5" }))).toEqual(["two"]);
    expect(calls[0]!.closed).toBe(true);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD, model: "claude-opus-5-5" });
  });

  it("ends an idle Claude Code after the configured minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { claude, turn, calls } = node([answering("one"), answering("two")], {
      sessionIdleMinutes: 5,
    });
    await turn();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(calls[0]!.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(calls[0]!.closed).toBe(true);
    expect(claude.live.list()).toEqual([]);

    expect(answers(await turn())).toEqual(["two"]);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD });
  });

  it("waits for the next turn without end when the idle minutes are 0", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { turn, calls } = node([answering("one", "two")], { sessionIdleMinutes: 0 });
    await turn();
    vi.advanceTimersByTime(7 * 24 * 60 * 60_000);
    expect(calls[0]!.closed).toBe(false);
    expect(answers(await turn())).toEqual(["two"]);
    expect(calls).toHaveLength(1);
  });

  it("does not end a session while its turn runs, only once it is idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const secondTaken = new Promise<void>((resolve) => (taken = resolve));
    const { turn, calls } = node(
      [
        async function* (player) {
          yield init();
          yield result();
          await player.nextPrompt();
          taken();
          yield init();
          await held;
          yield result();
          await player.nextPrompt();
        },
      ],
      { sessionIdleMinutes: 1 },
    );
    await turn();
    vi.advanceTimersByTime(30_000);
    const second = turn();
    // The second turn took the session: the first one's idle timer is gone.
    await secondTaken;
    vi.advanceTimersByTime(60_000);
    expect(calls[0]!.closed).toBe(false);
    release();
    await second;
    vi.advanceTimersByTime(60_000);
    expect(calls[0]!.closed).toBe(true);
  });

  it("stops a turn on an interrupt and keeps Claude Code for the next", async () => {
    const { claude, calls } = node([
      async function* (player) {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["1\n"]);
        await player.interrupted;
        yield* streamedBlock("m2", 0, "text", ["2\n"]);
        yield result({
          subtype: "error_during_execution",
          errors: [],
          terminal_reason: "aborted_streaming",
        });
        await player.nextPrompt();
        yield init();
        yield* streamedBlock("m3", 0, "text", ["after"]);
        yield result();
        await player.nextPrompt();
      },
    ]);
    const request = {
      threadId: THREAD,
      input: { text: "count" },
      history: [],
      cwd: "/work",
      model: "claude-haiku-5-5",
    };
    const first = claude.startTurn({ ...request, turnId: "t1" });
    const items: AgentItem[] = [];
    for await (const item of first.items) {
      items.push(item);
      if (item.kind === "message.completed") first.interrupt();
    }
    expect(answers(items)).toEqual(["1\n"]);
    expect(calls[0]!.interrupts).toBe(1);

    expect(answers(await drain(claude.startTurn({ ...request, turnId: "t2" })))).toEqual(["after"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.closed).toBe(false);
  });

  it("resumes on the next turn when Claude Code exited while idle", async () => {
    const { claude, turn, calls } = node([
      async function* () {
        yield init();
        yield result();
        // Exits: the process died between turns.
      },
      answering("two"),
    ]);
    await turn();
    await calls[0]!.whenClosed;
    expect(claude.live.list()).toEqual([]);
    expect(answers(await turn())).toEqual(["two"]);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD });
  });

  it("fails a turn whose Claude Code exits mid-turn and resumes on the next", async () => {
    const { turn, calls } = node([
      async function* () {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["Half"]);
      },
      answering("two"),
    ]);
    await expect(turn()).rejects.toThrow("Claude Code ended the turn without a result.");
    expect(answers(await turn())).toEqual(["two"]);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD });
  });

  it("ends Claude Code after each turn with the per-turn setting", async () => {
    const { claude, turn, calls } = node([answering("one"), answering("two")], {
      session: "per-turn",
    });
    await turn();
    expect(calls[0]!.closed).toBe(true);
    expect(claude.live.list()).toEqual([]);
    expect(answers(await turn())).toEqual(["two"]);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD });
    expect(calls[1]!.closed).toBe(true);
  });

  it("ends the running Claude Code when the setting turns to per-turn", async () => {
    const { turn, calls, settings } = node([answering("one", "two"), answering("three")]);
    await turn();
    settings.config = { session: "per-turn" };
    // The kept session serves the turn, then ends with it.
    expect(answers(await turn())).toEqual(["two"]);
    expect(calls[0]!.closed).toBe(true);
  });

  it("ends every live session when the runtime is disposed", async () => {
    const { claude, turn, calls } = node([answering("one")]);
    await turn();
    claude.dispose();
    expect(calls[0]!.closed).toBe(true);
    expect(claude.live.list()).toEqual([]);
  });
});

describe("jhin.agent-claude: turns Claude missed", () => {
  const history = [
    {
      type: "agent.turn.started",
      payload: { turnId: "a", agentId: "jhin.agent-claude", input: { text: "to claude" } },
    },
    {
      type: "agent.item.completed",
      payload: { turnId: "a", kind: "message", text: "from claude" },
    },
    {
      type: "agent.turn.started",
      payload: { turnId: "b", agentId: "jhin.agent-fake", input: { text: "to fake" } },
    },
    { type: "agent.item.completed", payload: { turnId: "b", kind: "message", text: "from fake" } },
  ] as unknown as StoredEvent[];

  it("hands Claude the turns another agent ran since its last one", async () => {
    const { turn, calls, sessions } = node([answering("back")]);
    sessions.ids.add(THREAD);
    await turn({ history, input: { text: "and now?" } });
    const prompt = prompts(calls[0]!)[0] as string;
    expect(prompt).toContain("Since your last turn this thread went on with another agent.");
    expect(prompt).toContain("User: to fake\nAssistant: from fake");
    expect(prompt).not.toContain("from claude");
    expect(prompt.endsWith("and now?")).toBe(true);
  });

  it("hands nothing when Claude ran the thread's last turn", () => {
    expect(transcript(history.slice(0, 2), "jhin.agent-claude")).toBeUndefined();
    expect(transcript(history, "jhin.agent-claude")).toContain("User: to fake");
  });
});
