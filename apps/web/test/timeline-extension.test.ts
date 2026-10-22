import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { foldsBeforeFinal, reduceTimeline, turnBlocks } from "../src/lib/timeline.ts";

function stream(...entries: [type: string, payload: unknown][]): StoredEvent[] {
  return entries.map(([type, payload], index) => ({
    stream: "thread/t1",
    sequence: index + 1,
    type,
    payload: payload as StoredEvent["payload"],
    at: new Date(Date.UTC(2026, 9, 21, 12, 0, index)).toISOString(),
  }));
}

describe("events of other plugins in a turn (D407)", () => {
  it("keeps a plugin's event in its place among the agent's output, unfolded", () => {
    const timeline = reduceTimeline(
      stream(
        [ThreadEvents.turnStarted, { turnId: "u1", agentId: "fake", input: { text: "chart" } }],
        [
          ThreadEvents.itemStarted,
          {
            turnId: "u1",
            itemId: "t1",
            kind: "tool",
            tool: { kind: "other", name: "html_render", input: {} },
          },
        ],
        [
          ThreadEvents.itemCompleted,
          { turnId: "u1", itemId: "t1", kind: "tool", status: "completed" },
        ],
        // Without a turn id: the thread's latest turn.
        [
          "preview.html.rendered",
          { renderId: "r1", title: "Chart", height: 200, html: "<p>x</p>" },
        ],
        [ThreadEvents.itemDelta, { turnId: "u1", itemId: "m1", kind: "message", text: "Done." }],
        [
          ThreadEvents.itemCompleted,
          { turnId: "u1", itemId: "m1", kind: "message", text: "Done." },
        ],
        [ThreadEvents.turnCompleted, { turnId: "u1" }],
      ),
    );
    const turn = timeline.turns[0]!;
    const kinds = turnBlocks(turn).map((block) => block.kind);
    expect(kinds).toEqual(["work", "extension", "message"]);
    expect(foldsBeforeFinal(turn)).toBe(true);
    const extension = turnBlocks(turn).find((block) => block.kind === "extension");
    expect(extension?.kind === "extension" && extension.item.event.type).toBe(
      "preview.html.rendered",
    );
  });

  it("drops a plugin's event before the thread has a turn, and ignores unknown agent events", () => {
    const timeline = reduceTimeline(
      stream(
        ["preview.html.rendered", { renderId: "r0", title: "Early", height: 200, html: "" }],
        [ThreadEvents.turnStarted, { turnId: "u1", agentId: "fake", input: { text: "hi" } }],
        ["agent.something.new", { turnId: "u1" }],
      ),
    );
    expect(timeline.turns[0]!.items).toEqual([]);
  });
});
