// Cases follow T3 Code's apps/server/src/scheduledTasks/Schedule.test.ts
// (v0.1.1-nightly.20261020.3411), in the node's local time zone.
import { describe, expect, it } from "vite-plus/test";

import {
  CreateTaskInput,
  describeSchedule,
  isMissedFixedTimeRun,
  isSameSchedule,
  nextRunAfter,
  parseTimeOfDay,
} from "../src/index.ts";

/** A local time: Monday 2026-10-19 is weekday 1. */
const local = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, day, hour, minute, second);

describe("@jhin/scheduler-api: schedules", () => {
  it("reads HH:MM times of day", () => {
    expect(parseTimeOfDay("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay(" 23:59 ")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("9:5")).toBeNull();
  });

  it("counts an interval from the given time, never under a minute", () => {
    const from = local(19, 10, 0, 30);
    expect(nextRunAfter({ type: "interval", everyMs: 3_600_000 }, from)).toEqual(
      local(19, 11, 0, 30),
    );
    // A stored interval below the floor runs no faster than once a minute.
    expect(nextRunAfter({ type: "interval", everyMs: 1000 }, from)).toEqual(local(19, 10, 1, 30));
  });

  it("finds the next matching minute of a fixed time, today or on a chosen weekday", () => {
    const daily = { type: "fixed_time", timeOfDay: "09:00" } as const;
    expect(nextRunAfter(daily, local(19, 8, 59))).toEqual(local(19, 9));
    // The minute itself has passed: tomorrow.
    expect(nextRunAfter(daily, local(19, 9))).toEqual(local(20, 9));
    const weekdays = { ...daily, weekdays: [1, 2, 3, 4, 5] };
    // Friday after nine: Monday.
    expect(nextRunAfter(weekdays, local(23, 10))).toEqual(local(26, 9));
    const sunday = { ...daily, weekdays: [0] };
    expect(nextRunAfter(sunday, local(19, 10))).toEqual(local(25, 9));
    expect(nextRunAfter({ type: "webhook", signature: null }, local(19, 10))).toBeNull();
  });

  it("calls a fixed-time run missed past ten minutes, never an interval", () => {
    const fixed = { type: "fixed_time", timeOfDay: "09:00" } as const;
    expect(isMissedFixedTimeRun(fixed, local(19, 9), local(19, 9, 10))).toBe(false);
    expect(isMissedFixedTimeRun(fixed, local(19, 9), local(19, 9, 10, 1))).toBe(true);
    expect(
      isMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, local(19, 9), local(20, 9)),
    ).toBe(false);
  });

  it("compares schedules by when they fire", () => {
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "9:00", weekdays: [5, 1, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5] },
      ),
    ).toBe(true);
    // No weekdays and all seven are both every day.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 120_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "webhook", signature: null },
        { type: "webhook", signature: { header: "x-sig", encoding: "hex", prefix: "" } },
      ),
    ).toBe(true);
  });

  it("describes a schedule as T3 does", () => {
    expect(describeSchedule({ type: "interval", everyMs: 60_000 })).toBe("Every minute");
    expect(describeSchedule({ type: "interval", everyMs: 300_000 })).toBe("Every 5 minutes");
    expect(
      describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }),
    ).toBe("At 09:00 every weekday");
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "18:30" })).toBe("At 18:30 every day");
    expect(describeSchedule({ type: "webhook", signature: null })).toBe("On webhook");
  });

  it("refuses intervals under a minute and malformed times", () => {
    const base = { prompt: "Check the build" };
    expect(
      CreateTaskInput.safeParse({ ...base, schedule: { type: "interval", everyMs: 59_999 } })
        .success,
    ).toBe(false);
    expect(
      CreateTaskInput.safeParse({ ...base, schedule: { type: "fixed_time", timeOfDay: "25:00" } })
        .success,
    ).toBe(false);
    expect(
      CreateTaskInput.parse({ ...base, schedule: { type: "interval", everyMs: 60_000 } }),
    ).toMatchObject({ enabled: true });
  });
});
