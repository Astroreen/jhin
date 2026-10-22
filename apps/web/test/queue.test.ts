import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { createTimeline, turnBlocks } from "../src/lib/timeline.ts";
import { dropTarget } from "../src/plugins/chat/composer-banners.tsx";
import { dispatchMode, RESUME_TEXT, resumeThread, sendMessage } from "../src/plugins/chat/send.ts";

function stream(...entries: [type: string, payload: unknown][]): StoredEvent[] {
  return entries.map(([type, payload], index) => ({
    stream: "thread/t1",
    sequence: index + 1,
    type,
    payload: payload as StoredEvent["payload"],
    at: new Date(Date.UTC(2026, 9, 20, 12, 0, index)).toISOString(),
  }));
}

describe("the thread's queue and steers in its timeline (D201, D205)", () => {
  it("shows the queue the stream announced last and steered messages inside their turn", () => {
    const fold = createTimeline();
    const events = stream(
      [ThreadEvents.turnStarted, { turnId: "u1", agentId: "a", input: { text: "start" } }],
      [
        ThreadEvents.queueUpdated,
        {
          messages: [{ id: "q1", text: "next", attachments: [], createdAt: "x" }],
        },
      ],
      [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m1", kind: "message", text: "Working" }],
      [ThreadEvents.turnSteered, { turnId: "u1", messageId: "s1", input: { text: "steer" } }],
      [
        ThreadEvents.itemCompleted,
        { turnId: "u1", itemId: "m2", kind: "message", text: "Steered" },
      ],
    );
    const first = fold.apply(events.slice(0, 2));
    expect(first.queue?.messages.map((message) => message.text)).toEqual(["next"]);

    const timeline = fold.apply(events.slice(2));
    expect(turnBlocks(timeline.turns[0]!).map((block) => block.kind)).toEqual([
      "message",
      "steer",
      "message",
    ]);
    expect(timeline.turns[0]!.items[1]).toMatchObject({ kind: "steer", text: "steer" });

    const held = fold.apply(
      stream(...events.map((event) => [event.type, event.payload] as [string, unknown]), [
        ThreadEvents.queueUpdated,
        { messages: [], held: { reason: "interrupted", turnId: "u1" } },
      ]),
    );
    expect(held.queue).toEqual({ messages: [], held: { reason: "interrupted", turnId: "u1" } });
  });
});

describe("sending while a turn runs (D209)", () => {
  it("queues or steers as the setting says, the other way with the alternate key", () => {
    expect(dispatchMode("queue", false, true)).toBe("queue");
    expect(dispatchMode("queue", true, true)).toBe("steer");
    expect(dispatchMode("steer", false, true)).toBe("steer");
    expect(dispatchMode("steer", true, true)).toBe("queue");
    // An agent that cannot steer gets it after its turn.
    expect(dispatchMode("steer", false, false)).toBe("queue");
  });

  it("calls the node's queue and steering commands", async () => {
    const calls: [string, unknown][] = [];
    const answers: Record<string, unknown> = {
      "threads.queue.add": {},
      "threads.steer": { outcome: "steered" },
    };
    const node = {
      call: async <T>(_target: unknown, method: string, input?: unknown): Promise<T> => {
        calls.push([method, input]);
        if (method === "threads.send") {
          throw Object.assign(new Error("busy"), { code: "TURN_IN_PROGRESS" });
        }
        return answers[method] as T;
      },
    };
    const message = { text: "hi", attachments: [], settings: { model: "m" } };
    const target = { node: "ws://a/rpc" };

    expect(await sendMessage(node, target, "t", message, "steer")).toEqual({ kind: "steered" });
    expect(await sendMessage(node, target, "t", message, "queue")).toEqual({ kind: "queued" });
    // A thread that turned out busy gets the message queued.
    expect(await sendMessage(node, target, "t", message)).toEqual({ kind: "queued" });
    expect(calls.map(([method]) => method)).toEqual([
      "threads.steer",
      "threads.queue.add",
      "threads.send",
      "threads.queue.add",
    ]);
    expect(calls[0]![1]).toEqual({ threadId: "t", text: "hi", model: "m" });

    // An agent that refuses steering gets the message queued instead.
    answers["threads.steer"] = undefined;
    const refusing = {
      call: async <T>(target_: unknown, method: string, input?: unknown): Promise<T> => {
        if (method === "threads.steer") {
          throw Object.assign(new Error("no"), { code: "STEER_UNSUPPORTED" });
        }
        return node.call<T>(target_, method, input);
      },
    };
    expect(await sendMessage(refusing, target, "t", message, "steer")).toEqual({
      kind: "queued",
    });
  });
});

describe("dropping a queued message (D210)", () => {
  const ids = ["a", "b", "c"];
  it("goes before the row it is dropped above, or to the end", () => {
    expect(dropTarget(ids, "c", 0)).toBe("a");
    expect(dropTarget(ids, "a", 2)).toBe("c");
    expect(dropTarget(ids, "a", 3)).toBeNull();
  });
  it("stays where it is when dropped next to itself, or with nowhere to go", () => {
    expect(dropTarget(ids, "b", 1)).toBeUndefined();
    expect(dropTarget(ids, "b", 2)).toBeUndefined();
    expect(dropTarget(ids, "b", null)).toBeUndefined();
    expect(dropTarget(ids, "gone", 0)).toBeUndefined();
  });
});

describe("an answer to a steer the client does not know", () => {
  it.each(["teleported", "constructor", undefined])(
    "%s is a failure, so the draft stays",
    async (answer) => {
      const node = { call: async <T>(): Promise<T> => ({ outcome: answer }) as T };
      const outcome = await sendMessage(
        node,
        { node: "ws://a/rpc" },
        "t",
        { text: "hi", attachments: [], settings: {} },
        "steer",
      );
      expect(outcome).toMatchObject({ kind: "failed" });
    },
  );
});

describe("resuming a thread (D800)", () => {
  const target = { node: "local" };
  /** A node that answers what `answers` says and records each call. */
  function node(answers: Record<string, () => unknown> = {}) {
    const calls: [string, Record<string, unknown>][] = [];
    return {
      calls,
      threads: {
        call: async <T>(_target: unknown, method: string, params: Record<string, unknown>) => {
          calls.push([method, params]);
          return (answers[method]?.() ?? {}) as T;
        },
      },
    };
  }
  const settings = { agentId: "fake" };

  it("sends T3's message into a stopped turn's thread, then resumes its held queue", async () => {
    const { calls, threads } = node();
    const outcome = await resumeThread(threads, target, "t1", {
      stopped: true,
      held: true,
      settings,
    });
    expect(outcome).toEqual({ kind: "resumed" });
    expect(calls).toEqual([
      ["threads.send", { threadId: "t1", text: RESUME_TEXT, agentId: "fake" }],
      ["threads.queue.resume", { threadId: "t1" }],
    ]);
  });

  it("only sends the message when nothing is queued, and only resumes a queue held otherwise", async () => {
    const stopped = node();
    await resumeThread(stopped.threads, target, "t1", { stopped: true, held: false, settings });
    expect(stopped.calls.map(([method]) => method)).toEqual(["threads.send"]);

    const held = node();
    await resumeThread(held.threads, target, "t1", { stopped: false, held: true, settings });
    expect(held.calls.map(([method]) => method)).toEqual(["threads.queue.resume"]);
  });

  it("sends nothing into a thread that runs a turn already", async () => {
    const busy = Object.assign(new Error("busy"), { code: "TURN_IN_PROGRESS" });
    const { calls, threads } = node({
      "threads.send": () => {
        throw busy;
      },
    });
    const outcome = await resumeThread(threads, target, "t1", {
      stopped: true,
      held: false,
      settings,
    });
    expect(outcome).toEqual({ kind: "nothing" });
    expect(calls.map(([method]) => method)).toEqual(["threads.send"]);
  });

  it("says which step failed", async () => {
    const refused = node({
      "threads.send": () => {
        throw new Error("no agent");
      },
    });
    expect(
      await resumeThread(refused.threads, target, "t1", { stopped: true, held: true, settings }),
    ).toEqual({ kind: "failed", message: "Could not resume thread: no agent" });
    expect(refused.calls.map(([method]) => method)).toEqual(["threads.send"]);

    const queue = node({
      "threads.queue.resume": () => {
        throw new Error("gone");
      },
    });
    expect(
      await resumeThread(queue.threads, target, "t1", { stopped: true, held: true, settings }),
    ).toEqual({ kind: "failed", message: "The thread resumed, but its queue did not: gone" });
  });
});
