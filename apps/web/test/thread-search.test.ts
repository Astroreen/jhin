import type { NodeTarget } from "@jhin/client-api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createContentSearch,
  emptySearchLabel,
  highlightParts,
  searchingContents,
} from "../src/lib/thread-search.ts";

/** Nodes that answer `threads.search` when the test says so. */
function nodes() {
  const calls: {
    target: NodeTarget;
    query: string;
    answer(matches: unknown[]): void;
    fail(code?: string): void;
  }[] = [];
  const threads = {
    call: <T>(target: NodeTarget, _method: string, params?: unknown) =>
      new Promise<T>((resolve, reject) =>
        calls.push({
          target,
          query: (params as { query: string }).query,
          answer: (matches) => resolve({ matches } as T),
          fail: (code = "COMMAND_NOT_FOUND") => reject(Object.assign(new Error(code), { code })),
        }),
      ),
  };
  return { threads, calls };
}

const a: NodeTarget = { node: "a" };
const b: NodeTarget = { node: "b", remote: "m" };
const match = (threadId: string, source: "user" | "assistant", updatedAt: string) => ({
  threadId,
  projectId: "p",
  source,
  snippet: `about ${threadId}`,
  at: "2026-10-01T00:00:00Z",
  updatedAt,
});

/** Resolves once the search's state passes `test`: on a change, never by polling. */
function until(
  search: ReturnType<typeof createContentSearch>,
  test: (state: ReturnType<ReturnType<typeof createContentSearch>["get"]>) => boolean,
) {
  return new Promise<void>((resolve) => {
    if (test(search.get())) return resolve();
    const subscription = search.subscribe(() => {
      if (!test(search.get())) return;
      subscription.dispose();
      resolve();
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("searching thread contents on every node (D228)", () => {
  it("asks every node after a pause, from two characters, and merges what they find", async () => {
    vi.useFakeTimers();
    const { threads, calls } = nodes();
    const search = createContentSearch(threads);
    search.request("l", [a, b]);
    expect(search.get()).toEqual({ query: "", pending: false, matches: [], failed: 0 });
    search.request("li", [a, b]);
    search.request("lisbon ", [a, b]);
    // Pending at once, asked only after the pause, and only for the latest query.
    expect(search.get()).toMatchObject({ query: "lisbon", pending: true });
    vi.advanceTimersByTime(199);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls.map((call) => [call.target, call.query])).toEqual([
      [a, "lisbon"],
      [b, "lisbon"],
    ]);

    calls[0]!.answer([match("t1", "assistant", "2026-10-20T10:00:00Z")]);
    await until(search, (state) => state.matches.length === 1);
    expect(search.get().pending).toBe(true);
    calls[1]!.answer([
      match("t2", "assistant", "2026-10-20T11:00:00Z"),
      match("t3", "user", "2026-10-19T00:00:00Z"),
    ]);
    await until(search, (state) => !state.pending);
    // User matches first, then the thread changed last.
    expect(search.get().matches.map((found) => [found.target, found.threadId])).toEqual([
      [b, "t3"],
      [b, "t2"],
      [a, "t1"],
    ]);
  });

  it("drops answers to an older query and counts a node that cannot search as no matches", async () => {
    vi.useFakeTimers();
    const { threads, calls } = nodes();
    const search = createContentSearch(threads);
    search.request("first", [a]);
    vi.advanceTimersByTime(200);
    search.request("second", [a, b]);
    vi.advanceTimersByTime(200);
    calls[0]!.answer([match("old", "user", "2026-10-20T10:00:00Z")]);
    calls[1]!.answer([match("new", "user", "2026-10-20T10:00:00Z")]);
    calls[2]!.fail();
    await until(search, (state) => !state.pending);
    expect(search.get()).toMatchObject({ query: "second", matches: [{ threadId: "new" }] });
    // The same request again asks nothing; clearing the query clears the matches.
    search.request("second", [a, b]);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(3);
    search.request("", [a, b]);
    expect(search.get()).toEqual({ query: "", pending: false, matches: [], failed: 0 });
  });

  it("counts a node that never answers as finding nothing once its time is up", async () => {
    vi.useFakeTimers();
    const { threads, calls } = nodes();
    const search = createContentSearch(threads);
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    calls[0]!.answer([match("t1", "user", "2026-10-20T10:00:00Z")]);
    await until(search, (state) => state.matches.length === 1);
    // b never answers: the view stops saying "Searching thread messages…" at the deadline.
    expect(search.get().pending).toBe(true);
    vi.advanceTimersByTime(10_000);
    await until(search, (state) => !state.pending);
    expect(search.get().matches.map((found) => found.threadId)).toEqual(["t1"]);
    // Not answering is not finding nothing: the view says some nodes could not search.
    expect(search.get().failed).toBe(1);
    expect(emptySearchLabel(search.get(), "lisbon")).toBe(
      "No threads found. Some nodes could not search their messages.",
    );
    // b answers after all, still on the same query: its matches count.
    calls[1]!.answer([match("t2", "user", "2026-10-20T11:00:00Z")]);
    await until(search, (state) => state.failed === 0);
    expect(search.get().matches.map((found) => found.threadId)).toEqual(["t2", "t1"]);
  });

  it("tells a failed search apart from a node that has no such command", async () => {
    vi.useFakeTimers();
    const { threads, calls } = nodes();
    const search = createContentSearch(threads);
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    calls[0]!.fail();
    calls[1]!.fail("PERMISSION_DENIED");
    await until(search, (state) => !state.pending);
    expect(search.get()).toMatchObject({ matches: [], failed: 1 });
    // Asked again at once (a view re-rendering), nothing goes out.
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(2);
    // A deadline later the same query goes out again, since a node failed it.
    vi.advanceTimersByTime(10_000);
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(4);
    search.request("lisbon!", [a]);
    vi.advanceTimersByTime(200);
    calls[4]!.fail();
    await until(search, (state) => state.query === "lisbon!" && !state.pending);
    expect(emptySearchLabel(search.get(), "lisbon!")).toBe("No threads found");
  });

  it("waits for contents from two characters on, also before the request went out", () => {
    const idle = { query: "", pending: false, matches: [], failed: 0 };
    expect(searchingContents(idle, "l")).toBe(false);
    expect(searchingContents(idle, "li ")).toBe(true);
    expect(searchingContents({ query: "li", pending: false, matches: [], failed: 0 }, " li")).toBe(
      false,
    );
    expect(searchingContents({ query: "li", pending: true, matches: [], failed: 0 }, "li")).toBe(
      true,
    );
  });

  it("leaves no timer behind once a newer query or disposal supersedes the asking", () => {
    vi.useFakeTimers();
    const { threads } = nodes();
    const search = createContentSearch(threads);
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    // Two nodes asked: one deadline each.
    expect(vi.getTimerCount()).toBe(2);
    search.request("porto", [a]);
    expect(vi.getTimerCount()).toBe(1);
    search.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks a node for at most 200 characters", () => {
    vi.useFakeTimers();
    const { threads, calls } = nodes();
    const search = createContentSearch(threads);
    search.request(`${"a".repeat(199)} tail`, [a]);
    vi.advanceTimersByTime(200);
    expect(calls[0]!.query).toBe("a".repeat(199));
  });

  it("keeps a node's earlier matches on show until it answers a query asked again", async () => {
    vi.useFakeTimers();
    const { threads, calls } = nodes();
    const search = createContentSearch(threads);
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    calls[0]!.answer([match("t1", "user", "2026-10-20T10:00:00Z")]);
    calls[1]!.fail("PERMISSION_DENIED");
    await until(search, (state) => !state.pending);
    vi.advanceTimersByTime(10_000);
    search.request("lisbon", [a, b]);
    vi.advanceTimersByTime(200);
    // Asking again: no flash of an empty list while the nodes answer.
    expect(search.get()).toMatchObject({ pending: true, matches: [{ threadId: "t1" }] });
    calls[2]!.answer([]);
    await until(search, (state) => state.matches.length === 0);
    calls[3]!.answer([match("t2", "user", "2026-10-20T11:00:00Z")]);
    await until(search, (state) => !state.pending);
    expect(search.get().matches.map((found) => found.threadId)).toEqual(["t2"]);
  });

  it("marks every occurrence of the query, ignoring ASCII case", () => {
    expect(highlightParts("Lisbon and lisbon", "LISBON")).toEqual([
      { text: "Lisbon", highlighted: true },
      { text: " and ", highlighted: false },
      { text: "lisbon", highlighted: true },
    ]);
    expect(highlightParts("plain", " ")).toEqual([{ text: "plain", highlighted: false }]);
    // Whitespace counts as the node matched it: collapsed.
    expect(highlightParts("foo bar baz", "foo  bar")).toEqual([
      { text: "foo bar", highlighted: true },
      { text: " baz", highlighted: false },
    ]);
  });
});
