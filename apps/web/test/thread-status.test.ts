import { visitKey, type ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { isUnread } from "../src/lib/sidebar-order.ts";
import { createVisits } from "../src/lib/thread-status.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const AT = "2026-10-18T12:00:00.000Z";
const LATER = "2026-10-18T12:05:00.000Z";

const thread = (lastTurn?: ThreadRecord["lastTurn"]): ThreadRecord => ({
  id: "t1",
  projectId: "p1",
  title: "A thread",
  createdAt: AT,
  ...(lastTurn === undefined ? {} : { lastTurn }),
});

const turn = (
  status: NonNullable<ThreadRecord["lastTurn"]>["status"],
  extra: Partial<NonNullable<ThreadRecord["lastTurn"]>> = {},
): ThreadRecord["lastTurn"] => ({ turnId: "u1", status, at: LATER, agentId: "fake", ...extra });

describe("visits", () => {
  const node = { node: "ws://a/rpc" };

  it("only moves forward, and marking unread brings the last turn back", () => {
    const storage = memoryStorage();
    const visits = createVisits(storage);
    let changes = 0;
    visits.subscribe(() => (changes += 1));

    visits.visit(node, "t1", LATER);
    visits.visit(node, "t1", AT);
    expect(visits.get(node, "t1")).toBe(LATER);
    expect(changes).toBe(1);

    const before = visits.snapshot();
    visits.markUnread(node, "t1");
    expect(visits.snapshot()).not.toBe(before);
    expect(isUnread(thread(turn("completed")), visits.get(node, "t1"))).toBe(true);
    // Kept on the device, under the key renders read it by.
    expect(createVisits(storage).get(node, "t1")).toBe(visits.get(node, "t1"));
    expect(visits.snapshot()[visitKey(node, "t1")]).toBe(visits.get(node, "t1"));
    // A thread of the same id on another node is another thread.
    expect(visits.get({ node: "ws://a/rpc", remote: "b" }, "t1")).toBeUndefined();
  });

  it("starts empty from unreadable storage", () => {
    expect(createVisits(memoryStorage({ "jhin.visits": "[1,2]" })).snapshot()).toEqual({});
    expect(createVisits(memoryStorage({ "jhin.visits": "{" })).snapshot()).toEqual({});
  });
});
