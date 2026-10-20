import type { ScheduledTask } from "@jhin/scheduler-api";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_DRAFT,
  draftProblem,
  relativeLabel,
  scheduleFromDraft,
  scheduleLabel,
  taskToDraft,
} from "../src/plugins/scheduler/labels.ts";

const task = (schedule: ScheduledTask["schedule"]): ScheduledTask => ({
  id: "t1",
  title: "Task",
  prompt: "Do it",
  enabled: true,
  schedule,
  projectId: "scratch",
  threadId: null,
  createdAt: "",
  updatedAt: "",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  lastRunThreadId: null,
  runCount: 0,
});

describe("scheduled task labels (T3's wording)", () => {
  it("reads schedules", () => {
    expect(scheduleLabel({ type: "interval", everyMs: 300_000 })).toBe("Every 5 min");
    expect(scheduleLabel({ type: "interval", everyMs: 30_000 })).toBe("Every 30 sec");
    expect(scheduleLabel({ type: "fixed_time", timeOfDay: "09:00" })).toBe("Daily at 09:00");
    expect(
      scheduleLabel({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }),
    ).toBe("Weekdays at 09:00");
    expect(scheduleLabel({ type: "fixed_time", timeOfDay: "18:30", weekdays: [0, 6] })).toBe(
      "Sun, Sat at 18:30",
    );
    expect(scheduleLabel({ type: "webhook", signature: null })).toBe("On webhook");
  });

  it("reads upcoming and past runs", () => {
    const now = Date.parse("2026-10-19T10:00:00.000Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(relativeLabel(null, now)).toBe("Not scheduled");
    expect(relativeLabel(at(30_000), now)).toBe("in under a minute");
    expect(relativeLabel(at(5 * 60_000), now)).toBe("in 5m");
    expect(relativeLabel(at(3 * 3_600_000), now)).toBe("in 3h");
    expect(relativeLabel(at(2 * 86_400_000), now)).toBe("in 2d");
    expect(relativeLabel(at(-10_000), now)).toBe("just now");
    expect(relativeLabel(at(-5 * 60_000), now)).toBe("5m ago");
  });
});

describe("the editor's draft", () => {
  it("round-trips every trigger", () => {
    const schedules: ScheduledTask["schedule"][] = [
      { type: "interval", everyMs: 900_000 },
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3, 5] },
      { type: "fixed_time", timeOfDay: "07:30" },
      { type: "webhook", signature: null },
      { type: "webhook", signature: { header: "x-sig", encoding: "base64", prefix: "" } },
    ];
    for (const schedule of schedules) {
      expect(scheduleFromDraft(taskToDraft(task(schedule)))).toEqual(schedule);
    }
  });

  it("sends a new secret only when one was typed", () => {
    const draft = {
      ...EMPTY_DRAFT,
      scheduleMode: "webhook" as const,
      signatureEnabled: true,
      signatureSecret: " s3cret ",
    };
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature: {
        header: "x-hub-signature-256",
        encoding: "hex",
        prefix: "sha256=",
        secret: "s3cret",
      },
    });
  });

  it("keeps an interval under a minute as it is, so saving refuses it instead of changing it", () => {
    const draft = taskToDraft(task({ type: "interval", everyMs: 30_000 }));
    expect(draft.intervalMinutes).toBe("0.5");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 30_000 });
  });
});

describe("what the editor refuses to save", () => {
  const ready = { ...EMPTY_DRAFT, title: "Check", prompt: "Check the build" };
  const context = { hasProject: true, hasSecret: false };

  it("needs a title, a prompt, and a project for a new task (not for an edit)", () => {
    expect(draftProblem(ready, context)).toBeNull();
    expect(draftProblem({ ...ready, title: " " }, context)?.title).toBe(
      "Scheduled task is incomplete",
    );
    expect(draftProblem(ready, { ...context, hasProject: false })?.title).toBe(
      "Scheduled task is incomplete",
    );
    expect(
      draftProblem({ ...ready, editingId: "t1" }, { ...context, hasProject: false }),
    ).toBeNull();
  });

  it("needs a signing secret, unless the node keeps one", () => {
    const signed = { ...ready, scheduleMode: "webhook" as const, signatureEnabled: true };
    expect(draftProblem(signed, context)?.title).toBe("Signing secret is required");
    expect(draftProblem(signed, { ...context, hasSecret: true })).toBeNull();
    expect(draftProblem({ ...signed, signatureSecret: "s" }, context)).toBeNull();
    expect(
      draftProblem({ ...signed, signatureSecret: "s", signatureHeader: " " }, context)?.title,
    ).toBe("Signing secret is required");
  });

  it("refuses an interval under a minute, or one that is not a number", () => {
    const every = (minutes: string) => ({
      ...ready,
      scheduleMode: "interval" as const,
      intervalMinutes: minutes,
    });
    expect(draftProblem(every("1"), context)).toBeNull();
    expect(draftProblem(every("0.5"), context)?.title).toBe("Invalid interval");
    expect(draftProblem(every("soon"), context)?.title).toBe("Invalid interval");
  });
});
