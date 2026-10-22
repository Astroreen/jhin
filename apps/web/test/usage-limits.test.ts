import { ThreadEvents, type AgentUsageWindow } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { reduceTimeline } from "../src/lib/timeline.ts";
import {
  formatResetsIn,
  formatUpcomingTimestamp,
  isUsageLimitsCommand,
  limitsNotice,
  paceOf,
  remainingPercent,
  usageLimitFailureLabel,
} from "../src/lib/usage-limits.ts";

const now = new Date(2030, 0, 1, 10, 0).getTime();
const window = (extra: Partial<AgentUsageWindow> = {}): AgentUsageWindow => ({
  id: "primary",
  kind: "session",
  label: "Session",
  usedPercent: 25,
  windowDurationMins: 300,
  resetsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
  ...extra,
});

describe("usage limits (providers.md D1144)", () => {
  it("answers /usage-limits only when it is sent alone", () => {
    expect(isUsageLimitsCommand("  /Usage-Limits ")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits now")).toBe(false);
  });

  it("shows what is left, when it resets and the pace, as T3", () => {
    expect(remainingPercent(window({ usedPercent: 42.4 }))).toBe(58);
    expect(formatResetsIn(window(), now)).toBe("resets in 2h 0m");
    expect(formatResetsIn(window({ resetsAt: new Date(now + 30_000).toISOString() }), now)).toBe(
      "Resets momentarily",
    );
    // 3 of 5 hours elapsed: 25% used is under pace, 90% ahead of it.
    expect(paceOf(window(), now)).toBe("under");
    expect(paceOf(window({ usedPercent: 90 }), now)).toBe("ahead");
    const { windowDurationMins: _unknown, ...noDuration } = window();
    expect(paceOf(noDuration, now)).toBeNull();
  });

  it("says why there are no windows", () => {
    const checkedAt = new Date(now).toISOString();
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex did not answer the usage request." },
      }),
    ).toBe("Codex did not answer the usage request.");
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [window()] })).toBeNull();
  });

  it("names the day of an upcoming time and labels the failure", () => {
    const tomorrow = new Date(2030, 0, 2, 9, 30).toISOString();
    expect(formatUpcomingTimestamp(tomorrow, "24-hour", now)).toBe("tomorrow at 09:30");
    expect(usageLimitFailureLabel(tomorrow, "24-hour", now)).toBe(
      "Usage limit reached. Retry after tomorrow at 09:30.",
    );
    expect(usageLimitFailureLabel(undefined, "24-hour", now)).toBe("Usage limit reached.");
  });

  it("keeps a turn's usage-limit failure in the timeline", () => {
    const events: StoredEvent[] = [
      [ThreadEvents.turnStarted, { turnId: "u1", agentId: "fake", input: { text: "hi" } }],
      [
        ThreadEvents.turnFailed,
        {
          turnId: "u1",
          error: "UsageLimitError: limit",
          failure: { class: "usage_limit", resetAt: "2030-01-01T12:00:00.000Z" },
        },
      ],
    ].map(([type, payload], index) => ({
      stream: "thread/t1",
      sequence: index + 1,
      type: type as string,
      payload: payload as StoredEvent["payload"],
      at: new Date(now + index * 1000).toISOString(),
    }));
    expect(reduceTimeline(events).turns[0]).toMatchObject({
      state: "failed",
      failure: { class: "usage_limit", resetAt: "2030-01-01T12:00:00.000Z" },
    });
  });
});
