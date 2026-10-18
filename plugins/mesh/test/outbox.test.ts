import type { Logger } from "@jhin/sdk";
import {
  createMemoryStorage,
  type EventLog,
  type Json,
  type KeyValueStore,
  type StoredEvent,
} from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { createOutbox, OUTBOX_STREAM, type Delivery, type Patch } from "../src/outbox.ts";

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const HOUR = 3_600_000;
const patch = (greeting: string, at = 1): Patch => ({
  layer: "node",
  section: "jhin.example",
  values: { greeting },
  at,
});

/** An outbox over memory storage with a hand-moved clock and a mesh the test controls. */
function setup(
  options: { expireAfterMs?: number | null; storage?: ReturnType<typeof createMemoryStorage> } = {},
) {
  const storage = options.storage ?? createMemoryStorage();
  // Counts reads of the outbox stream: a mesh change must not need any.
  const reads: string[] = [];
  // Storage faults a test arms: the next write of that kind fails once.
  const faults = { append: undefined as string | undefined, kvGet: false };
  const log: EventLog = {
    ...storage.log,
    read(stream, readOptions) {
      reads.push(stream);
      return storage.log.read(stream, readOptions);
    },
    append(stream, events, appendOptions) {
      if (events.some((event) => event.type === faults.append)) {
        faults.append = undefined;
        return Promise.reject(new Error("disk full"));
      }
      return storage.log.append(stream, events, appendOptions);
    },
  };
  const kv: KeyValueStore = {
    ...storage.kv,
    get(namespace, key) {
      if (faults.kvGet) {
        faults.kvGet = false;
        return Promise.reject(new Error("database locked"));
      }
      return storage.kv.get(namespace, key);
    },
  };
  let now = 1_000_000;
  let ids = 0;
  const online = new Set<string>();
  const delivered: { node: string; patch: Patch }[] = [];
  const answers = new Map<string, () => Delivery>();
  const outbox = createOutbox({
    kv,
    log,
    now: () => now,
    expireAfterMs: options.expireAfterMs === undefined ? 24 * HOUR : options.expireAfterMs,
    reachable: (node) => online.has(node),
    async deliver(node, change) {
      delivered.push({ node, patch: change });
      return answers.get(node)?.() ?? { status: "applied" };
    },
    unreachable: (error) => (error as { code?: unknown }).code === "NODE_UNREACHABLE",
    newId: () => `change-${(ids += 1)}`,
    logger: quiet,
  });
  return {
    storage,
    faults,
    outbox,
    reads,
    online,
    delivered,
    answers,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
    history: async () =>
      (await storage.log.read(OUTBOX_STREAM)).map((event: StoredEvent) => [
        event.type,
        (event.payload as { id: string }).id,
      ]),
  };
}

