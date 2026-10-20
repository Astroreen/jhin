import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { createTimeline, turnBlocks } from "../src/lib/timeline.ts";
import { dispatchMode, sendMessage } from "../src/plugins/chat/send.ts";

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
