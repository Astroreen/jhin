import { describe, expect, it } from "vite-plus/test";

import {
  orderKeyBetween,
  planReorder,
  sortActive,
  sortPinned,
  spreadOrderKeys,
} from "../src/lib/thread-order.ts";

describe("fractional order keys (D78)", () => {
  it("finds a key strictly between two neighbours, or at an open end", () => {
    for (const [before, after] of [
      [null, null],
      [null, "n"],
      ["n", null],
      ["c", "d"],
      ["n", "nb"],
      ["az", "b"],
    ] as const) {
      const key = orderKeyBetween(before, after)!;
      expect(key).toMatch(/^[a-z]*[b-z]$/);
      if (before !== null) expect(key > before).toBe(true);
      if (after !== null) expect(key < after).toBe(true);
    }
  });

  it("refuses corrupt or out-of-order bounds instead of throwing", () => {
    expect(orderKeyBetween("d", "c")).toBeNull();
    expect(orderKeyBetween("na", null)).toBeNull();
    expect(orderKeyBetween("N", null)).toBeNull();
  });

  it("spreads keys evenly and in order for a rewrite", () => {
    const keys = spreadOrderKeys(30);
    expect(keys).toHaveLength(30);
    expect(keys.toSorted()).toEqual(keys);
    expect(new Set(keys).size).toBe(30);
  });

  it("writes one key between keyed neighbours, keeping clear of hidden rows' keys", () => {
    const keys = new Map([
      ["a", "c"],
      ["b", "e"],
      ["hidden", "d"],
      ["moved", undefined],
    ]);
    const plan = planReorder({ orderedIds: ["a", "moved", "b"], keysById: keys, movedId: "moved" });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.id).toBe("moved");
    expect(plan[0]!.orderKey > "c" && plan[0]!.orderKey < "e").toBe(true);
    expect(plan[0]!.orderKey).not.toBe("d");
  });

  it("rewrites the shown rows when a neighbour has no key yet", () => {
    const plan = planReorder({
      orderedIds: ["x", "moved", "y"],
      keysById: new Map([["hidden", "n"]]),
      movedId: "moved",
    });
    expect(plan.map((item) => item.id)).toEqual(["x", "moved", "y"]);
    const written = plan.map((item) => item.orderKey);
    expect(written.toSorted()).toEqual(written);
    expect(written).not.toContain("n");
  });
});

describe("pinned and active order (D76, D78)", () => {
  const item = (key: string, createdAt: string, orderKey?: string, unsettledAt?: string) => ({
    key,
    createdAt,
    orderKey,
    unsettledAt,
  });

  it("puts keyed pinned threads first by key, then the rest newest first", () => {
    const sorted = sortPinned(
      [
        item("old", "2026-10-01T00:00:00Z"),
        item("second", "2026-10-02T00:00:00Z", "n"),
        item("new", "2026-10-03T00:00:00Z"),
        item("first", "2026-10-04T00:00:00Z", "c"),
      ],
      (value) => value,
    );
    expect(sorted.map((value) => value.key)).toEqual(["first", "second", "new", "old"]);
  });

  it("puts active threads never dragged on top, by creation or return from the shelf", () => {
    const sorted = sortActive(
      [
        item("dragged", "2026-10-05T00:00:00Z", "c"),
        item("old", "2026-10-01T00:00:00Z"),
        item("back", "2026-09-01T00:00:00Z", undefined, "2026-10-04T00:00:00Z"),
        item("unreadable", "garbled"),
      ],
      (value) => value,
    );
    expect(sorted.map((value) => value.key)).toEqual(["back", "old", "unreadable", "dragged"]);
  });
});