describe("config outbox (D50)", () => {
  it("delivers a queued change once its node is reachable and forgets it", async () => {
    const { outbox, online, delivered, history } = setup();
    await outbox.enqueue("c", patch("Welcome back"));
    await outbox.flush();
    expect(delivered).toEqual([]);
    expect((await outbox.pending()).map((change) => change.node)).toEqual(["c"]);

    online.add("c");
    await outbox.flush();
    expect(delivered).toEqual([{ node: "c", patch: patch("Welcome back") }]);
    expect(await outbox.pending()).toEqual([]);
    expect(await history()).toEqual([
      ["mesh.config.queued", "change-1"],
      ["mesh.config.delivered", "change-1"],
    ]);

    await outbox.flush();
    expect(delivered).toHaveLength(1);
  });

  it("records conflicts and failures, and keeps a change whose node went away mid-delivery", async () => {
    const { outbox, online, answers, history } = setup();
    online.add("b").add("c").add("d");
    answers.set("b", () => ({ status: "conflict", localAt: 7 }));
    answers.set("c", () => {
      throw Object.assign(new Error("gone"), { code: "NODE_UNREACHABLE" });
    });
    answers.set("d", () => {
      throw new Error("bad section");
    });
    for (const node of ["b", "c", "d"]) await outbox.enqueue(node, patch("x"));
    await outbox.flush();

    expect(await history()).toEqual([
      ["mesh.config.queued", "change-1"],
      ["mesh.config.queued", "change-2"],
      ["mesh.config.queued", "change-3"],
      ["mesh.config.conflict", "change-1"],
      ["mesh.config.failed", "change-3"],
    ]);
    expect((await outbox.pending()).map((change) => change.id)).toEqual(["change-2"]);
  });

  it("expires a change whose node never returns, visibly", async () => {
    const { outbox, online, delivered, advance, history, storage } = setup({
      expireAfterMs: 24 * HOUR,
    });
    await outbox.enqueue("gone", patch("x"));
    advance(HOUR);
    await outbox.enqueue("back", patch("y"));
    const [first] = await outbox.pending();
    expect(first).toMatchObject({
      node: "gone",
      queuedAt: 1_000_000,
      expiresAt: 1_000_000 + 24 * HOUR,
    });

    advance(23 * HOUR);
    online.add("gone").add("back");
    await outbox.flush();
    // The expired change is not delivered even though its node is back now.
    expect(delivered.map((change) => change.node)).toEqual(["back"]);
    expect(await history()).toEqual([
      ["mesh.config.queued", "change-1"],
      ["mesh.config.queued", "change-2"],
      ["mesh.config.expired", "change-1"],
      ["mesh.config.delivered", "change-2"],
    ]);
    const expired = (await storage.log.read(OUTBOX_STREAM)).find(
      (event) => event.type === "mesh.config.expired",
    );
    expect(expired?.payload).toEqual({
      id: "change-1",
      node: "gone",
      status: "expired",
      queuedAt: 1_000_000,
      expiredAt: 1_000_000 + 24 * HOUR,
    });
    expect(await outbox.pending()).toEqual([]);
  });

  it("keeps changes forever when expiry is off", async () => {
    const { outbox, advance } = setup({ expireAfterMs: null });
    await outbox.enqueue("gone", patch("x"));
    advance(10_000 * HOUR);
    expect(await outbox.pending()).toMatchObject([{ node: "gone", expiresAt: null }]);
  });

  it("does not read the outbox stream when the mesh changes, however long its history", async () => {
    const { outbox, online, reads, storage } = setup();
    online.add("b");
    for (let index = 0; index < 500; index += 1) await outbox.enqueue("b", patch(`v${index}`));
    await outbox.flush();
    expect(await storage.log.head(OUTBOX_STREAM)).toBe(1000);

    online.delete("b");
    await outbox.enqueue("b", patch("last"));
    reads.length = 0;
    for (let change = 0; change < 10; change += 1) await outbox.flush();
    expect(reads).toEqual([]);
    expect(await storage.kv.list("jhin.mesh.outbox")).toHaveLength(1);
  });

  it("picks up what an outbox written before the pending set still owes, reading it once", async () => {
    const storage = createMemoryStorage();
    await storage.log.append(OUTBOX_STREAM, [
      {
        type: "mesh.config.queued",
        payload: { id: "old-1", node: "b", patch: patch("a") as unknown as Json },
      },
      {
        type: "mesh.config.queued",
        payload: { id: "old-2", node: "c", patch: patch("b") as unknown as Json },
      },
      { type: "mesh.config.delivered", payload: { id: "old-1", node: "b", status: "applied" } },
    ]);
    const first = setup({ storage });
    first.online.add("c");
    await first.outbox.flush();
    expect(first.delivered).toEqual([{ node: "c", patch: patch("b") }]);
    expect(first.reads).toEqual([OUTBOX_STREAM]);

    // A restart over the same storage does not read the history again.
    const second = setup({ storage });
    await second.outbox.flush();
    expect(second.reads).toEqual([]);
    expect(await second.outbox.pending()).toEqual([]);
  });

  it("keeps the order changes were made in, within one millisecond and after the clock steps back", async () => {
    const storage = createMemoryStorage();
    const first = setup({ storage });
    await first.outbox.enqueue("b", patch("1"));
    await first.outbox.enqueue("b", patch("2"));
    first.advance(-60_000);
    await first.outbox.enqueue("b", patch("3"));

    // A restart with the clock further back still queues behind what is pending.
    const second = setup({ storage });
    second.setNow(5);
    await second.outbox.enqueue("b", patch("4"));
    second.online.add("b");
    await second.outbox.flush();
    expect(second.delivered.map((change) => change.patch.values["greeting"])).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("does not call an applied change failed when recording its outcome fails", async () => {
    const { outbox, online, delivered, faults, history } = setup();
    await outbox.enqueue("b", patch("1"));
    await outbox.enqueue("c", patch("2"));
    online.add("b").add("c");
    faults.append = "mesh.config.delivered";
    await outbox.flush();
    // The rest of the queue still went out; the one whose outcome was lost stays pending.
    expect(delivered.map((change) => change.node)).toEqual(["b", "c"]);
    expect((await outbox.pending()).map((change) => change.node)).toEqual(["b"]);
    expect((await history()).map(([type]) => type)).not.toContain("mesh.config.failed");

    // Delivered again on the next flush (harmless: same values, same time) and recorded.
    await outbox.flush();
    expect(delivered.map((change) => change.node)).toEqual(["b", "c", "b"]);
    expect(await outbox.pending()).toEqual([]);
    expect(await history()).toEqual([
      ["mesh.config.queued", "change-1"],
      ["mesh.config.queued", "change-2"],
      ["mesh.config.delivered", "change-2"],
      ["mesh.config.delivered", "change-1"],
    ]);
  });

  it("keeps an expired change pending until its expiry is recorded", async () => {
    const { outbox, faults, advance, history } = setup({ expireAfterMs: HOUR });
    await outbox.enqueue("gone", patch("x"));
    advance(HOUR);
    faults.append = "mesh.config.expired";
    expect(await outbox.pending()).toEqual([]);
    expect((await history()).map(([type]) => type)).toEqual(["mesh.config.queued"]);
    await outbox.flush();
    expect((await history()).map(([type]) => type)).toEqual([
      "mesh.config.queued",
      "mesh.config.expired",
    ]);
  });

  it("tries a failed preparation again instead of failing for good", async () => {
    const storage = createMemoryStorage();
    await storage.log.append(OUTBOX_STREAM, [
      {
        type: "mesh.config.queued",
        payload: { id: "old", node: "b", patch: patch("a") as unknown as Json },
      },
    ]);
    const { outbox, faults, online, delivered } = setup({ storage });
    faults.kvGet = true;
    await expect(outbox.flush()).rejects.toThrow("database locked");
    online.add("b");
    await outbox.flush();
    expect(delivered).toEqual([{ node: "b", patch: patch("a") }]);
  });

  it("flushes again when asked while a flush runs", async () => {
    const { outbox, online, delivered } = setup();
    online.add("b");
    await outbox.enqueue("b", patch("1"));
    const running = outbox.flush();
    await outbox.enqueue("b", patch("2"));
    await Promise.all([running, outbox.flush()]);
    expect(delivered.map((change) => change.patch.values)).toEqual([
      { greeting: "1" },
      { greeting: "2" },
    ]);
  });
});
