import type { NodeTarget, ProjectRecord, ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import {
  formatWorkingDurationLabel,
  isUnread,
  projectKey,
  projectScopes,
  searchSidebarThreads,
  settledAt,
  shouldRecede,
  shownSettled,
  sidebarThreadStatus,
  sidebarThreads,
  sidebarTopStatus,
} from "../src/lib/sidebar-order.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const thread = (
  id: string,
  createdAt: string,
  extra: Partial<ThreadRecord> = {},
): ThreadRecord => ({
  id,
  projectId: "p",
  title: id,
  createdAt,
  ...extra,
});

const turn = (
  status: NonNullable<ThreadRecord["lastTurn"]>["status"],
  at: string,
  waitingFor?: "approval" | "user-input",
): NonNullable<ThreadRecord["lastTurn"]> => ({
  turnId: "u",
  status,
  at,
  agentId: "jhin.agent-fake",
  ...(waitingFor === undefined ? {} : { waitingFor }),
});

const project = (id: string, name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id,
  name,
  path: `/work/${name}`,
  scratch: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...extra,
});

const node = (
  target: NodeTarget,
  projects: readonly ProjectRecord[],
  threads: readonly ThreadRecord[] = [],
) => ({ target, catalog: { projects, threads } });

const ids = (entries: readonly { thread: ThreadRecord }[]) =>
  entries.map((entry) => entry.thread.id);

describe("a thread's status in the sidebar (D70)", () => {
  it("says what a turn waits for, that it works or failed, else that it is ready", () => {
    expect(
      sidebarThreadStatus(thread("t", ago(1), { lastTurn: turn("waiting", ago(1), "approval") })),
    ).toBe("approval");
    expect(
      sidebarThreadStatus(thread("t", ago(1), { lastTurn: turn("waiting", ago(1), "user-input") })),
    ).toBe("input");
    expect(sidebarThreadStatus(thread("t", ago(1), { lastTurn: turn("running", ago(1)) }))).toBe(
      "working",
    );
    expect(sidebarThreadStatus(thread("t", ago(1), { lastTurn: turn("failed", ago(1)) }))).toBe(
      "failed",
    );
    expect(
      sidebarThreadStatus(thread("t", ago(1), { lastTurn: turn("interrupted", ago(1)) })),
    ).toBe("ready");
    expect(sidebarThreadStatus(thread("t", ago(1)))).toBe("ready");
  });

  it("shows Done for a turn completed since the last visit, as T3's top status", () => {
    const done = thread("t", ago(2), { lastTurn: turn("completed", ago(1)) });
    expect(isUnread(done, ago(1.5))).toBe(true);
    expect(isUnread(done, ago(0.5))).toBe(false);
    // Never opened on this device: nothing old shows as new.
    expect(isUnread(done, undefined)).toBe(false);
    expect(sidebarTopStatus("ready", true)).toBe("done");
    expect(sidebarTopStatus("ready", false)).toBeNull();
    expect(sidebarTopStatus("working", false)).toBe("working");
  });

  it("fades a thread that needs nothing from the user", () => {
    expect(shouldRecede({ status: "ready", unread: false, active: false })).toBe(true);
    expect(shouldRecede({ status: "ready", unread: true, active: false })).toBe(false);
    expect(shouldRecede({ status: "working", unread: false, active: false })).toBe(true);
    expect(shouldRecede({ status: "input", unread: false, active: false })).toBe(false);
    expect(shouldRecede({ status: "failed", unread: false, active: false })).toBe(false);
    expect(shouldRecede({ status: "ready", unread: false, active: true })).toBe(false);
  });

  it("counts a working turn as T3 does", () => {
    expect(formatWorkingDurationLabel(45_000)).toBe("45s");
    expect(formatWorkingDurationLabel(12 * 60_000)).toBe("12m");
    expect(formatWorkingDurationLabel(65 * 60_000)).toBe("1h 5m");
  });
});

