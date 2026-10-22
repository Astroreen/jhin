import { describe, expect, it } from "vite-plus/test";

import { mergeByTime } from "../src/merge.ts";

const event = (stream: string, sequence: number, at: string) => ({ stream, sequence, at });

describe("the replay of health's streams (D722)", () => {
  it("merges streams by time and keeps each stream in sequence order, even when its clock stepped back", () => {
    const missions = [
      event("missions", 1, "2026-10-22T10:00:00.000Z"),
      event("missions", 2, "2026-10-22T10:05:00.000Z"),
    ];
    // The clock stepped back between 1 and 2 of this stream: 2 still follows 1.
    const messages = [
      event("messages", 1, "2026-10-22T10:03:00.000Z"),
      event("messages", 2, "2026-10-22T10:01:00.000Z"),
      event("messages", 3, "2026-10-22T10:06:00.000Z"),
    ];
    expect(
      mergeByTime([missions, messages]).map((item) => `${item.stream}#${item.sequence}`),
    ).toEqual(["missions#1", "messages#1", "messages#2", "missions#2", "messages#3"]);
  });

  it("puts the earlier list first on a tie, and reads empty lists", () => {
    const health = [event("health", 1, "2026-10-22T10:00:00.000Z")];
    const missions = [event("missions", 1, "2026-10-22T10:00:00.000Z")];
    expect(mergeByTime([health, [], missions]).map((item) => item.stream)).toEqual([
      "health",
      "missions",
    ]);
  });

  it("orders times as times, whatever their ISO form", () => {
    // 12:30 at +03:00 is 09:30 UTC: before 10:00 UTC, though it sorts after it as a string.
    const a = [event("a", 1, "2026-10-22T10:00:00Z")];
    const b = [event("b", 1, "2026-10-22T12:30:00+03:00")];
    expect(mergeByTime([a, b]).map((item) => item.stream)).toEqual(["b", "a"]);
  });
});
