// The Lineage section of the thread details panel (docs/plans/t3-parity.md, D802).
import type { ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { forkRan } from "../src/lib/forks.ts";
import { lineageRows, lineageStatusLabel } from "../src/plugins/chat/lineage.tsx";

const thread = (id: string, createdAt: string, more: Partial<ThreadRecord> = {}) =>
  ({ id, title: id, createdAt, updatedAt: createdAt, ...more }) as ThreadRecord;

describe("lineageRows", () => {
  it("puts the parent first, then the forks newest first, as T3 orders them", () => {
    const parent = thread("parent", "2026-01-01T00:00:00Z");
    const current = thread("current", "2026-01-02T00:00:00Z", {
      forkedFrom: { threadId: "parent", turnId: "t1" },
    });
    const older = thread("older", "2026-01-03T00:00:00Z", {
      forkedFrom: { threadId: "current", turnId: "t2" },
    });
    const newer = thread("newer", "2026-01-04T00:00:00Z", {
      forkedFrom: { threadId: "current", turnId: "t2" },
    });
    const unrelated = thread("unrelated", "2026-01-05T00:00:00Z");
    const rows = lineageRows(current, [parent, current, older, newer, unrelated]);
    expect(rows.map((row) => [row.relationship, row.threadId])).toEqual([
      ["parent", "parent"],
      ["fork", "newer"],
      ["fork", "older"],
    ]);
  });

  it("keeps a parent its node no longer has, without its record", () => {
    const current = thread("current", "2026-01-02T00:00:00Z", {
      forkedFrom: { threadId: "gone", turnId: "t1" },
    });
    expect(lineageRows(current, [current])).toEqual([
      { threadId: "gone", relationship: "parent", thread: undefined },
    ]);
  });

  it("orders forks made at the same moment by id", () => {
    const current = thread("current", "2026-01-01T00:00:00Z");
    const at = "2026-01-02T00:00:00Z";
    const fork = (id: string) =>
      thread(id, at, { forkedFrom: { threadId: "current", turnId: "t" } });
    const rows = lineageRows(current, [current, fork("b"), fork("c"), fork("a")]);
    expect(rows.map((row) => row.threadId)).toEqual(["a", "b", "c"]);
  });

  it("has no rows for a thread without a parent or forks", () => {
    const alone = thread("alone", "2026-01-01T00:00:00Z");
    expect(lineageRows(alone, [alone])).toEqual([]);
  });
});

describe("lineageStatusLabel", () => {
  it("says the latest turn's status in T3's words", () => {
    const at = (status: NonNullable<ThreadRecord["lastTurn"]>["status"]) =>
      thread("t", "2026-01-01T00:00:00Z", {
        lastTurn: { turnId: "x", status, at: "2026-01-01T00:00:00Z", agentId: "fake" },
      });
    expect(lineageStatusLabel(thread("t", "2026-01-01T00:00:00Z"))).toBe("Idle");
    expect(lineageStatusLabel(at("running"))).toBe("Running");
    expect(lineageStatusLabel(at("waiting"))).toBe("Waiting");
    expect(lineageStatusLabel(at("completed"))).toBe("Done");
    expect(lineageStatusLabel(at("interrupted"))).toBe("Stopped");
    expect(lineageStatusLabel(at("failed"))).toBe("Failed");
  });
});

describe("forkRan", () => {
  it("lets a fork merge back once its latest turn ended, however it ended", () => {
    const at = (status?: NonNullable<ThreadRecord["lastTurn"]>["status"]) =>
      thread(
        "f",
        "2026-01-01T00:00:00Z",
        status === undefined
          ? {}
          : { lastTurn: { turnId: "x", status, at: "2026-01-01T00:00:00Z", agentId: "fake" } },
      );
    expect(forkRan(at())).toBe(false);
    expect(forkRan(at("running"))).toBe(false);
    expect(forkRan(at("waiting"))).toBe(false);
    expect(forkRan(at("completed"))).toBe(true);
    expect(forkRan(at("interrupted"))).toBe(true);
    expect(forkRan(at("failed"))).toBe(true);
  });
});
