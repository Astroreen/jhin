import type { AgentItem, TurnRequest } from "@jhin/agent-api";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { z } from "@jhin/sdk";
import { createMemoryStorage } from "@jhin/storage-api";

import {
  BackgroundWorkRunning,
  createClaudeRuntime,
  createLiveSessions,
  SessionTakenOver,
  sessionRecords,
  transcript,
  Config,
  type QueryFunction,
} from "../src/index.ts";
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

function node(scripts: Script[], config: z.input<typeof Config> = {}) {
  const scripted = scriptedQuery(...scripts);
  const settings = { config: Config.parse(config) };
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
        background: 0,
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
      permissionMode: "default",
      allowDangerouslySkipPermissions: true,
    });
    expect(calls[1]!.controls).toEqual(["mode:bypassPermissions"]);
  });

  it("starts Claude Code in full access directly when it refuses the switch (D343)", async () => {
    const { claude, turn, calls, state } = node([answering("one"), answering("two")]);
    state.refuseControls = true;
    expect(answers(await turn({ runtimeMode: "full-access" }))).toEqual(["two"]);
    expect(calls[0]!.closed).toBe(true);
    expect(calls[0]!.prompt).toEqual([]);
    expect(calls[1]!.options).toMatchObject({ permissionMode: "bypassPermissions" });
    expect(claude.live.list()).toMatchObject([{ permissionMode: "bypassPermissions" }]);
  });

  it("starts Claude Code again, resuming, when it cannot change the model live", async () => {
    const { turn, calls, state } = node([answering("one"), answering("two")]);
    await turn();
    state.refuseControls = true;
    expect(answers(await turn({ model: "claude-opus-5-5" }))).toEqual(["two"]);
    expect(calls[0]!.closed).toBe(true);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD, model: "claude-opus-5-5" });
  });

  it("counts a changed idle time from the last turn of sessions already idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { claude, turn, calls, settings } = node([answering("one"), answering("two")], {
      sessionIdleMinutes: 10,
    });
    await turn();
    vi.advanceTimersByTime(3 * 60_000);
    // Shorter: 5 minutes from the last turn, of which 3 have passed.
    settings.config = Config.parse({ sessionIdleMinutes: 5 });
    claude.live.rearmIdle();
    vi.advanceTimersByTime(2 * 60_000 - 1);
    expect(calls[0]!.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(calls[0]!.closed).toBe(true);

    await turn();
    // Longer: the old 5 minutes no longer end it.
    settings.config = Config.parse({ sessionIdleMinutes: 20 });
    claude.live.rearmIdle();
    vi.advanceTimersByTime(19 * 60_000);
    expect(calls[1]!.closed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(calls[1]!.closed).toBe(true);
  });

  it("keys a session on the configured environment, not the node's", async () => {
    const { turn, calls, settings } = node([answering("one", "two"), answering("three")]);
    await turn();
    expect(calls[0]!.options.env).toMatchObject({
      PATH: process.env["PATH"],
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    });
    // The node's environment passes through: a change to it keeps the running Claude Code.
    process.env["JHIN_TEST_LAUNCH_KEY"] = "changed";
    try {
      expect(answers(await turn())).toEqual(["two"]);
    } finally {
      delete process.env["JHIN_TEST_LAUNCH_KEY"];
    }
    expect(calls).toHaveLength(1);
    // The config's `env` is part of the launch key: another one starts Claude Code again.
    settings.config = Config.parse({ env: { CLAUDE_CONFIG_DIR: "/other" } });
    expect(answers(await turn())).toEqual(["three"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options).toMatchObject({
      resume: THREAD,
      env: { CLAUDE_CONFIG_DIR: "/other", PATH: process.env["PATH"] },
    });
  });

  it("passes only the node's variables the allow-list names (D346)", async () => {
    process.env["JHIN_TEST_NODE_ONLY"] = "secret";
    process.env["JHIN_TEST_LC_ONE"] = "one";
    try {
      const { turn, calls, settings } = node([answering("one", "two"), answering("three")], {
        inheritEnv: ["PATH", "JHIN_TEST_LC_*"],
        env: { EXTRA: "from config" },
      });
      await turn();
      expect(calls[0]!.options.env).toEqual({
        PATH: process.env["PATH"],
        JHIN_TEST_LC_ONE: "one",
        EXTRA: "from config",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      });
      // The default passes every variable, as before the list.
      settings.config = Config.parse({ env: { EXTRA: "from config" } });
      await turn();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.options.env).toMatchObject({ JHIN_TEST_NODE_ONLY: "secret" });
    } finally {
      delete process.env["JHIN_TEST_NODE_ONLY"];
      delete process.env["JHIN_TEST_LC_ONE"];
    }
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

  it("waits out an idle time longer than a timer can, then ends the session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const limit = 2 ** 31 - 1;
    // 50 000 minutes, about 34.7 days: more than one setTimeout can wait (about 24.8 days).
    const { turn, calls } = node([answering("one")], { sessionIdleMinutes: 50_000 });
    const idleMs = 50_000 * 60_000;
    await turn();
    vi.advanceTimersByTime(limit);
    expect(calls[0]!.closed).toBe(false);
    vi.advanceTimersByTime(idleMs - limit - 1);
    expect(calls[0]!.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(calls[0]!.closed).toBe(true);
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
    settings.config = Config.parse({ session: "per-turn" });
    // The kept session serves the turn, then ends with it.
    expect(answers(await turn())).toEqual(["two"]);
    expect(calls[0]!.closed).toBe(true);
  });

  it("gives a turn waiting for setModel up when a later turn takes Claude Code", async () => {
    const { query, calls } = scriptedQuery(answering("one"), answering(), answering());
    const live = createLiveSessions({
      query,
      keepAlive: () => ({ keepAlive: true, idleMs: 0 }),
    });
    const lease = (model: string) =>
      live.lease({
        threadId: THREAD,
        options: { model, permissionMode: "default" },
        message: {
          type: "user",
          message: { role: "user", content: model },
          parent_tool_use_id: null,
        },
      });
    const first = await lease("a");
    for await (const _ of first.messages) {
      // Reads the first turn to its result.
    }
    first.release(true);
    // The first waits for setModel on the kept session; the second takes it meanwhile.
    const [waiting, later] = await Promise.allSettled([lease("b"), lease("a")]);
    expect(waiting).toMatchObject({ status: "rejected", reason: expect.any(SessionTakenOver) });
    expect(later.status).toBe("fulfilled");
    if (later.status === "fulfilled") later.value.release(true);

    // One Claude Code, the later turn's, and none out of reach.
    const running = calls.filter((call) => !call.closed);
    expect(running).toHaveLength(1);
    expect(live.list()).toHaveLength(1);
    live.dispose();
    expect(calls.every((call) => call.closed)).toBe(true);
  });

  it("lets a newer turn take Claude Code from a turn still holding it", async () => {
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const { claude, calls, sessions } = node([
      // A turn that ignores its interrupt: the threads plugin gives up on it and frees the
      // thread, so the next turn comes while this one still holds Claude Code.
      async function* () {
        yield init();
        holding();
        await new Promise(() => undefined);
      },
      answering("two"),
    ]);
    sessions.ids.add(THREAD);
    const request = {
      threadId: THREAD,
      input: { text: "hi" },
      history: [],
      cwd: "/work",
      model: "claude-haiku-5-5",
    };
    const stuck = drain(claude.startTurn({ ...request, turnId: "t1" }));
    await held;
    const next = drain(claude.startTurn({ ...request, turnId: "t2" }));
    await expect(stuck).rejects.toThrow("A later turn of this thread took its Claude Code over.");
    expect(answers(await next)).toEqual(["two"]);
    expect(calls[0]!.closed).toBe(true);
    expect(calls[1]!.options).toMatchObject({ resume: THREAD });
  });

  it("ends every live session when the runtime is disposed", async () => {
    const { claude, turn, calls } = node([answering("one")]);
    await turn();
    claude.dispose();
    expect(calls[0]!.closed).toBe(true);
    expect(claude.live.list()).toEqual([]);
  });
});

