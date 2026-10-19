import { ThreadEvents, type ToolCall } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  answerPreview,
  createTimeline,
  foldsBeforeFinal,
  openRequests,
  reduceTimeline,
  summarizeWork,
  turnBlocks,
  workEntryLabel,
  type RequestItem,
  type ToolItem,
  type WorkEntry,
} from "../src/lib/timeline.ts";

/** A thread stream: events get consecutive sequences and one second apart. */
function stream(...entries: [type: string, payload: unknown][]): StoredEvent[] {
  return entries.map(([type, payload], index) => ({
    stream: "thread/t1",
    sequence: index + 1,
    type,
    payload: payload as StoredEvent["payload"],
    at: new Date(Date.UTC(2026, 9, 18, 12, 0, index)).toISOString(),
  }));
}

const started = (turnId = "u1", text = "hi") =>
  [ThreadEvents.turnStarted, { turnId, agentId: "fake", input: { text } }] as [string, unknown];

const command = (detail: string): ToolCall => ({
  name: "Bash",
  kind: "command",
  title: "Ran command",
  detail,
});

describe("reduceTimeline", () => {
  it("joins message deltas and keeps the completed text", () => {
    const timeline = reduceTimeline(
      stream(
        started(),
        [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m", kind: "message", text: "Hel" }],
        [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m", kind: "message", text: "lo" }],
      ),
    );
    expect(timeline.turns[0]).toMatchObject({
      turnId: "u1",
      text: "hi",
      state: "running",
      items: [{ kind: "message", text: "Hello", completed: false }],
    });

    const done = reduceTimeline(
      stream(
        started(),
        [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m", kind: "message", text: "Hel" }],
        [ThreadEvents.itemCompleted, { turnId: "u1", itemId: "m", kind: "message", text: "Hello" }],
        [ThreadEvents.turnCompleted, { turnId: "u1" }],
      ),
    );
    expect(done.turns[0]).toMatchObject({
      state: "completed",
      endedAt: "2026-10-18T12:00:03.000Z",
      items: [{ kind: "message", text: "Hello", completed: true, at: "2026-10-18T12:00:01.000Z" }],
    });
  });

  it("follows a tool from start to its output and status", () => {
    const timeline = reduceTimeline(
      stream(
        started(),
        [
          ThreadEvents.itemStarted,
          { turnId: "u1", itemId: "t", kind: "tool", tool: command("ls") },
        ],
        [ThreadEvents.itemDelta, { turnId: "u1", itemId: "t", kind: "tool", text: "a\n" }],
        [
          ThreadEvents.itemCompleted,
          { turnId: "u1", itemId: "t", kind: "tool", status: "failed", error: "exit 1" },
        ],
      ),
    );
    expect(timeline.turns[0]!.items[0]).toMatchObject({
      kind: "tool",
      output: "a\n",
      status: "failed",
      error: "exit 1",
      endedAt: "2026-10-18T12:00:03.000Z",
    });
  });

  it("keeps one plan where it first appeared and the latest usage", () => {
    const timeline = reduceTimeline(
      stream(
        started(),
        [ThreadEvents.planUpdated, { turnId: "u1", steps: [{ text: "a", status: "pending" }] }],
        [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m", kind: "message", text: "x" }],
        [ThreadEvents.planUpdated, { turnId: "u1", steps: [{ text: "a", status: "completed" }] }],
        [ThreadEvents.usageUpdated, { turnId: "u1", usage: { inputTokens: 10, outputTokens: 2 } }],
      ),
    );
    const turn = timeline.turns[0]!;
    expect(turn.items.map((item) => item.kind)).toEqual(["plan", "message"]);
    expect(turn.items[0]).toMatchObject({
      steps: [{ text: "a", status: "completed" }],
      at: "2026-10-18T12:00:01.000Z",
    });
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("closes requests still open when their turn ends", () => {
    const request = { kind: "approval", tool: command("rm -rf build") };
    const running = stream(started(), [
      ThreadEvents.requestOpened,
      { turnId: "u1", requestId: "r", request },
    ]);
    expect(openRequests(reduceTimeline(running)).map((item) => item.requestId)).toEqual(["r"]);

    const interrupted = reduceTimeline([
      ...running,
      ...stream([ThreadEvents.turnInterrupted, { turnId: "u1", reason: "stopped" }]).map(
        (event) => ({ ...event, sequence: 3 }),
      ),
    ]);
    expect(interrupted.turns[0]).toMatchObject({ state: "interrupted", error: "stopped" });
    expect(interrupted.turns[0]!.items[0]).toMatchObject({ kind: "request", state: "closed" });
    expect(openRequests(interrupted)).toEqual([]);
  });

  it("records answers and ignores events of unknown turns", () => {
    const timeline = reduceTimeline(
      stream(
        started(),
        [
          ThreadEvents.requestOpened,
          {
            turnId: "u1",
            requestId: "q",
            request: {
              kind: "user-input",
              questions: [{ id: "c", header: "Color", question: "Color?", options: [] }],
            },
          },
        ],
        [
          ThreadEvents.requestResolved,
          {
            turnId: "u1",
            requestId: "q",
            response: { kind: "user-input", answers: { c: "Blue" } },
          },
        ],
        [ThreadEvents.itemDelta, { turnId: "other", itemId: "m", kind: "message", text: "x" }],
        ["something.else", { turnId: "u1" }],
      ),
    );
    const request = timeline.turns[0]!.items[0] as RequestItem;
    expect(request.state).toBe("answered");
    expect(answerPreview(request)).toBe("Blue");
    expect(timeline.turns[0]!.items).toHaveLength(1);
  });

  it("marks a deleted thread", () => {
    expect(reduceTimeline(stream([ThreadEvents.threadDeleted, { id: "t1" }])).deleted).toBe(true);
  });
});

describe("turn blocks", () => {
  const turn = reduceTimeline(
    stream(
      started(),
      [ThreadEvents.itemDelta, { turnId: "u1", itemId: "r", kind: "reasoning", text: "hmm" }],
      [ThreadEvents.itemStarted, { turnId: "u1", itemId: "t", kind: "tool", tool: command("ls") }],
      [
        ThreadEvents.itemCompleted,
        { turnId: "u1", itemId: "t", kind: "tool", status: "completed" },
      ],
      [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m1", kind: "message", text: "Looking" }],
      [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m2", kind: "message", text: "Done" }],
      [ThreadEvents.turnCompleted, { turnId: "u1" }],
    ),
  ).turns[0]!;

  it("groups consecutive work and marks the last message of a settled turn final", () => {
    const blocks = turnBlocks(turn);
    expect(blocks.map((block) => block.kind)).toEqual(["work", "message", "message"]);
    expect(blocks[0]).toMatchObject({ entries: [{ kind: "reasoning" }, { kind: "tool" }] });
    expect(blocks.map((block) => (block.kind === "message" ? block.final : null))).toEqual([
      null,
      false,
      true,
    ]);
    expect(foldsBeforeFinal(turn)).toBe(true);
  });

  it("does not fold a running or failed turn, or one whose answer comes first", () => {
    expect(foldsBeforeFinal({ ...turn, state: "running" })).toBe(false);
    expect(foldsBeforeFinal({ ...turn, state: "failed" })).toBe(false);
    const answerOnly = { ...turn, items: turn.items.filter((item) => item.kind === "message") };
    expect(foldsBeforeFinal({ ...answerOnly, items: answerOnly.items.slice(1) })).toBe(false);
  });
});

describe("work summaries", () => {
  const tool = (kind: ToolCall["kind"], detail: string, status: ToolItem["status"] = "completed") =>
    ({
      kind: "tool",
      itemId: detail,
      tool: { name: kind, kind, title: kind, detail },
      output: "",
      status,
      at: "2026-10-18T12:00:00.000Z",
    }) satisfies ToolItem;

  it("names the two most telling actions and counts the rest", () => {
    const entries: WorkEntry[] = [
      tool("file_read", "a.ts"),
      tool("command", "npm test"),
      tool("file_change", "a.ts"),
      tool("file_change", "a.ts"),
      tool("web", "docs"),
    ];
    expect(summarizeWork(entries)).toEqual({
      summary: "Ran 1 command, changed 1 file, and performed 2 other actions",
      hasFailure: false,
    });
  });

  it("says thoughts when there is only reasoning, and flags failures", () => {
    const thought = {
      kind: "reasoning",
      itemId: "r",
      text: "",
      completed: true,
      at: "2026-10-18T12:00:00.000Z",
    } as const;
    expect(summarizeWork([thought]).summary).toBe("Thought");
    expect(summarizeWork([thought, thought]).summary).toBe("Thought (×2)");
    expect(summarizeWork([tool("command", "make", "failed")])).toEqual({
      summary: "Ran 1 command",
      hasFailure: true,
    });
  });

  it("labels entries by what they did", () => {
    expect(workEntryLabel(tool("command", "npm run build"))).toBe("Ran npm");
    expect(workEntryLabel(tool("command", "npm test", "running"))).toBe("Running npm");
    expect(workEntryLabel(tool("file_change", "src/a.ts"))).toBe("Edited src/a.ts");
    expect(workEntryLabel(tool("search", "useFoo"))).toBe("Searched useFoo");
    expect(
      workEntryLabel({
        kind: "request",
        requestId: "r",
        request: { kind: "approval", tool: command("rm -rf build") },
        state: "answered",
        response: { kind: "approval", decision: "accept" },
        at: "2026-10-18T12:00:00.000Z",
      }),
    ).toBe("Approved: rm -rf build");
  });
});

describe("folding as events arrive", () => {
  const events = stream(
    started("u1", "first"),
    [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m1", kind: "message", text: "Hel" }],
    [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m1", kind: "message", text: "lo" }],
    [ThreadEvents.itemCompleted, { turnId: "u1", itemId: "m1", kind: "message", text: "Hello" }],
    [ThreadEvents.turnCompleted, { turnId: "u1" }],
    started("u2", "second"),
    [ThreadEvents.itemStarted, { turnId: "u2", itemId: "t", kind: "tool", tool: command("ls") }],
    [
      ThreadEvents.requestOpened,
      { turnId: "u2", requestId: "r", request: { kind: "approval", tool: command("rm") } },
    ],
    [ThreadEvents.turnInterrupted, { turnId: "u2" }],
  );

  it("gives the same timeline event by event as all at once", () => {
    const fold = createTimeline();
    for (const event of events) fold.apply([event]);
    expect(fold.current()).toEqual(reduceTimeline(events));
  });

  it("keeps the turns a batch did not touch, and the whole timeline when nothing changed", () => {
    const fold = createTimeline();
    const first = fold.apply(events.slice(0, 5));
    const second = fold.apply(events.slice(5));
    expect(second.turns[0]).toBe(first.turns[0]);
    expect(second.turns[1]).not.toBe(first.turns[1]);
    expect(fold.apply([])).toBe(second);
    const unknown = stream(["something.else", { turnId: "u1" }]).map((event) => ({
      ...event,
      sequence: events.length + 1,
    }));
    expect(fold.apply(unknown)).toBe(second);
  });

  it("folds an event once, when its stream delivers it again", () => {
    const fold = createTimeline();
    const once = fold.apply(events);
    expect(fold.apply(events.slice(3))).toBe(once);
    expect(fold.current()).toEqual(reduceTimeline(events));
  });
});
