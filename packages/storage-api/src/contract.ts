import { describe, expect, it } from "vite-plus/test";

import type { EventLog, KeyValueStore, StoredEvent } from "./types.ts";

export interface StorageUnderTest {
  readonly kv: KeyValueStore;
  readonly log: EventLog;
  /** Closes and reopens the same storage; omit for storage that does not persist. */
  readonly restart?: () => Promise<{ kv: KeyValueStore; log: EventLog }>;
}

/**
 * The behaviour every implementation of storage.kv@1 and storage.eventlog@1
 * must have. Run it against each implementation:
 * `describeStorageContract("sqlite", () => openSqliteForTest())`.
 */
export function describeStorageContract(name: string, open: () => Promise<StorageUnderTest>): void {
  describe(`storage contract: ${name}`, () => {
    describe("storage.kv", () => {
      it("sets, overwrites, gets and deletes values", async () => {
        const { kv } = await open();
        expect(await kv.get("app", "missing")).toBeUndefined();

        await kv.set("app", "user", { name: "Ada", tags: ["a"] });
        await kv.set("app", "user", { name: "Bo", tags: [] });
        expect(await kv.get("app", "user")).toEqual({ name: "Bo", tags: [] });

        expect(await kv.delete("app", "user")).toBe(true);
        expect(await kv.delete("app", "user")).toBe(false);
        expect(await kv.get("app", "user")).toBeUndefined();
      });

      it("isolates namespaces and lists sorted keys by prefix", async () => {
        const { kv } = await open();
        await kv.set("a", "b/2", 2);
        await kv.set("a", "b/1", 1);
        await kv.set("a", "c", 3);
        await kv.set("other", "b/1", "elsewhere");

        expect(await kv.list("a")).toEqual([
          { key: "b/1", value: 1 },
          { key: "b/2", value: 2 },
          { key: "c", value: 3 },
        ]);
        expect(await kv.list("a", { prefix: "b/" })).toEqual([
          { key: "b/1", value: 1 },
          { key: "b/2", value: 2 },
        ]);
        expect(await kv.get("other", "b/1")).toBe("elsewhere");
      });

      it("stores copies, not references", async () => {
        const { kv } = await open();
        const value = { list: [1] };
        await kv.set("app", "k", value);
        value.list.push(2);
        const read = (await kv.get("app", "k")) as { list: number[] };
        read.list.push(3);

        expect(await kv.get("app", "k")).toEqual({ list: [1] });
      });

      it("orders keys by code point, also outside the Basic Multilingual Plane", async () => {
        const { kv } = await open();
        // U+FFFD sorts before U+1F600 by code point; UTF-16 code units would say the opposite.
        await kv.set("app", "😀b", 2);
        await kv.set("app", "\uFFFD", 1);
        await kv.set("app", "😀a", 3);
        await kv.set("app", "a", 0);

        expect((await kv.list("app")).map((entry) => entry.key)).toEqual([
          "a",
          "\uFFFD",
          "😀a",
          "😀b",
        ]);
        expect((await kv.list("app", { prefix: "😀" })).map((entry) => entry.key)).toEqual([
          "😀a",
          "😀b",
        ]);
      });

      it("rejects empty names", async () => {
        const { kv } = await open();
        await expect(kv.set("", "k", 1)).rejects.toMatchObject({ code: "INVALID" });
        await expect(kv.get("app", "")).rejects.toMatchObject({ code: "INVALID" });
      });
    });

    describe("storage.eventlog", () => {
      it("assigns gap-free sequences per stream, starting at 1", async () => {
        const { log } = await open();
        const first = await log.append("thread-1", [
          { type: "app.a", payload: 1 },
          { type: "app.b", payload: 2 },
        ]);
        await log.append("thread-2", [{ type: "app.a", payload: "x" }]);
        const second = await log.append("thread-1", [{ type: "app.c", payload: { n: 3 } }]);

        expect(first.map((event) => event.sequence)).toEqual([1, 2]);
        expect(second.map((event) => event.sequence)).toEqual([3]);
        expect(await log.head("thread-1")).toBe(3);
        expect(await log.head("thread-2")).toBe(1);
        expect(await log.head("never")).toBe(0);
        expect(first[0]).toMatchObject({ stream: "thread-1", type: "app.a", payload: 1 });
        expect(Number.isNaN(Date.parse(first[0]!.at))).toBe(false);
      });

      it("reads after a sequence with a limit", async () => {
        const { log } = await open();
        await log.append(
          "s",
          [1, 2, 3, 4, 5].map((n) => ({ type: "app.n", payload: n })),
        );

        expect((await log.read("s")).map((event) => event.payload)).toEqual([1, 2, 3, 4, 5]);
        expect((await log.read("s", { after: 2 })).map((event) => event.sequence)).toEqual([
          3, 4, 5,
        ]);
        expect(
          (await log.read("s", { after: 1, limit: 2 })).map((event) => event.sequence),
        ).toEqual([2, 3]);
        expect(await log.read("s", { after: 5 })).toEqual([]);
      });

      it("rejects an append whose expected head is stale, storing nothing", async () => {
        const { log } = await open();
        await log.append("s", [{ type: "app.a", payload: 1 }], { expectedHead: 0 });

        await expect(
          log.append("s", [{ type: "app.b", payload: 2 }], { expectedHead: 0 }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          details: { head: 1, expectedHead: 0 },
        });
        expect(await log.head("s")).toBe(1);
        await log.append("s", [{ type: "app.b", payload: 2 }], { expectedHead: 1 });
        expect(await log.head("s")).toBe(2);
      });

      it("rejects an invalid event without storing any event of the batch", async () => {
        const { log } = await open();

        await expect(
          log.append("s", [
            { type: "app.ok", payload: 1 },
            { type: "NotNamespaced", payload: 2 },
          ]),
        ).rejects.toMatchObject({ code: "INVALID" });
        expect(await log.head("s")).toBe(0);
      });

      it("notifies subscribers of later appends, in order, until disposed", async () => {
        const { log } = await open();
        await log.append("s", [{ type: "app.before", payload: 0 }]);
        const seen: StoredEvent[] = [];
        const subscription = log.subscribe("s", (event) => seen.push(event));
        log.subscribe("s", () => {
          throw new Error("a broken subscriber");
        });

        await log.append("s", [
          { type: "app.a", payload: 1 },
          { type: "app.b", payload: 2 },
        ]);
        await log.append("other", [{ type: "app.x", payload: 9 }]);
        subscription.dispose();
        await log.append("s", [{ type: "app.c", payload: 3 }]);

        expect(seen.map((event) => [event.sequence, event.type])).toEqual([
          [2, "app.a"],
          [3, "app.b"],
        ]);
      });

      it("rejects counts that are not non-negative integers", async () => {
        const { log } = await open();
        await log.append("s", [{ type: "app.a", payload: 1 }]);

        await expect(log.read("s", { limit: -1 })).rejects.toMatchObject({ code: "INVALID" });
        await expect(log.read("s", { after: 1.5 })).rejects.toMatchObject({ code: "INVALID" });
        await expect(log.append("s", [], { expectedHead: Number.NaN })).rejects.toMatchObject({
          code: "INVALID",
        });
        expect(await log.read("s", { limit: 0 })).toEqual([]);
      });

      it("treats an empty batch as a no-op that still checks the expected head", async () => {
        const { log } = await open();
        await log.append("s", [{ type: "app.a", payload: 1 }]);

        expect(await log.append("s", [], { expectedHead: 1 })).toEqual([]);
        await expect(log.append("s", [], { expectedHead: 0 })).rejects.toMatchObject({
          code: "CONFLICT",
        });
        expect(await log.head("s")).toBe(1);
      });

      it("keeps sequence order for subscribers when a subscriber appends", async () => {
        const { log } = await open();
        const seen: number[] = [];
        let reacted = false;
        let reaction: Promise<unknown> = Promise.resolve();
        log.subscribe("s", (event) => {
          seen.push(event.sequence);
          if (!reacted) {
            reacted = true;
            reaction = log.append("s", [{ type: "app.reaction", payload: null }]);
          }
        });

        await log.append("s", [
          { type: "app.a", payload: 1 },
          { type: "app.b", payload: 2 },
        ]);
        await reaction;

        expect(seen).toEqual([1, 2, 3]);
      });

      it("lists non-empty streams by prefix with their heads", async () => {
        const { log } = await open();
        await log.append("thread/b", [{ type: "app.a", payload: 1 }]);
        await log.append("thread/a", [
          { type: "app.a", payload: 1 },
          { type: "app.a", payload: 2 },
        ]);
        await log.append("other", [{ type: "app.a", payload: 1 }]);

        expect(await log.streams({ prefix: "thread/" })).toEqual([
          { stream: "thread/a", head: 2 },
          { stream: "thread/b", head: 1 },
        ]);
      });
    });

    it("keeps data across a restart when the storage persists", async (context) => {
      const storage = await open();
      if (storage.restart === undefined) {
        context.skip();
        return;
      }
      await storage.kv.set("app", "k", { kept: true });
      await storage.log.append("s", [{ type: "app.a", payload: 1 }]);

      const reopened = await storage.restart();

      expect(await reopened.kv.get("app", "k")).toEqual({ kept: true });
      expect(await reopened.log.read("s")).toMatchObject([
        { sequence: 1, type: "app.a", payload: 1 },
      ]);
      const [next] = await reopened.log.append("s", [{ type: "app.b", payload: 2 }]);
      expect(next?.sequence).toBe(2);
    });
  });
}
