import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { reduceTurns } from "../src/lib/turns.ts";

let sequence = 0;
const event = (type: string, payload: unknown): StoredEvent => ({
  stream: "thread/t",
  sequence: ++sequence,
  type,
  payload: payload as never,
  at: "2026-01-01T00:00:00.000Z",
});

describe("reduceTurns", () => {
  it("folds deltas, completion, interruption and failure into turns", () => {
    const turns = reduceTurns([
      event("threads.thread.created", { id: "t" }),
      event("agent.turn.started", { turnId: "1", agentId: "fake", input: { text: "hi" } }),
      event("agent.item.delta", { turnId: "1", text: "Echo:" }),
      event("agent.item.delta", { turnId: "1", text: " hi" }),
      event("agent.turn.completed", { turnId: "1" }),
      event("agent.turn.started", { turnId: "2", agentId: "fake", input: { text: "wait" } }),
      event("agent.item.delta", { turnId: "2", text: "Hold" }),
      event("agent.turn.interrupted", { turnId: "2" }),
      event("agent.turn.started", { turnId: "3", agentId: "fake", input: { text: "x" } }),
      event("agent.turn.failed", { turnId: "3", error: "boom" }),
      event("someone.else.event", { turnId: "1" }),
    ]);

    expect(turns).toEqual([
      {
        turnId: "1",
        agentId: "fake",
        userText: "hi",
        assistantText: "Echo: hi",
        status: "completed",
      },
      {
        turnId: "2",
        agentId: "fake",
        userText: "wait",
        assistantText: "Hold",
        status: "interrupted",
      },
      {
        turnId: "3",
        agentId: "fake",
        userText: "x",
        assistantText: "",
        status: "failed",
        error: "boom",
      },
    ]);
  });
});
