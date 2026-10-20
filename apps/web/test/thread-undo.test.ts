import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createThreadUndo, undoNoticeText, UNDO_NOTICE_MS } from "../src/lib/thread-undo.ts";

afterEach(() => {
  vi.useRealTimers();
});

function store() {
  const failures: string[] = [];
  const undo = createThreadUndo({ fail: (title) => failures.push(title) });
  const undone: string[] = [];
  const act = (kind: string, thread: string, action: "Unpinned" | "Settled" | "Snoozed") => {
    const claim = undo.begin(kind, thread);
    undo.show({
      action,
      claim,
      failureTitle: `Failed to undo ${kind}`,
      undo: async () => {
        undone.push(`${kind} ${thread}`);
      },
    });
    return claim;
  };
  return { undo, undone, failures, act };
}

describe("undoing thread actions (D450)", () => {
  it("says what was done, grouping the latest run of one action", () => {
    const { undo, act } = store();
    act("pin", "a", "Unpinned");
    expect(undoNoticeText(undo.notice()!)).toBe("Unpinned 1 thread");
    act("pin", "b", "Unpinned");
    expect(undoNoticeText(undo.notice()!)).toBe("Unpinned 2 threads");
    act("settle", "c", "Settled");
    expect(undoNoticeText(undo.notice()!)).toBe("Settled 1 thread");
    expect(undoNoticeText({ action: "Discarded", count: 2 })).toBe("Discarded 2 drafts");
  });

  it("undoes the whole group once, and the run before it next", async () => {
    const { undo, undone, act } = store();
    act("pin", "a", "Unpinned");
    act("settle", "b", "Settled");
    act("settle", "c", "Settled");
    expect(undo.undoLatest()).toBe(true);
    await Promise.resolve();
    expect(undone.toSorted()).toEqual(["settle b", "settle c"]);
    // The earlier action is offered now; a second undo of the settles restores nothing twice.
    expect(undo.notice()).toEqual({ action: "Unpinned", count: 1 });
    expect(undo.undoLatest()).toBe(true);
    await Promise.resolve();
    expect(undone).toContain("pin a");
    expect(undo.notice()).toBeUndefined();
    expect(undo.undoLatest()).toBe(false);
  });

  it("expires five seconds after the latest action", () => {
    vi.useFakeTimers();
    const { undo, act } = store();
    act("pin", "a", "Unpinned");
    vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    act("pin", "b", "Unpinned");
    vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    expect(undo.notice()).toEqual({ action: "Unpinned", count: 2 });
    vi.advanceTimersByTime(1);
    expect(undo.notice()).toBeUndefined();
    expect(undo.undoLatest()).toBe(false);
  });

  it("drops an undo the opposite action made void", () => {
    const { undo, act } = store();
    act("pin", "a", "Unpinned");
    // Pinned again by hand: undoing the unpin has nothing left to do.
    undo.invalidate("pin", "a");
    expect(undo.notice()).toBeUndefined();
  });

  it("offers nothing for an action whose claim a later one took", () => {
    const { undo } = store();
    const first = undo.begin("pin", "a");
    undo.begin("pin", "a");
    undo.show({ action: "Unpinned", claim: first, failureTitle: "x", undo: async () => {} });
    expect(undo.notice()).toBeUndefined();
  });

  it("says why an undo failed", async () => {
    let failed!: (title: string) => void;
    const reported = new Promise<string>((resolve) => (failed = resolve));
    const undo = createThreadUndo({ fail: (title) => failed(title) });
    const claim = undo.begin("pin", "a");
    undo.show({
      action: "Unpinned",
      claim,
      failureTitle: "Failed to undo unpin",
      undo: () => Promise.reject(new Error("node gone")),
    });
    undo.undoLatest();
    expect(await reported).toBe("Failed to undo unpin");
  });
});
