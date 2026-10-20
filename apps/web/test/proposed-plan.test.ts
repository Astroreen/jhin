import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildProposedPlanMarkdownFilename,
  canCollapsePlan,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  stripDisplayedPlanMarkdown,
} from "../src/lib/proposed-plan.ts";
import {
  actionablePlan,
  foldsBeforeFinal,
  reduceTimeline,
  turnBlocks,
} from "../src/lib/timeline.ts";

function stream(...entries: [type: string, payload: unknown][]): StoredEvent[] {
  return entries.map(([type, payload], index) => ({
    stream: "thread/t1",
    sequence: index + 1,
    type,
    payload: payload as StoredEvent["payload"],
    at: new Date(Date.UTC(2026, 9, 18, 12, 0, index)).toISOString(),
  }));
}

const PLAN = "# Add a cache\n\n## Summary\n\nKeep results.\n\n1. Read\n2. Change\n";

describe("proposed plan text (T3's proposedPlan.ts)", () => {
  it("takes the first heading as the title and strips it and a Summary heading from the body", () => {
    expect(proposedPlanTitle(PLAN)).toBe("Add a cache");
    expect(proposedPlanTitle("1. Just steps")).toBeNull();
    expect(stripDisplayedPlanMarkdown(PLAN)).toBe("Keep results.\n\n1. Read\n2. Change");
  });

  it("collapses long plans to a preview of their first lines", () => {
    expect(canCollapsePlan(PLAN)).toBe(false);
    const long = ["# Long", ...Array.from({ length: 25 }, (_, index) => `${index + 1}. Step`)].join(
      "\n",
    );
    expect(canCollapsePlan(long)).toBe(true);
    expect(canCollapsePlan("x".repeat(901))).toBe(true);
    const preview = buildCollapsedProposedPlanPreviewMarkdown(long, { maxLines: 10 });
    expect(preview.split("\n")).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `${index + 1}. Step`),
      "",
      "...",
    ]);
  });

  it("names files, titles and prompts as T3 does", () => {
    expect(buildProposedPlanMarkdownFilename(PLAN)).toBe("add-a-cache.md");
    expect(buildProposedPlanMarkdownFilename("no title")).toBe("plan.md");
    expect(buildPlanImplementationThreadTitle(PLAN)).toBe("Implement Add a cache");
    expect(buildPlanImplementationThreadTitle("steps")).toBe("Implement plan");
    expect(buildPlanImplementationPrompt(`  ${PLAN}  `)).toBe(
      `PLEASE IMPLEMENT THIS PLAN:\n${PLAN.trim()}`,
    );
    expect(resolvePlanFollowUpSubmission({ draftText: " ", planMarkdown: PLAN })).toEqual({
      text: buildPlanImplementationPrompt(PLAN),
      interactionMode: "default",
    });
    expect(
      resolvePlanFollowUpSubmission({ draftText: " more tests ", planMarkdown: PLAN }),
    ).toEqual({ text: "more tests", interactionMode: "plan" });
  });
});

describe("proposed plans in the timeline (D304)", () => {
  const started = (turnId: string) =>
    [ThreadEvents.turnStarted, { turnId, agentId: "fake", input: { text: "plan it" } }] as [
      string,
      unknown,
    ];

  it("keeps the plan as an item, never folded away, and offers the latest one once the turn ended", () => {
    const events = stream(
      started("u1"),
      [ThreadEvents.itemCompleted, { turnId: "u1", itemId: "r", kind: "reasoning", text: "hm" }],
      [ThreadEvents.planProposed, { turnId: "u1", itemId: "p1", markdown: "# First" }],
      [ThreadEvents.planProposed, { turnId: "u1", itemId: "p2", markdown: PLAN }],
    );
    const running = reduceTimeline(events);
    expect(actionablePlan(running)).toBeUndefined();

    const ended = reduceTimeline([
      ...events,
      ...stream(
        [ThreadEvents.itemCompleted, { turnId: "u1", itemId: "m", kind: "message", text: "Done" }],
        [ThreadEvents.turnCompleted, { turnId: "u1" }],
      ).map((event, index) => ({ ...event, sequence: events.length + index + 1 })),
    ]);
    const turn = ended.turns[0]!;
    expect(turnBlocks(turn).map((block) => block.kind)).toEqual([
      "work",
      "proposed-plan",
      "proposed-plan",
      "message",
    ]);
    expect(foldsBeforeFinal(turn)).toBe(true);
    expect(actionablePlan(ended)).toMatchObject({ itemId: "p2", markdown: PLAN });
  });

  it("offers nothing after a failed turn or once a later turn ran without a plan", () => {
    const failed = reduceTimeline(
      stream(
        started("u1"),
        [ThreadEvents.planProposed, { turnId: "u1", itemId: "p", markdown: PLAN }],
        [ThreadEvents.turnFailed, { turnId: "u1", error: "boom" }],
      ),
    );
    expect(actionablePlan(failed)).toBeUndefined();
    const later = reduceTimeline(
      stream(
        started("u1"),
        [ThreadEvents.planProposed, { turnId: "u1", itemId: "p", markdown: PLAN }],
        [ThreadEvents.turnCompleted, { turnId: "u1" }],
        started("u2"),
        [ThreadEvents.turnCompleted, { turnId: "u2" }],
      ),
    );
    expect(actionablePlan(later)).toBeUndefined();
  });

  it("reads Claude Code's earlier plans, recorded as messages ending in ':plan'", () => {
    const timeline = reduceTimeline(
      stream(
        started("u1"),
        [
          ThreadEvents.itemCompleted,
          { turnId: "u1", itemId: "toolu_1:plan", kind: "message", text: PLAN },
        ],
        [ThreadEvents.turnCompleted, { turnId: "u1" }],
      ),
    );
    expect(timeline.turns[0]!.items).toEqual([
      expect.objectContaining({ kind: "proposed-plan", itemId: "toolu_1:plan", markdown: PLAN }),
    ]);
  });
});
