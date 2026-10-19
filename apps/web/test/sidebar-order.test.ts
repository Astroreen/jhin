import type { ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { listedThreads, shownThreads } from "../src/lib/sidebar-order.ts";

const thread = (id: string, at: string, extra: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id,
  projectId: "p",
  title: id,
  createdAt: at,
  ...extra,
});

const ids = (threads: readonly ThreadRecord[]) => threads.map((item) => item.id);

describe("the sidebar's threads", () => {
  const listed = listedThreads(
    [
      thread("old", "2026-10-18T09:00:00.000Z"),
      thread("archived", "2026-10-18T12:00:00.000Z", { archivedAt: "2026-10-18T12:30:00.000Z" }),
      thread("other-project", "2026-10-18T12:00:00.000Z", { projectId: "q" }),
      thread("busy", "2026-10-18T08:00:00.000Z", {
        lastTurn: {
          turnId: "u",
          status: "running",
          at: "2026-10-18T11:00:00.000Z",
          agentId: "fake",
        },
      }),
      thread("new", "2026-10-18T10:00:00.000Z"),
    ],
    "p",
  );

  it("lists a project's threads by their latest activity, without archived ones", () => {
    expect(ids(listed)).toEqual(["busy", "new", "old"]);
  });

  it("shows the first few, all on demand, and the open thread wherever it is", () => {
    expect(ids(shownThreads(listed, { query: "", limit: 2, showAll: false }).shown)).toEqual([
      "busy",
      "new",
    ]);
    expect(ids(shownThreads(listed, { query: "", limit: 2, showAll: true }).shown)).toEqual([
      "busy",
      "new",
      "old",
    ]);
    expect(
      ids(shownThreads(listed, { query: "", limit: 2, showAll: false, current: "old" }).shown),
    ).toEqual(["busy", "new", "old"]);
  });

  it("shows every match of a search, whatever the limit", () => {
    const search = shownThreads(listed, { query: " N ", limit: 1, showAll: false });
    expect(ids(search.matching)).toEqual(["new"]);
    expect(ids(search.shown)).toEqual(["new"]);
    expect(ids(shownThreads(listed, { query: "o", limit: 1, showAll: false }).shown)).toEqual([
      "old",
    ]);
  });
});