/** A frame marked as answering the message `uuid`, as Claude Code marks a turn's frames. */
const answeringUuid = (uuid: string | undefined, message: SDKMessage) =>
  ({ ...message, user_message_uuid: uuid, user_message_uuids: [uuid] }) as SDKMessage;
/** Claude Code's running and idle reports (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`). */
const state = (value: "running" | "idle") =>
  ({ type: "system", subtype: "session_state_changed", state: value }) as SDKMessage;

describe("jhin.agent-claude: frames of other turns", () => {
  it("does not hand a turn what Claude Code ran by itself before it", async () => {
    const { turn } = node([
      async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield state("running");
        yield answeringUuid(first, init());
        yield* streamedBlock("m1", 0, "text", ["one"]);
        yield answeringUuid(first, result());
        yield state("idle");
        const second = (await player.nextPrompt())?.uuid;
        // A background shell finished: Claude Code continues on its own, marking nothing,
        // and takes the waiting message right after, without going idle in between.
        yield state("running");
        yield init();
        yield* streamedBlock("bg", 0, "text", ["background done"]);
        yield result();
        yield answeringUuid(second, init());
        yield* streamedBlock("m2", 0, "text", ["two"]);
        yield answeringUuid(second, result());
        yield state("idle");
        const third = (await player.nextPrompt())?.uuid;
        yield state("running");
        yield answeringUuid(third, init());
        yield* streamedBlock("m3", 0, "text", ["three"]);
        yield answeringUuid(third, result());
        yield state("idle");
        await player.nextPrompt();
      },
    ]);
    expect(answers(await turn())).toEqual(["one"]);
    expect(answers(await turn())).toEqual(["two"]);
    expect(answers(await turn())).toEqual(["three"]);
  });

  it("ends a turn whose frames Claude Code does not mark once it goes idle", async () => {
    const { turn } = node([
      async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield state("running");
        yield answeringUuid(first, init());
        yield answeringUuid(first, result());
        yield state("idle");
        await player.nextPrompt();
        // The session marks frames, but none of this message's (a rewritten uuid).
        yield state("running");
        yield init();
        yield* streamedBlock("m2", 0, "text", ["two"]);
        yield result();
        yield state("idle");
        await player.nextPrompt();
        // Taken, and never answered.
        yield state("running");
        yield state("idle");
        await player.nextPrompt();
      },
    ]);
    await turn();
    expect(answers(await turn())).toEqual(["two"]);
    await expect(turn()).rejects.toThrow(
      "Claude Code finished without answering the turn's message.",
    );
  });

  it("takes an unmarked result when Claude Code reports no idle", async () => {
    const { turn } = node([
      async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield answeringUuid(first, init());
        yield answeringUuid(first, result());
        await player.nextPrompt();
        yield init();
        yield* streamedBlock("m2", 0, "text", ["two"]);
        yield result({ is_error: true, api_error_status: 529, result: "overloaded" });
        await player.nextPrompt();
      },
    ]);
    await turn();
    await expect(turn()).rejects.toThrow("Claude API is overloaded (529).");
  });

  it("ends a stopped turn whose frames never come marked", async () => {
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const { claude, calls } = node([
      async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield state("running");
        yield answeringUuid(first, init());
        yield answeringUuid(first, result());
        yield state("idle");
        await player.nextPrompt();
        // Nothing of the second message comes marked; the stop is answered with idle.
        yield state("running");
        holding();
        await player.interrupted;
        yield state("idle");
        await player.nextPrompt();
      },
    ]);
    const request = { threadId: THREAD, input: { text: "hi" }, history: [], cwd: "/work" };
    await drain(claude.startTurn({ ...request, turnId: "t1" }));
    const stopped = claude.startTurn({ ...request, turnId: "t2" });
    const items: AgentItem[] = [];
    const reading = (async () => {
      for await (const item of stopped.items) items.push(item);
    })();
    await held;
    stopped.interrupt();
    await reading;
    expect(items).toEqual([]);
    expect(calls[0]!.closed).toBe(false);
  });

  it("drops the late result of a message an interrupt did not stop", async () => {
    const { claude, calls } = node([
      async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield answeringUuid(first, init());
        yield* streamedBlock("m1", 0, "text", ["1\n"]);
        await player.interrupted;
        yield answeringUuid(
          first,
          result({
            subtype: "error_during_execution",
            errors: [],
            terminal_reason: "aborted_streaming",
          }),
        );
        const second = (await player.nextPrompt())?.uuid;
        // The interrupted message still ran, and ends with a result of its own.
        yield answeringUuid(first, init());
        yield* streamedBlock("late", 0, "text", ["late"]);
        yield answeringUuid(first, result());
        yield answeringUuid(second, init());
        yield* streamedBlock("m2", 0, "text", ["two"]);
        yield answeringUuid(second, result());
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
    for await (const item of first.items) if (item.kind === "message.completed") first.interrupt();
    expect(answers(await drain(claude.startTurn({ ...request, turnId: "t2" })))).toEqual(["two"]);
    expect(calls).toHaveLength(1);
  });

  it("gives every message of a turn a uuid of its own", async () => {
    const { turn, calls } = node([answering("one", "two")]);
    await turn();
    await turn();
    const [first, second] = calls[0]!.prompt.map((sent) => sent.uuid);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
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

  it("replays nothing into a session whose turns are not in the history", async () => {
    // The record was written on init and that turn failed: the session holds what Claude
    // saw, the history has no turn of Claude's to count from.
    expect(transcript(history.slice(2), "jhin.agent-claude")).toBeUndefined();
    const { turn, calls, sessions } = node([answering("back")]);
    sessions.ids.add(THREAD);
    await turn({ history: history.slice(2), input: { text: "and now?" } });
    expect(prompts(calls[0]!)).toEqual(["and now?"]);
  });
});

describe("jhin.agent-claude: session records", () => {
  it("never records a deleted thread's session again while its turns run", async () => {
    const records = sessionRecords(createMemoryStorage().kv);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    await records.set(THREAD);
    // A turn still letting go of its session writes after the thread was deleted.
    await records.forget(THREAD, settled);
    await records.set(THREAD);
    expect(await records.has(THREAD)).toBe(false);
    await records.set("another");
    expect(await records.has("another")).toBe(true);
    // Its turns are done: the guard is dropped, nothing is left to write.
    settle();
    await settled;
    await records.forget("another");
    await records.set(THREAD);
    expect(await records.has(THREAD)).toBe(true);
  });

  it("deletes after a write already on its way", async () => {
    const storage = createMemoryStorage().kv;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const set = storage.set.bind(storage);
    let writing!: () => void;
    const started = new Promise<void>((resolve) => (writing = resolve));
    // A set that has passed every check and is still writing when the thread is deleted.
    const kv = {
      ...storage,
      get: storage.get.bind(storage),
      delete: storage.delete.bind(storage),
      set: async (...args: Parameters<typeof storage.set>) => {
        writing();
        await held;
        return set(...args);
      },
    };
    const records = sessionRecords(kv);
    const inFlight = records.set(THREAD);
    await started;
    const forgotten = records.forget(THREAD, new Promise(() => undefined));
    // One turn of the event loop: a delete that does not wait for the write has run by now.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([inFlight, forgotten]);
    expect(await records.has(THREAD)).toBe(false);
  });
});

describe("jhin.agent-claude: session files (D345)", () => {
  it("waits for every Claude Code of the thread to exit, also one a later launch replaced", async () => {
    let exitFirst!: () => void;
    const firstExited = new Promise<void>((resolve) => (exitFirst = resolve));
    let launches = 0;
    // The first Claude Code goes on writing (its output open) after it was asked to close.
    const query = (({ prompt }: Parameters<QueryFunction>[0]) => {
      const lingering = launches++ === 0;
      let closed!: () => void;
      const whenClosed = new Promise<void>((resolve) => (closed = resolve));
      return {
        async *[Symbol.asyncIterator]() {
          for await (const _sent of prompt) {
            yield init();
            yield result();
          }
          await (lingering ? firstExited : whenClosed);
        },
        interrupt: async () => undefined,
        close: () => closed(),
      };
    }) as unknown as QueryFunction;
    const live = createLiveSessions({ query, keepAlive: () => ({ keepAlive: true, idleMs: 0 }) });
    const lease = async (cwd: string) => {
      const held = await live.lease({
        threadId: THREAD,
        options: { cwd },
        message: {
          type: "user",
          message: { role: "user", content: "hi" },
          parent_tool_use_id: null,
        },
      });
      for await (const _message of held.messages);
      held.release(true);
    };
    await lease("/a");
    await lease("/b");
    live.close(THREAD);
    const order: string[] = [];
    const ended = live.ended(THREAD).then(() => order.push("ended"));
    await new Promise((resolve) => setImmediate(resolve));
    order.push("first exits");
    exitFirst();
    await ended;
    expect(order).toEqual(["first exits", "ended"]);
  });
});

/** Claude Code's level of background tasks (`background_tasks_changed`). */
const backgroundTasks = (...tasks: { task_id: string; ambient?: boolean }[]) =>
  ({ type: "system", subtype: "background_tasks_changed", tasks }) as unknown as SDKMessage;

/** Claude Code that answers, starts a background task, and ends it when `done` resolves. */
function workingInBackground(done: Promise<void>, ...answers: string[]): Script {
  return async function* (player) {
    yield init();
    // Started during the turn, as a `run_in_background` shell is.
    yield backgroundTasks({ task_id: "shell-1" }, { task_id: "watcher", ambient: true });
    yield* streamedBlock("m0", 0, "text", [answers[0] ?? "one"]);
    yield result();
    const next = player.nextPrompt();
    await Promise.race([done, next]);
    yield backgroundTasks({ task_id: "watcher", ambient: true });
    for (const answer of answers.slice(1)) {
      if ((await next) === undefined) return;
      yield init();
      yield* streamedBlock("m1", 0, "text", [answer]);
      yield result();
    }
    await player.nextPrompt();
  };
}

describe("jhin.agent-claude: W9 live sessions", () => {
  it("ends the idle sessions that waited longest past the cap (D347)", async () => {
    const { turn, calls, claude } = node([answering("a"), answering("b"), answering("c")], {
      maxLiveSessions: 2,
    });
    const other = (n: number) => `0b6c5e5e-0000-4000-8000-00000000010${n}`;
    await turn({ threadId: other(1) });
    await turn({ threadId: other(2) });
    expect(claude.live.list()).toHaveLength(2);
    await turn({ threadId: other(3) });
    expect(calls[0]!.closed).toBe(true);
    expect(calls[1]!.closed).toBe(false);
    expect(claude.live.list().map((live) => live.threadId)).toEqual([other(2), other(3)]);
  });

  it("keeps a session running background work past its idle time, then ends it (D348)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const { claude, turn, calls } = node([workingInBackground(done)], { sessionIdleMinutes: 5 });
    await turn();
    expect(claude.live.list()).toMatchObject([{ background: 1 }]);
    vi.advanceTimersByTime(60 * 60_000);
    expect(calls[0]!.closed).toBe(false);
    // Not for the asking either: only with force.
    expect(claude.live.close(THREAD)).toBe(false);
    // The work ends past the idle deadline: the session ends with it.
    finish();
    await calls[0]!.whenClosed;
    expect(claude.live.list()).toEqual([]);
  });

  it("ends a per-turn session running background work once the work ends (D348)", async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const { claude, turn, calls } = node([workingInBackground(done)], { session: "per-turn" });
    await turn();
    expect(calls[0]!.closed).toBe(false);
    expect(claude.live.closeIdle()).toBe(0);
    finish();
    await calls[0]!.whenClosed;
  });

  it("refuses a turn that would replace a session running background work (D348)", async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const { claude, turn, calls } = node([workingInBackground(done, "one", "two")]);
    await turn();
    // Full access is another launch: it would end the shell.
    await expect(turn({ runtimeMode: "full-access" })).rejects.toThrow(BackgroundWorkRunning);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.closed).toBe(false);
    expect(claude.live.list()).toMatchObject([{ busy: false, background: 1 }]);
    // The same settings go to it as ever.
    finish();
    expect(answers(await turn())).toEqual(["two"]);
  });

  it("keeps a refused per-turn session ending with its work (D348)", async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const { turn, calls } = node([workingInBackground(done)], { session: "per-turn" });
    await turn();
    await expect(turn({ runtimeMode: "full-access" })).rejects.toThrow(
      "Claude is still running background agents or commands",
    );
    finish();
    await calls[0]!.whenClosed;
  });

  it("does not end a session running background work for the cap, and 0 is no cap (D347)", async () => {
    const other = (n: number) => `0b6c5e5e-0000-4000-8000-00000000020${n}`;
    const working = node([workingInBackground(new Promise(() => undefined)), answering("b")], {
      maxLiveSessions: 1,
    });
    await working.turn({ threadId: other(1) });
    await working.turn({ threadId: other(2) });
    expect(working.calls[0]!.closed).toBe(false);
    expect(working.claude.live.list()).toHaveLength(2);

    const uncapped = node([answering("a"), answering("b"), answering("c")], {
      maxLiveSessions: 0,
    });
    for (const n of [1, 2, 3]) await uncapped.turn({ threadId: other(n) });
    expect(uncapped.claude.live.list()).toHaveLength(3);
  });

  it("interrupts again at once when the message started before the receipt came (D350)", async () => {
    const { claude, calls, state } = node([
      async function* (player) {
        const uuid = player.call.prompt[0]!.uuid;
        yield answeringUuid(uuid, init());
        yield* streamedBlock("m1", 0, "text", ["half"]);
        // Only a second interrupt ends it.
        await player.interruptedTimes(2);
        yield answeringUuid(
          uuid,
          result({
            subtype: "error_during_execution",
            errors: [],
            terminal_reason: "aborted_streaming",
          }),
        );
        await player.nextPrompt();
      },
    ]);
    state.receipt = (call) => ({ still_queued: [call.prompt[0]!.uuid] });
    const turn = claude.startTurn({
      threadId: THREAD,
      turnId: "t1",
      input: { text: "count" },
      history: [],
      cwd: "/work",
      model: "claude-haiku-5-5",
    });
    for await (const item of turn.items) if (item.kind === "message.completed") turn.interrupt();
    expect(calls[0]!.interrupts).toBe(2);
  });

  it("does not interrupt again once the stopped turn let go (D350)", async () => {
    let giveReceipt!: (receipt: unknown) => void;
    const late = new Promise((resolve) => (giveReceipt = resolve));
    const scripted = scriptedQuery(async function* (player) {
      const uuid = player.call.prompt[0]!.uuid;
      yield answeringUuid(uuid, init());
      await player.interrupted;
      yield answeringUuid(
        uuid,
        result({
          subtype: "error_during_execution",
          errors: [],
          terminal_reason: "aborted_streaming",
        }),
      );
      await player.nextPrompt();
    });
    scripted.state.receipt = () => late;
    const live = createLiveSessions({
      query: scripted.query,
      keepAlive: () => ({ keepAlive: true, idleMs: 0 }),
    });
    const held = await live.lease({
      threadId: THREAD,
      options: { cwd: "/work" },
      message: {
        type: "user",
        uuid: "0b6c5e5e-0000-4000-8000-0000000000aa",
        message: { role: "user", content: "count" },
        parent_tool_use_id: null,
      },
    });
    let stopped: Promise<unknown> | undefined;
    for await (const message of held.messages) {
      if (message.type === "system") stopped = held.interrupt();
    }
    held.release(true);
    // The receipt comes after the turn let go: the session may run another turn by now.
    giveReceipt({ still_queued: ["0b6c5e5e-0000-4000-8000-0000000000aa"] });
    await stopped;
    expect(scripted.calls[0]!.interrupts).toBe(1);
  });

  it("changes the effort of the running Claude Code live (D349)", async () => {
    const { turn, calls, settings } = node([answering("one", "two", "three")]);
    await turn();
    settings.config = Config.parse({ effort: "high" });
    await turn();
    settings.config = Config.parse({});
    await turn();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.controls).toEqual(["effort:high", "effort:null"]);
  });

  it("stops a message the interrupt did not reach once it starts (D350)", async () => {
    let received!: () => void;
    const sent = new Promise<void>((resolve) => (received = resolve));
    const { claude, calls, state } = node([
      async function* (player) {
        const uuid = player.call.prompt[0]!.uuid;
        received();
        await player.interrupted;
        // Claude Code took the message after the interrupt: it runs, and is stopped again.
        yield answeringUuid(uuid, init());
        yield* streamedBlock("m1", 0, "text", ["unseen"]);
        yield answeringUuid(
          uuid,
          result({
            subtype: "error_during_execution",
            errors: [],
            terminal_reason: "aborted_streaming",
          }),
        );
        await player.nextPrompt();
      },
    ]);
    state.receipt = (call) => ({ still_queued: [call.prompt[0]!.uuid] });
    const stopped = claude.startTurn({
      threadId: THREAD,
      turnId: "t1",
      input: { text: "count" },
      history: [],
      cwd: "/work",
      model: "claude-haiku-5-5",
    });
    const items = drain(stopped);
    await sent;
    stopped.interrupt();
    expect(answers(await items)).toEqual([]);
    expect(calls[0]!.interrupts).toBe(2);
  });
});
