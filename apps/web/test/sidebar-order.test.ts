import type { NodeTarget, ProjectRecord, ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import {
  canSnooze,
  formatWorkingDurationLabel,
  isSnoozed,
  isUnread,
  isWoke,
  projectKey,
  projectScopes,
  rowLabel,
  searchSidebarThreads,
  settledAt,
  shouldRecede,
  shownSettled,
  sidebarThreadStatus,
  sidebarThreads,
  sidebarTopStatus,
  threadSection,
  wokeAt,
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

describe("settling (D70, D446)", () => {
  it("settles nothing by itself: a thread is settled only once its node says so", () => {
    // Quiet for weeks: still active until the node's sweep writes it as settled.
    expect(settledAt(thread("t", ago(800)), NOW)).toBeUndefined();
    expect(threadSection(thread("t", ago(800)), NOW)).toBe("active");
    const swept = thread("t", ago(800), {
      lastTurn: turn("completed", ago(100)),
      settledOverride: "settled",
      settledAt: ago(100),
    });
    expect(settledAt(swept, NOW)).toBe(ago(100));
    expect(threadSection(swept, NOW)).toBe("settled");
  });
});

describe("settling by hand, and what the automatic rule leaves alone (D75)", () => {
  it("lists a thread settled by hand as of when it was settled, whatever its activity", () => {
    const settled = thread("t", ago(2), {
      lastTurn: turn("completed", ago(1)),
      settledOverride: "settled",
      settledAt: ago(0.5),
    });
    expect(settledAt(settled, NOW)).toBe(ago(0.5));
    expect(threadSection(settled, NOW)).toBe("settled");
    // A settle time that does not parse: as of the thread's activity.
    expect(settledAt({ ...settled, settledAt: "soon" }, NOW)).toBe(ago(1));
  });

  it("keeps a thread active by hand, and a pinned one, however long it was quiet", () => {
    expect(settledAt(thread("t", ago(200), { settledOverride: "active" }), NOW)).toBeUndefined();
    const pinned = thread("t", ago(200), { pinnedAt: ago(150) });
    expect(settledAt(pinned, NOW)).toBeUndefined();
    expect(threadSection(pinned, NOW)).toBe("pinned");
  });
});

describe("snoozing (D77)", () => {
  const snoozed = (extra: Partial<ThreadRecord> = {}) =>
    thread("t", ago(10), {
      lastTurn: turn("completed", ago(5)),
      snoozedAt: ago(4),
      snoozedUntil: ago(-2),
      ...extra,
    });

  it("hides a thread until its time, then wakes it", () => {
    expect(isSnoozed(snoozed(), NOW)).toBe(true);
    expect(threadSection(snoozed(), NOW)).toBe("snoozed");
    expect(wokeAt(snoozed(), NOW)).toBeUndefined();
    const later = NOW + 3 * HOUR;
    expect(isSnoozed(snoozed(), later)).toBe(false);
    expect(wokeAt(snoozed(), later)).toBe(ago(-2));
    expect(threadSection(snoozed(), later)).toBe("active");
  });

  it("wakes early when it asks for something, fails or completes after it was snoozed", () => {
    for (const lastTurn of [
      turn("waiting", ago(3), "approval"),
      turn("failed", ago(3)),
      turn("completed", ago(3)),
    ]) {
      const woke = snoozed({ lastTurn });
      expect(isSnoozed(woke, NOW)).toBe(false);
      expect(wokeAt(woke, NOW)).toBe(ago(3));
    }
    // A turn that ended before the snooze, or was stopped, does not wake it.
    expect(isSnoozed(snoozed({ lastTurn: turn("failed", ago(5)) }), NOW)).toBe(true);
    expect(isSnoozed(snoozed({ lastTurn: turn("interrupted", ago(3)) }), NOW)).toBe(true);
    expect(isSnoozed(snoozed({ lastTurn: turn("running", ago(3)) }), NOW)).toBe(true);
  });

  it("shows a snoozed thread on the Snoozed shelf first, then back where it was pinned or settled", () => {
    const later = NOW + 3 * HOUR;
    const pinned = snoozed({ pinnedAt: ago(6), pinOrderKey: "n" });
    expect(threadSection(pinned, NOW)).toBe("snoozed");
    expect(threadSection(pinned, later)).toBe("pinned");
    const settled = snoozed({ settledOverride: "settled", settledAt: ago(6) });
    expect(threadSection(settled, NOW)).toBe("snoozed");
    expect(threadSection(settled, later)).toBe("settled");
  });

  it("refuses to snooze a thread waiting for an answer", () => {
    expect(
      canSnooze(thread("t", ago(1), { lastTurn: turn("waiting", ago(1), "user-input") })),
    ).toBe(false);
    expect(canSnooze(thread("t", ago(1), { lastTurn: turn("running", ago(1)) }))).toBe(true);
  });

  it("says Woke until a visit after the wake, and not on a thread settled by hand", () => {
    const woke = snoozed({ lastTurn: turn("completed", ago(3)) });
    expect(isWoke(woke, undefined, NOW)).toBe(true);
    expect(isWoke(woke, ago(3.5), NOW)).toBe(true);
    expect(isWoke(woke, ago(3), NOW)).toBe(false);
    expect(isWoke({ ...woke, settledOverride: "settled" }, undefined, NOW)).toBe(false);
    expect(sidebarTopStatus("ready", true, true)).toBe("woke");
    expect(sidebarTopStatus("failed", false, true)).toBe("failed");
    expect(shouldRecede({ status: "ready", unread: false, active: false, woke: true })).toBe(false);
  });
});

describe("accessible names (D71)", () => {
  it("names a row as T3 does, and its node only while several nodes are shown", () => {
    expect(rowLabel(["fix it", null, "web"], undefined)).toBe("fix it, web");
    expect(rowLabel(["fix it", "Done", "web"], "studio")).toBe("fix it, Done, web on studio");
    // Two projects called "web" on two nodes read apart.
    expect(rowLabel(["web"], "a")).not.toBe(rowLabel(["web"], "b"));
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
      thread("settled-later", ago(300), {
        projectId: "web",
        lastTurn: turn("completed", ago(90)),
        settledOverride: "settled",
        settledAt: ago(90),
      }),
      thread("archived", ago(1), { archivedAt: ago(0.5) }),
    ],
  );
  const b = node(
    { node: "a", remote: "b" },
    [scratch, project("web", "web")],
    [
      thread("middle", ago(10), { projectId: "web" }),
      thread("settled-earlier", ago(400), {
        projectId: "web",
        settledOverride: "settled",
        settledAt: ago(400),
      }),
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

  it("puts pinned threads on top in their order and a thread back from the shelf on top of the active ones", () => {
    const c = node(
      { node: "c" },
      [scratch],
      [
        thread("pinned-b", ago(50), { pinnedAt: ago(1), pinOrderKey: "n" }),
        thread("pinned-a", ago(40), { pinnedAt: ago(1), pinOrderKey: "c" }),
        thread("pinned-unkeyed", ago(30), { pinnedAt: ago(1) }),
        thread("fresh", ago(5)),
        thread("returned", ago(60), { unsettledAt: ago(1) }),
        thread("dragged", ago(0.5), { activeOrderKey: "m" }),
        thread("snoozed-late", ago(20), { snoozedUntil: ago(-5), snoozedAt: ago(1) }),
        thread("snoozed-soon", ago(20), { snoozedUntil: ago(-1), snoozedAt: ago(1) }),
      ],
    );
    const lists = sidebarThreads([c], { nowMs: NOW });
    expect(ids(lists.pinned)).toEqual(["pinned-a", "pinned-b", "pinned-unkeyed"]);
    // Never dragged first, newest by creation or return; then the dragged ones by key.
    expect(ids(lists.active)).toEqual(["returned", "fresh", "dragged"]);
    expect(ids(lists.snoozed)).toEqual(["snoozed-soon", "snoozed-late"]);
    expect(lists.active.map((entry) => entry.section)).toEqual(["active", "active", "active"]);
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
