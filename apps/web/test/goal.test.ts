import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { presentGoal } from "../src/lib/goal.ts";
import { reduceTimeline } from "../src/lib/timeline.ts";

const events = (...entries: [string, unknown][]): StoredEvent[] =>
  entries.map(([type, payload], index) => ({
    stream: "thread/t1",
    sequence: index + 1,
    type,
    payload: payload as StoredEvent["payload"],
    at: new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString(),
  }));

describe("the goal banner (providers.md D1150)", () => {
  it("words a goal as T3 does", () => {
    expect(
      presentGoal(
        { objective: "Ship", status: "paused", tokensUsed: 12_400, timeUsedSeconds: 125 },
        false,
      ),
    ).toEqual({
      title: "Goal paused",
      objective: "Ship",
      usage: "12k tokens · 2m 5s",
      canResume: true,
    });
    expect(presentGoal({ objective: "Ship", status: "active" }, false).title).toBe("Goal set");
    expect(presentGoal({ objective: "Ship", status: "active" }, true).title).toBe("Pursuing goal");
    expect(
      presentGoal(
        {
          objective: "Ship",
          status: "budget_limited",
          tokensUsed: 1_500_000,
          tokenBudget: 2_000_000,
        },
        false,
      ),
    ).toMatchObject({ title: "Goal reached its token budget", usage: "1.5m / 2m tokens" });
    expect(presentGoal({ objective: "Ship", status: "complete" }, false).canResume).toBe(false);
  });

  it("keeps the thread's latest goal, none once it is cleared", () => {
    const started = [
      ThreadEvents.turnStarted,
      { turnId: "u1", agentId: "a", input: { text: "/goal x" } },
    ] as [string, unknown];
    const set = [
      ThreadEvents.goalUpdated,
      { turnId: "u1", goal: { objective: "x", status: "active" } },
    ] as [string, unknown];
    expect(reduceTimeline(events(started, set)).goal).toEqual({ objective: "x", status: "active" });
    const cleared = [ThreadEvents.goalUpdated, { turnId: "u1", goal: null }] as [string, unknown];
    expect(reduceTimeline(events(started, set, cleared)).goal).toBeUndefined();
  });
});
