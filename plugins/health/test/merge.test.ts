import { describe, expect, it } from "vite-plus/test";

import { mergeByTime } from "../src/merge.ts";

const event = (stream: string, sequence: number, at: string) => ({ stream, sequence, at });

describe("the replay of health's streams (D722)", () => {
  it("merges streams by time and keeps each stream in sequence order, even when its clock stepped back", () => {
    const missions = [event("missions", 1, "10:00"), event("missions", 2, "10:05")];
    // The clock stepped back between 1 and 2 of this stream: 2 still follows 1.
    const messages = [
      event("messages", 1, "10:03"),
      event("messages", 2, "10:01"),
      event("messages", 3, "10:06"),
    ];
    expect(
      mergeByTime([missions, messages]).map((item) => `${item.stream}#${item.sequence}`),
    ).toEqual(["missions#1", "messages#1", "messages#2", "missions#2", "messages#3"]);
  });

  it("puts the earlier list first on a tie, and reads empty lists", () => {
    const health = [event("health", 1, "10:00")];
    const missions = [event("missions", 1, "10:00")];
    expect(mergeByTime([health, [], missions]).map((item) => item.stream)).toEqual([
      "health",
      "missions",
    ]);
  });
});
