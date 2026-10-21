import { ThreadEvents, type AgentItem, type AgentTurn } from "@jhin/agent-api";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { Config, createClaudeRuntime, transcript } from "../src/index.ts";
import {
  init,
  memorySessions,
  result,
  scriptedQuery,
  streamedBlock,
  toolResult,
  toolUse,
  type Script,
} from "./support.ts";

const THREAD = "0b6c5e5e-0000-4000-8000-000000000004";

/** A frame marked as answering the messages `uuids`, as Claude Code marks a turn's frames. */
const marked = (uuids: readonly (string | undefined)[], message: SDKMessage) =>
  ({ ...message, user_message_uuid: uuids[0], user_message_uuids: uuids }) as SDKMessage;
/** The result Claude Code sends when a steer stopped its response. */
const aborted = () =>
  result({
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    errors: [],
  });

function start(...scripts: Script[]) {
  const scripted = scriptedQuery(...scripts);
  const logged: string[] = [];
  /** Waiters for a message to be logged. */
  const waiting: { message: string; resolve: () => void }[] = [];
  const claude = createClaudeRuntime({
    query: scripted.query,
    sessions: memorySessions(),
    config: () => Config.parse({}),
    log: (message) => {
      logged.push(message);
      for (const waiter of waiting) if (waiter.message === message) waiter.resolve();
    },
  });
  /** Resolves once `message` is logged. */
  const whenLogged = (message: string) =>
    logged.includes(message)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiting.push({ message, resolve }));
  const turn = claude.startTurn({
    threadId: THREAD,
    turnId: "t1",
    input: { text: "first" },
    history: [],
    cwd: "/work",
    model: "claude-haiku-5-5",
    runtimeMode: "full-access",
  });
  return { claude, turn, logged, whenLogged, ...scripted };
}

/** Every item of a turn; `onItem` runs as each one comes. */
async function drain(turn: AgentTurn, onItem: (item: AgentItem) => void = () => {}) {
  const items: AgentItem[] = [];
  for await (const item of turn.items) {
    items.push(item);
    onItem(item);
  }
  return items;
}
const answers = (items: readonly AgentItem[]) =>
  items.flatMap((item) => (item.kind === "message.completed" ? [item.text] : []));

