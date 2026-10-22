import { describe, expect, it } from "vite-plus/test";

import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  snoozePresets,
  snoozeWakeLabel,
} from "../src/lib/snooze.ts";

const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0);

describe("snooze presets (D77)", () => {
  it("offers T3's presets: this evening only while more than an hour away", () => {
    // A Wednesday afternoon.
    const ids = snoozePresets(local(2026, 10, 21, 14)).map((preset) => preset.id);
    expect(ids).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
    expect(snoozePresets(local(2026, 10, 21, 17, 30)).map((preset) => preset.id)).not.toContain(
      "evening",
    );
  });

  it("wakes tomorrow and next week at nine, and drops next week when it is tomorrow", () => {
    const presets = snoozePresets(local(2026, 10, 21, 14));
    expect(new Date(presets.find((p) => p.id === "tomorrow")!.snoozedUntil)).toEqual(
      local(2026, 10, 22, 9),
    );
    expect(new Date(presets.find((p) => p.id === "next-week")!.snoozedUntil)).toEqual(
      local(2026, 10, 26, 9),
    );
    // On a Sunday, next Monday is tomorrow.
    expect(snoozePresets(local(2026, 10, 25, 14)).map((preset) => preset.id)).not.toContain(
      "next-week",
    );
  });

  it("labels the time left as the snoozed row shows it", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(snoozeWakeLabel("2026-10-19T12:20:00Z", now)).toBe("20m");
    expect(snoozeWakeLabel("2026-10-19T15:00:00Z", now)).toBe("3h");
    expect(snoozeWakeLabel("2026-10-21T13:00:00Z", now)).toBe("3d");
    expect(snoozeWakeLabel("2026-10-19T11:00:00Z", now)).toBe("now");
    expect(snoozeWakeLabel("soon", now)).toBe("now");
  });
});

describe("a custom snooze (D77)", () => {
  const now = local(2026, 10, 21, 14);

  it("takes a duration or a local date and time in the future", () => {
    expect(resolveCustomSnooze({ mode: "duration", amount: "2", unit: "hours" }, now)).toBe(
      local(2026, 10, 21, 16).toISOString(),
    );
    expect(resolveCustomSnooze({ mode: "date", date: "2026-10-23", time: "08:30" }, now)).toBe(
      local(2026, 10, 23, 8, 30).toISOString(),
    );
    expect(localSnoozeDate(now)).toBe("2026-10-21");
    expect(localSnoozeTime(now)).toBe("14:00");
  });

  it("refuses the past, nonsense and dates that roll over", () => {
    expect(resolveCustomSnooze({ mode: "duration", amount: "0", unit: "hours" }, now)).toBeNull();
    expect(resolveCustomSnooze({ mode: "duration", amount: "x", unit: "days" }, now)).toBeNull();
    expect(
      resolveCustomSnooze({ mode: "date", date: "2026-10-20", time: "09:00" }, now),
    ).toBeNull();
    expect(
      resolveCustomSnooze({ mode: "date", date: "2026-02-30", time: "09:00" }, now),
    ).toBeNull();
    expect(resolveCustomSnooze({ mode: "date", date: "tomorrow", time: "09:00" }, now)).toBeNull();
  });
});
