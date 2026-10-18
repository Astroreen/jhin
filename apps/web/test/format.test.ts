import { describe, expect, it } from "vite-plus/test";

import {
  formatCompactRelativeTime,
  formatDayAwareTimestamp,
  formatDuration,
  formatRelativeTimeLabel,
  formatTokens,
  formatWorkingTimer,
} from "../src/lib/format.ts";

describe("formatDuration", () => {
  it("picks the unit after rounding", () => {
    expect(formatDuration(0.2)).toBe("1ms");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(4_240)).toBe("4.2s");
    expect(formatDuration(9_960)).toBe("10s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(59_600)).toBe("1m");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(7_380_000)).toBe("2h 3m");
  });

  it("treats nonsense as zero", () => {
    expect(formatDuration(-5)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
  });
});

describe("relative times", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("says how long ago, coarsely", () => {
    expect(formatRelativeTimeLabel(ago(30_000), now)).toBe("just now");
    expect(formatRelativeTimeLabel(ago(5 * 60_000), now)).toBe("5m ago");
    expect(formatRelativeTimeLabel(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(formatRelativeTimeLabel(ago(2 * 86_400_000), now)).toBe("2d ago");
    expect(formatRelativeTimeLabel("not a date", now)).toBe("");
  });

  it("has a compact form for dense rows", () => {
    expect(formatCompactRelativeTime(ago(1_000), now)).toBe("now");
    expect(formatCompactRelativeTime(ago(5 * 60_000), now)).toBe("5m");
  });

  it("counts a working turn in seconds, then as a duration", () => {
    expect(formatWorkingTimer(ago(12_400), now)).toBe("12s");
    expect(formatWorkingTimer(ago(125_000), now)).toBe("2m 5s");
    expect(formatWorkingTimer(ago(-1_000), now)).toBe("0s");
  });

  it("names yesterday and dates older than that", () => {
    const today = new Date(2026, 9, 18, 15, 30);
    const yesterday = new Date(2026, 9, 17, 9, 0).toISOString();
    expect(formatDayAwareTimestamp(yesterday, "24-hour", today.getTime())).toMatch(
      /^yesterday at /,
    );
    const lastWeek = new Date(2026, 9, 11, 9, 0).toISOString();
    expect(formatDayAwareTimestamp(lastWeek, "24-hour", today.getTime())).not.toMatch(/^yesterday/);
    expect(formatDayAwareTimestamp(lastWeek, "24-hour", today.getTime())).toContain("11");
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_250)).toBe("1.3k");
    expect(formatTokens(76_400)).toBe("76k");
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(1_200_000)).toBe("1.2m");
  });
});
