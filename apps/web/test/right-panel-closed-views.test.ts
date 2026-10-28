// What "Reopen Closed Tab" keeps and picks (t3-parity.md D1641), as T3's closedViewStore.test.ts
// and reopenClosedView.test.ts check their own.
import type { RightPanelPlace } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_CLOSED_VIEWS,
  defer,
  planNextReopen,
  readClosedViews,
  remember,
  writeClosedViews,
  type ClosedView,
} from "../src/plugins/right-panel/closed-views.ts";
import { surfaceOf } from "../src/plugins/right-panel/store.ts";
import { closedTabOf, readClosedTab } from "../src/plugins/preview/surfaces.ts";

const place = (threadId: string): RightPanelPlace => ({ target: { node: "n1" }, threadId });

describe("closed views", () => {
  it("keeps the newest first, one per place and surface, at most 20", () => {
    let entries: readonly ClosedView[] = [];
    entries = remember(entries, { place: place("t1"), surface: surfaceOf("diff") }, "a");
    entries = remember(entries, { place: place("t2"), surface: surfaceOf("diff") }, "b");
    entries = remember(entries, { place: place("t1"), surface: surfaceOf("diff") }, "c");
    expect(entries.map((entry) => entry.id)).toEqual(["c", "b"]);
    for (let index = 0; index < 30; index += 1) {
      entries = remember(
        entries,
        { place: place("t1"), surface: surfaceOf("file", `f${index}`) },
        `f${index}`,
      );
    }
    expect(entries).toHaveLength(MAX_CLOSED_VIEWS);
    expect(entries[0]?.id).toBe("f29");
  });

  it("drops what is gone or open, defers what cannot reopen, and reopens the first other", () => {
    const entries: ClosedView[] = [
      { id: "gone", place: place("deleted"), surface: surfaceOf("diff") },
      { id: "open", place: place("t1"), surface: surfaceOf("diff") },
      { id: "next", place: place("t1"), surface: surfaceOf("file", "a.ts") },
      { id: "later", place: place("t2"), surface: surfaceOf("diff") },
    ];
    const plan = planNextReopen(
      entries,
      (entry) => (entry.place.threadId === "deleted" ? "gone" : "present"),
      (entry) => entry.id === "open",
    );
    expect(plan.drop).toEqual(["gone", "open"]);
    expect(plan.restore?.id).toBe("next");
    expect(defer(entries, "next").map((entry) => entry.id)).toEqual([
      "gone",
      "open",
      "later",
      "next",
    ]);
    // A place whose node's threads are not known yet is tried.
    expect(
      planNextReopen(
        entries.slice(2),
        () => "unknown",
        () => false,
      ).restore?.id,
    ).toBe("next");
  });

  it("reads back what it wrote, leaving out what is malformed", () => {
    const entries: ClosedView[] = [
      {
        id: "a",
        place: { target: { node: "n1", remote: "m" }, projectId: "p" },
        surface: surfaceOf("browser", "tab-1"),
        kept: '{"url":"http://localhost:3000/"}',
      },
    ];
    expect(readClosedViews(writeClosedViews(entries))).toEqual(entries);
    expect(
      readClosedViews(
        JSON.stringify([
          { id: "x", place: { target: { node: "n1" } }, surface: surfaceOf("diff") },
          { id: "y", place: place("t1"), surface: { id: "diff" } },
          ...entries,
        ]),
      ),
    ).toEqual(entries);
    expect(readClosedViews("not json")).toEqual([]);
    expect(readClosedViews(null)).toEqual([]);
  });

  it("keeps a browser tab's page, viewport and profile, as T3's snapshot", () => {
    const tab = {
      navStatus: { state: "success", url: "http://localhost:3000/a", title: "A" },
      viewport: { mode: "fill" },
      profileId: "work",
    } as unknown as Parameters<typeof closedTabOf>[0];
    const kept = JSON.stringify(closedTabOf(tab));
    expect(readClosedTab(kept)).toEqual({
      url: "http://localhost:3000/a",
      viewport: { mode: "fill" },
      profileId: "work",
    });
    expect(
      closedTabOf({ ...tab, navStatus: { state: "idle" }, profileId: undefined } as typeof tab),
    ).toEqual({ viewport: { mode: "fill" } });
    expect(readClosedTab("{")).toBeUndefined();
    expect(readClosedTab(undefined)).toBeUndefined();
  });
});
