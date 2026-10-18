import type { Logger } from "@jhin/sdk";
import { createMemoryStorage, type EventLog, type Json, type StoredEvent } from "@jhin/storage-api";
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
  const log: EventLog = {
    ...storage.log,
    read(stream, readOptions) {
      reads.push(stream);
      return storage.log.read(stream, readOptions);
    },
  };
  let now = 1_000_000;
  let ids = 0;
  const online = new Set<string>();
  const delivered: { node: string; patch: Patch }[] = [];
  const answers = new Map<string, () => Delivery>();
  const outbox = createOutbox({
    kv: storage.kv,
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
    outbox,
    reads,
    online,
    delivered,
    answers,
    advance: (ms: number) => {
      now += ms;
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