describe("settling (D71)", () => {
  it("settles a thread after three days without activity, as of its last activity", () => {
    expect(settledAt(thread("t", ago(80)), NOW)).toBe(ago(80));
    expect(settledAt(thread("t", ago(70)), NOW)).toBeUndefined();
    expect(
      settledAt(thread("t", ago(200), { lastTurn: turn("completed", ago(10)) }), NOW),
    ).toBeUndefined();
    expect(settledAt(thread("t", ago(200), { lastTurn: turn("completed", ago(100)) }), NOW)).toBe(
      ago(100),
    );
  });

  it("never settles a thread whose turn runs or waits for the user", () => {
    expect(
      settledAt(thread("t", ago(200), { lastTurn: turn("running", ago(100)) }), NOW),
    ).toBeUndefined();
    expect(
      settledAt(thread("t", ago(200), { lastTurn: turn("waiting", ago(100), "approval") }), NOW),
    ).toBeUndefined();
  });
});

describe("the sidebar's list (D70)", () => {
  const scratch = project("scratch", "No project", { scratch: true });
  const a = node(
    { node: "a" },
    [scratch, project("web", "web")],
    [
      thread("old-active", ago(30), { projectId: "web", lastTurn: turn("completed", ago(1)) }),
      thread("new", ago(2), { projectId: "scratch" }),
      thread("settled-later", ago(300), { projectId: "web", lastTurn: turn("completed", ago(90)) }),
      thread("archived", ago(1), { archivedAt: ago(0.5) }),
    ],
  );
  const b = node(
    { node: "a", remote: "b" },
    [scratch, project("web", "web")],
    [
      thread("middle", ago(10), { projectId: "web" }),
      thread("settled-earlier", ago(400), { projectId: "web" }),
    ],
  );

  it("lists every node's threads in one list: active newest-created first, then settled", () => {
    const { active, settled } = sidebarThreads([a, b], { nowMs: NOW });
    // Created order, not activity: "old-active" moved an hour ago but was created first.
    expect(ids(active)).toEqual(["new", "middle", "old-active"]);
    expect(ids(settled)).toEqual(["settled-later", "settled-earlier"]);
    expect(active.map((entry) => entry.key)).toEqual(["a|new", "a|b|middle", "a|old-active"]);
    expect(active.map((entry) => entry.project?.name)).toEqual(["No project", "web", "web"]);
  });

  it("narrows to one project of one node", () => {
    const { active, settled } = sidebarThreads([a, b], {
      nowMs: NOW,
      scope: projectKey({ node: "a", remote: "b" }, "web"),
    });
    expect(ids(active)).toEqual(["middle"]);
    expect(ids(settled)).toEqual(["settled-earlier"]);
  });

  it("lists every project as a filter choice, same names apart by node", () => {
    expect(projectScopes([a, b]).map((item) => item.key)).toEqual([
      "a|b|scratch",
      "a|scratch",
      "a|b|web",
      "a|web",
    ]);
  });

  it("shows the first settled threads, more on demand, and the open one wherever it is", () => {
    const settled = ["s1", "s2", "s3", "s4"].map((key) => ({ key }));
    const keys = (list: readonly { key: string }[]) => list.map((item) => item.key);
    expect(keys(shownSettled(settled, { count: 2, expanded: true }).shown)).toEqual(["s1", "s2"]);
    expect(shownSettled(settled, { count: 2, expanded: true }).hidden).toBe(2);
    expect(keys(shownSettled(settled, { count: 2, expanded: true, current: "s4" }).shown)).toEqual([
      "s1",
      "s2",
      "s4",
    ]);
    // Collapsed: only the open thread stays in sight.
    expect(keys(shownSettled(settled, { count: 2, expanded: false, current: "s4" }).shown)).toEqual(
      ["s4"],
    );
    expect(keys(shownSettled(settled, { count: 2, expanded: false }).shown)).toEqual([]);
  });

  it("searches titles across active and settled threads", () => {
    const { active, settled } = sidebarThreads([a, b], { nowMs: NOW });
    expect(ids(searchSidebarThreads([...active, ...settled], " SETTLED "))).toEqual([
      "settled-later",
      "settled-earlier",
    ]);
    expect(searchSidebarThreads(active, "  ")).toEqual([]);
  });
});