describe("jhin.agent-claude: steering (D206)", () => {
  it("sends a steer into the running query and goes on past the result it aborted", async () => {
    let steer: SDKUserMessage | undefined;
    const { turn, calls } = start(async function* (player) {
      const first = player.call.prompt[0]!.uuid;
      yield marked([first], init());
      yield* streamedBlock("m1", 0, "text", ["working"]);
      steer = await player.nextPrompt();
      // The steer stops the response: an aborted result that is not the turn's end.
      yield marked([first], aborted());
      yield marked([steer!.uuid], init());
      yield* streamedBlock("m2", 0, "text", ["steered"]);
      yield marked([steer!.uuid], result());
      await player.nextPrompt();
    });

    let sent = false;
    const items = await drain(turn, (item) => {
      if (item.kind === "message.completed" && !sent) {
        sent = true;
        turn.steer!({ text: "change course" });
      }
    });

    expect(answers(items)).toEqual(["working", "steered"]);
    expect(steer).toMatchObject({
      priority: "now",
      message: { role: "user", content: "change course" },
    });
    expect(calls).toHaveLength(1);
    expect(() => turn.steer!({ text: "late" })).toThrow("The turn has ended");
  });

  it("reads on when Claude Code answered the turn before it took the steer", async () => {
    const { turn } = start(async function* (player) {
      const first = player.call.prompt[0]!.uuid;
      yield marked([first], init());
      yield* streamedBlock("m1", 0, "text", ["one"]);
      // Already finished when the steer came: its own answer follows.
      const steer = await player.nextPrompt();
      yield marked([first], result());
      yield marked([steer!.uuid], init());
      yield* streamedBlock("m2", 0, "text", ["two"]);
      yield marked([steer!.uuid], result());
      await player.nextPrompt();
    });

    let sent = false;
    const items = await drain(turn, (item) => {
      if (item.kind === "message.completed" && !sent) {
        sent = true;
        turn.steer!({ text: "and then" });
      }
    });
    expect(answers(items)).toEqual(["one", "two"]);
  });

  it("puts a steer that came before Claude Code started right after the turn's message", async () => {
    const { turn, calls } = start(async function* (player) {
      const steer = await player.nextPrompt();
      yield marked([player.call.prompt[0]!.uuid, steer!.uuid], init());
      yield* streamedBlock("m1", 0, "text", ["both"]);
      yield marked([player.call.prompt[0]!.uuid, steer!.uuid], result());
      await player.nextPrompt();
    });
    turn.steer!({ text: "also this" });

    expect(answers(await drain(turn))).toEqual(["both"]);
    expect(calls[0]!.prompt.map((sent) => sent.message.content)).toEqual(["first", "also this"]);
  });

  it("takes no steer after an interrupt", async () => {
    const { turn } = start(async function* (player) {
      yield init();
      await player.interrupted;
      yield aborted();
      await player.nextPrompt();
    });
    turn.interrupt();
    expect(() => turn.steer!({ text: "no" })).toThrow("The turn has ended");
    await drain(turn);
  });

  it("tells Claude what was steered when it joins a thread later", () => {
    const at = new Date().toISOString();
    const history = [
      {
        stream: "thread/x",
        sequence: 1,
        at,
        type: ThreadEvents.turnStarted,
        payload: { turnId: "a", agentId: "other", input: { text: "start" } },
      },
      {
        stream: "thread/x",
        sequence: 2,
        at,
        type: ThreadEvents.turnSteered,
        payload: { turnId: "a", messageId: "s", input: { text: "steer" } },
      },
    ];
    expect(transcript(history)).toContain("User: start\nUser: steer");
  });

  it("ends at the passed-over result when Claude Code goes idle without answering the steer", async () => {
    const state = (value: "running" | "idle") =>
      ({ type: "system", subtype: "session_state_changed", state: value }) as SDKMessage;
    const { turn } = start(async function* (player) {
      const first = player.call.prompt[0]!.uuid;
      yield state("running");
      yield marked([first], init());
      yield* streamedBlock("m1", 0, "text", ["working"]);
      await player.nextPrompt();
      yield marked([first], aborted());
      // It took the steer and had nothing to add.
      yield state("idle");
      await player.nextPrompt();
    });

    let sent = false;
    const items = await drain(turn, (item) => {
      if (item.kind === "message.completed" && !sent) {
        sent = true;
        turn.steer!({ text: "never mind" });
      }
    });
    expect(answers(items)).toEqual(["working"]);
  });

  describe("moves the turn's foreground subagents to the background first (D805)", () => {
    /** A turn that runs subagents, then streams; it records what was asked before the steer. */
    function subagents(seen: { controls?: string[] }): Script {
      return async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield marked([first], init());
        // Running in the foreground: the one to move.
        yield marked([first], toolUse("a1", "toolu_fg", "Agent", { prompt: "look around" }));
        // Already in the background, a nested one, and one that returned: left alone.
        yield marked(
          [first],
          toolUse("a2", "toolu_bg", "Agent", { prompt: "watch", run_in_background: true }),
        );
        yield marked([first], toolUse("a3", "toolu_nested", "Agent", {}, "toolu_fg"));
        yield marked([first], toolUse("a4", "toolu_done", "Task", { prompt: "quick" }));
        yield marked([first], toolResult("toolu_done", "done"));
        yield* streamedBlock("m1", 0, "text", ["working"]);
        const steer = await player.nextPrompt();
        seen.controls = player.call.controls.filter((entry) => entry.startsWith("background:"));
        yield marked([first], aborted());
        yield marked([steer!.uuid], init());
        yield* streamedBlock("m2", 0, "text", ["steered"]);
        yield marked([steer!.uuid], result());
        await player.nextPrompt();
      };
    }

    it("asks Claude Code to move each one before the steer goes in", async () => {
      const seen: { controls?: string[] } = {};
      const { turn } = start(subagents(seen));
      let sent = false;
      const items = await drain(turn, (item) => {
        if (item.kind === "message.completed" && !sent) {
          sent = true;
          turn.steer!({ text: "change course" });
        }
      });
      expect(seen.controls).toEqual(["background:toolu_fg"]);
      expect(answers(items)).toEqual(["working", "steered"]);
    });

    it("steers as before when Claude Code refuses to move them", async () => {
      const seen: { controls?: string[] } = {};
      const { turn, state, logged } = start(subagents(seen));
      // Thrown at once, as a closed query does, rather than rejected.
      state.background = () => {
        throw new Error("background tasks are disabled");
      };
      let sent = false;
      const items = await drain(turn, (item) => {
        if (item.kind === "message.completed" && !sent) {
          sent = true;
          turn.steer!({ text: "change course" });
        }
      });
      expect(seen.controls).toEqual(["background:toolu_fg"]);
      expect(answers(items)).toEqual(["working", "steered"]);
      expect(logged).toContain("claude code did not move a subagent to the background");
    });

    it("steers as before with a CLI that cannot move tasks to the background", async () => {
      const seen: { controls?: string[] } = {};
      const { turn, state } = start(subagents(seen));
      state.noBackground = true;
      let sent = false;
      const items = await drain(turn, (item) => {
        if (item.kind === "message.completed" && !sent) {
          sent = true;
          turn.steer!({ text: "change course" });
        }
      });
      expect(seen.controls).toEqual([]);
      expect(answers(items)).toEqual(["working", "steered"]);
    });

    it("logs a steer whose turn ended while Claude Code moved the subagents", async () => {
      let answer!: (moved: boolean) => void;
      const { turn, state, whenLogged } = start(async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield marked([first], init());
        yield marked([first], toolUse("a1", "toolu_fg", "Agent", { prompt: "look around" }));
        yield* streamedBlock("m1", 0, "text", ["working"]);
        // The turn ends before Claude Code answers the move.
        yield marked([first], result());
        await player.nextPrompt();
      });
      state.background = () => new Promise<boolean>((resolve) => (answer = resolve));
      let sent = false;
      const items = await drain(turn, (item) => {
        if (item.kind === "message.completed" && !sent) {
          sent = true;
          turn.steer!({ text: "too late" });
        }
      });
      expect(answers(items)).toEqual(["working"]);
      answer(true);
      await whenLogged("claude code ended the turn before it took a steer");
    });

    it("asks once per tool call: a second steer waits on the same answer", async () => {
      let controls: string[] = [];
      const { turn, state } = start(async function* (player) {
        const first = player.call.prompt[0]!.uuid;
        yield marked([first], init());
        yield marked([first], toolUse("a1", "toolu_fg", "Agent", { prompt: "look around" }));
        yield* streamedBlock("m1", 0, "text", ["working"]);
        const one = await player.nextPrompt();
        const two = await player.nextPrompt();
        controls = player.call.controls.filter((entry) => entry.startsWith("background:"));
        yield marked([first], aborted());
        yield marked([one!.uuid, two!.uuid], init());
        yield* streamedBlock("m2", 0, "text", ["steered"]);
        yield marked([one!.uuid, two!.uuid], result());
        await player.nextPrompt();
      });
      // Claude Code moves nothing: the subagent stays in the foreground.
      state.background = () => Promise.resolve(false);
      let sent = false;
      const items = await drain(turn, (item) => {
        if (item.kind === "message.completed" && !sent) {
          sent = true;
          turn.steer!({ text: "one" });
          turn.steer!({ text: "two" });
        }
      });
      expect(controls).toEqual(["background:toolu_fg"]);
      expect(answers(items)).toEqual(["working", "steered"]);
    });
  });
});
