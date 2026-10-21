import { memoryStoragePlugin } from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  updatedAt?: string;
  archivedAt?: string;
  lastTurn?: { turnId: string; status: string; at: string };
  settledOverride?: "settled" | "active";
  settledAt?: string;
  unsettledAt?: string;
  pinnedAt?: string;
  pinOrderKey?: string;
  activeOrderKey?: string;
  snoozedUntil?: string;
  snoozedAt?: string;
  lastSnoozeWakeAt?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

/** A node with one thread, and the `threads` index followed from the start. */
async function withThread() {
  const { client } = await node();
  const index = watch(client, "stream:threads");
  const thread = await client.call<Thread>("threads.create", {});
  const record = (test: (thread: Thread) => boolean) =>
    index
      .untilMatch((event) => {
        const payload = event.payload as unknown as Thread;
        return payload.id === thread.id && test(payload);
      })
      .then((event) => event.payload as unknown as Thread);
  /** Sends a message and waits until the record says its turn completed. */
  const turn = async (text = "hello") => {
    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text,
    });
    return record(
      (item) => item.lastTurn?.turnId === turnId && item.lastTurn.status === "completed",
    );
  };
  return { client, index, thread, record, turn };
}

describe("jhin.threads: settling by hand (D75)", () => {
  it("settles and un-settles a thread in the threads index, leaving its activity time alone", async () => {
    const { client, index, thread } = await withThread();

    const settled = await client.call<Thread>("threads.settle", { threadId: thread.id });
    expect(settled).toMatchObject({ settledOverride: "settled", settledAt: expect.any(String) });
    expect(settled.updatedAt).toBe(thread.updatedAt);
    // Settling again changes nothing and records nothing.
    expect(await client.call("threads.settle", { threadId: thread.id })).toEqual(settled);

    const back = await client.call<Thread>("threads.unsettle", { threadId: thread.id });
    expect(back).toMatchObject({ settledOverride: "active", unsettledAt: expect.any(String) });
    expect(back.settledAt).toBeUndefined();
    expect(back.updatedAt).toBe(thread.updatedAt);

    await index.untilMatch(
      (event) => (event.payload as unknown as Thread).settledOverride === "active",
    );
    expect(index.events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "threads.thread.updated",
      "threads.thread.updated",
    ]);
  });

  it("wakes a snoozed thread it settles, so it leaves the Snoozed shelf for the Settled one", async () => {
    const { client, thread } = await withThread();
    await client.call("threads.snooze", { threadId: thread.id, until: inAnHour() });
    const settled = await client.call<Thread>("threads.settle", { threadId: thread.id });
    expect(settled).toMatchObject({
      settledOverride: "settled",
      lastSnoozeWakeAt: expect.any(String),
    });
    expect(settled.snoozedUntil).toBeUndefined();
    expect(settled.snoozedAt).toBeUndefined();

    // Settled already, then snoozed: settling again still wakes it, keeping when it settled.
    await client.call("threads.snooze", { threadId: thread.id, until: inAnHour() });
    const again = await client.call<Thread>("threads.settle", { threadId: thread.id });
    expect(again.snoozedUntil).toBeUndefined();
    expect(again.settledAt).toBe(settled.settledAt);
  });

  it("keeps when the automatic rule settled a thread that is then settled by hand", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, thread, turn } = await withThread();
    const done = await turn();
    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    const settled = await client.call<Thread>("threads.settle", { threadId: thread.id });
    // On the shelf it stays where it was: settled as of its last activity, not now.
    expect(settled.settledAt).toBe(done.lastTurn!.at);
  });

  it("refuses to settle a thread whose turn runs or waits for an answer, and an archived one", async () => {
    const { client, thread, record } = await withThread();
    const stream = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await stream.until("agent.item.delta");
    await expect(client.call("threads.settle", { threadId: thread.id })).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
      message: expect.stringContaining("still running"),
    });
    await client.call("threads.interrupt", { threadId: thread.id });
    await stream.until("agent.turn.interrupted");

    await client.call("threads.send", { threadId: thread.id, text: "/approve ls" });
    await record((item) => item.lastTurn?.status === "waiting");
    await expect(client.call("threads.settle", { threadId: thread.id })).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
      message: expect.stringContaining("answer it before settling"),
    });

    const other = await client.call<Thread>("threads.create", {});
    await client.call("threads.archive", { threadId: other.id });
    await expect(client.call("threads.settle", { threadId: other.id })).rejects.toMatchObject({
      code: "THREAD_ARCHIVED",
    });
  });

  it("brings a settled thread back to the top with its next turn, out of the dragged order", async () => {
    const { client, thread, turn } = await withThread();
    await client.call("threads.reorder", {
      threadId: thread.id,
      list: "active",
      orderKey: "n",
    });
    await client.call("threads.settle", { threadId: thread.id });

    const back = await turn();
    expect(back.settledOverride).toBeUndefined();
    expect(back.settledAt).toBeUndefined();
    expect(back.activeOrderKey).toBeUndefined();
    expect(back.unsettledAt).toEqual(expect.any(String));
  });

  it("leaves a thread that is not settled alone when asked to un-settle it", async () => {
    const { client, index, thread } = await withThread();
    expect(await client.call("threads.unsettle", { threadId: thread.id })).toEqual(thread);
    await client.call("threads.update", {
      threadId: thread.id,
      title: "after",
    });
    await index.untilMatch(
      (event) => (event.payload as unknown as Thread & { title: string }).title === "after",
    );
    // Only the rename was recorded: no override, no return time.
    expect(index.events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "threads.thread.updated",
    ]);
  });

  it("un-settles a snoozed settled thread without waking it: the snooze still hides it", async () => {
    const { client, thread } = await withThread();
    await client.call("threads.settle", { threadId: thread.id });
    const until = inAnHour();
    await client.call("threads.snooze", { threadId: thread.id, until });
    const back = await client.call<Thread>("threads.unsettle", { threadId: thread.id });
    expect(back).toMatchObject({ settledOverride: "active", snoozedUntil: until });
  });

  it("keeps a rename that lands while a turn brings the thread back", async () => {
    const storage = memoryStoragePlugin();
    const { client } = await node({ storage });
    const index = watch(client, "stream:threads");
    const thread = await client.call<Thread>("threads.create", {});
    const first = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "hello",
    });
    await index.untilMatch(
      (event) =>
        (event.payload as unknown as Thread).lastTurn?.turnId === first.turnId &&
        (event.payload as unknown as Thread).lastTurn?.status === "completed",
    );
    await client.call("threads.settle", { threadId: thread.id });

    // The send reads the thread twice: before taking it and once it is its own.
    // A rename lands right after the second read, before the send writes.
    const kv = storage.storage.kv;
    const get = kv.get.bind(kv);
    let reads = 0;
    kv.get = async (namespace, key) => {
      const value = await get(namespace, key);
      if (key === `thread/${thread.id}` && ++reads === 2) {
        await client.call("threads.update", { threadId: thread.id, title: "Renamed meanwhile" });
      }
      return value;
    };
    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "again",
    });
    kv.get = get;

    const ended = await index.untilMatch((event) => {
      const payload = event.payload as unknown as Thread & { title: string };
      return payload.lastTurn?.turnId === turnId && payload.lastTurn.status === "completed";
    });
    const record = ended.payload as unknown as Thread & { title: string };
    expect(record.title).toBe("Renamed meanwhile");
    // Brought back all the same.
    expect(record.settledOverride).toBeUndefined();
    expect(record.unsettledAt).toEqual(expect.any(String));
  });

  it("lets the automatic rule apply again after a turn, keeping when it came back by hand", async () => {
    const { client, thread, turn } = await withThread();
    const unsettled = await client.call<Thread>("threads.unsettle", { threadId: thread.id });

    const next = await turn();
    expect(next.settledOverride).toBeUndefined();
    expect(next.unsettledAt).toBe(unsettled.unsettledAt);
  });

  it("brings back a thread the automatic rule settled (three days without activity)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { turn } = await withThread();
    const first = await turn();
    expect(first.unsettledAt).toBeUndefined();

    // Two days on, the thread is not settled yet: its next turn leaves it where it is.
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const second = await turn();
    expect(second.unsettledAt).toBeUndefined();

    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    const third = await turn();
    expect(third.unsettledAt).toEqual(expect.any(String));
    expect(Date.parse(third.unsettledAt!)).toBeGreaterThan(Date.parse(second.lastTurn!.at));
  });
});

describe("jhin.threads: pinning and order (D76, D78)", () => {
  it("pins at a place, reorders and unpins, refusing a reorder the thread is not in", async () => {
    const { client, thread } = await withThread();
    await expect(
      client.call("threads.reorder", { threadId: thread.id, list: "pinned", orderKey: "n" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_PINNED" });

    const pinned = await client.call<Thread>("threads.pin", { threadId: thread.id, orderKey: "n" });
    expect(pinned).toMatchObject({ pinnedAt: expect.any(String), pinOrderKey: "n" });
    expect(pinned.updatedAt).toBe(thread.updatedAt);
    // Pinned already: another key does not move it; a reorder does.
    expect(
      await client.call<Thread>("threads.pin", { threadId: thread.id, orderKey: "c" }),
    ).toEqual(pinned);
    expect(
      await client.call<Thread>("threads.reorder", {
        threadId: thread.id,
        list: "pinned",
        orderKey: "c",
      }),
    ).toMatchObject({ pinOrderKey: "c" });
    await expect(
      client.call("threads.reorder", { threadId: thread.id, list: "active", orderKey: "n" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_ACTIVE" });

    const unpinned = await client.call<Thread>("threads.unpin", { threadId: thread.id });
    expect(unpinned.pinnedAt).toBeUndefined();
    expect(unpinned.pinOrderKey).toBeUndefined();
  });

  it("refuses an active order for a thread on a shelf: settled by the rule, or snoozed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, thread } = await withThread();
    const other = await client.call<Thread>("threads.create", {});
    await client.call("threads.snooze", { threadId: other.id, until: inAnHour() });
    await expect(
      client.call("threads.reorder", { threadId: other.id, list: "active", orderKey: "n" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_ACTIVE" });

    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    await expect(
      client.call("threads.reorder", { threadId: thread.id, list: "active", orderKey: "n" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_ACTIVE" });
    // Back by hand, it takes its place.
    await client.call("threads.unsettle", { threadId: thread.id });
    expect(
      await client.call("threads.reorder", { threadId: thread.id, list: "active", orderKey: "n" }),
    ).toMatchObject({ activeOrderKey: "n" });
  });

  it("refuses order keys that are not lowercase letters ending past a", async () => {
    const { client, thread } = await withThread();
    for (const orderKey of ["", "A", "n1", "na"]) {
      await expect(
        client.call("threads.reorder", { threadId: thread.id, list: "active", orderKey }),
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    }
  });

  it("unpins a thread it settles, and pinning brings a settled thread back and wakes a snoozed one", async () => {
    const { client, thread } = await withThread();
    await client.call("threads.pin", { threadId: thread.id, orderKey: "n" });
    const settled = await client.call<Thread>("threads.settle", { threadId: thread.id });
    expect(settled.pinnedAt).toBeUndefined();
    expect(settled.pinOrderKey).toBeUndefined();

    const pinned = await client.call<Thread>("threads.pin", { threadId: thread.id });
    expect(pinned).toMatchObject({ pinnedAt: expect.any(String), settledOverride: "active" });
    expect(pinned.settledAt).toBeUndefined();

    await client.call("threads.unpin", { threadId: thread.id });
    await client.call("threads.snooze", { threadId: thread.id, until: inAnHour() });
    const woke = await client.call<Thread>("threads.pin", { threadId: thread.id });
    expect(woke.snoozedUntil).toBeUndefined();
    expect(woke.lastSnoozeWakeAt).toEqual(expect.any(String));
  });

  it("keeps a thread pinned by the automatic rule's measure: pinning an idle thread keeps it active", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, thread } = await withThread();
    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    const pinned = await client.call<Thread>("threads.pin", { threadId: thread.id });
    expect(pinned.settledOverride).toBe("active");
  });
});

describe("jhin.threads: snoozing (D77)", () => {
  it("snoozes until a time in the future and wakes by hand", async () => {
    const { client, thread } = await withThread();
    await expect(
      client.call("threads.snooze", {
        threadId: thread.id,
        until: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SNOOZE_IN_PAST" });
    await expect(
      client.call("threads.snooze", { threadId: thread.id, until: "tomorrow" }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });

    const until = inAnHour();
    const snoozed = await client.call<Thread>("threads.snooze", { threadId: thread.id, until });
    expect(snoozed).toMatchObject({ snoozedUntil: until, snoozedAt: expect.any(String) });
    expect(snoozed.updatedAt).toBe(thread.updatedAt);

    const awake = await client.call<Thread>("threads.unsnooze", { threadId: thread.id });
    expect(awake.snoozedUntil).toBeUndefined();
    expect(awake.snoozedAt).toBeUndefined();
    expect(awake.lastSnoozeWakeAt).toEqual(expect.any(String));
    // Awake already: nothing changes.
    expect(await client.call("threads.unsnooze", { threadId: thread.id })).toEqual(awake);
  });

  it("keeps a pin and a settlement under a snooze, as T3 does: the thread wakes back into its place", async () => {
    const { client, thread } = await withThread();
    const pinned = await client.call<Thread>("threads.pin", { threadId: thread.id, orderKey: "n" });
    const snoozed = await client.call<Thread>("threads.snooze", {
      threadId: thread.id,
      until: inAnHour(),
    });
    expect(snoozed).toMatchObject({ pinnedAt: pinned.pinnedAt, pinOrderKey: "n" });

    const other = await client.call<Thread>("threads.create", {});
    const settled = await client.call<Thread>("threads.settle", { threadId: other.id });
    const both = await client.call<Thread>("threads.snooze", {
      threadId: other.id,
      until: inAnHour(),
    });
    expect(both).toMatchObject({ settledOverride: "settled", settledAt: settled.settledAt });
  });

  it("refuses to snooze a thread waiting for an answer; a new turn wakes a snoozed thread", async () => {
    const { client, thread, record, turn } = await withThread();
    await client.call("threads.snooze", { threadId: thread.id, until: inAnHour() });
    const next = await turn();
    expect(next.snoozedUntil).toBeUndefined();
    expect(next.snoozedAt).toBeUndefined();

    await client.call("threads.send", { threadId: thread.id, text: "/approve ls" });
    await record((item) => item.lastTurn?.status === "waiting");
    await expect(
      client.call("threads.snooze", { threadId: thread.id, until: inAnHour() }),
    ).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
  });

  it("snoozes a running thread, which the record shows when its turn completes", async () => {
    const { client, thread, record } = await withThread();
    const stream = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await stream.until("agent.item.delta");
    const snoozed = await client.call<Thread>("threads.snooze", {
      threadId: thread.id,
      until: inAnHour(),
    });
    await client.call("threads.interrupt", { threadId: thread.id });
    // The turn's end keeps the snooze: the client decides what wakes it (D77).
    const ended = await record((item) => item.lastTurn?.status === "interrupted");
    expect(ended.snoozedUntil).toBe(snoozed.snoozedUntil);
    expect(ended.snoozedAt).toBe(snoozed.snoozedAt);
  });
});

describe("jhin.threads: a drop as one write (D449)", () => {
  it("runs every step and appends their records in one batch", async () => {
    const { client, index, thread } = await withThread();
    const other = await client.call<Thread>("threads.create", {});
    const appended = index.events.length;
    const { threads } = await client.call<{ threads: Thread[] }>("threads.arrange", {
      steps: [
        { op: "pin", threadId: thread.id },
        { op: "reorder", threadId: thread.id, list: "pinned", orderKey: "n" },
        { op: "reorder", threadId: other.id, list: "active", orderKey: "c" },
      ],
    });
    expect(threads.map((item) => item.id).toSorted()).toEqual([thread.id, other.id].toSorted());
    const pinned = threads.find((item) => item.id === thread.id)!;
    expect(pinned).toMatchObject({ pinnedAt: expect.any(String), pinOrderKey: "n" });
    await index.untilMatch((event) => (event.payload as unknown as Thread).activeOrderKey === "c");
    // One append: both records' events share one sequence run, nothing between them.
    const fresh = index.events.slice(appended);
    expect(fresh.map((event) => (event.payload as unknown as Thread).id)).toEqual(
      threads.map((item) => item.id),
    );
    expect(fresh[1]!.sequence).toBe(fresh[0]!.sequence + 1);
  });

  it("leaves every thread as it was when one step is refused", async () => {
    const { client, thread } = await withThread();
    const other = await client.call<Thread>("threads.create", {});
    await expect(
      client.call("threads.arrange", {
        steps: [
          { op: "reorder", threadId: other.id, list: "active", orderKey: "c" },
          // Another device unpinned it meanwhile: the drop's keys no longer fit.
          { op: "reorder", threadId: thread.id, list: "pinned", orderKey: "n" },
        ],
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_PINNED" });
    const { thread: kept } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: other.id,
    });
    expect(kept.activeOrderKey).toBeUndefined();
  });

  it("checks each step against the steps before it on the same thread", async () => {
    const { client, thread } = await withThread();
    await client.call("threads.pin", { threadId: thread.id, orderKey: "n" });
    // Unpinned by the first step, the thread cannot take a pinned key in the second.
    await expect(
      client.call("threads.arrange", {
        steps: [
          { op: "unpin", threadId: thread.id },
          { op: "reorder", threadId: thread.id, list: "pinned", orderKey: "c" },
        ],
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_PINNED" });
    const { thread: kept } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(kept).toMatchObject({ pinnedAt: expect.any(String), pinOrderKey: "n" });
  });

  it("writes nothing for steps that change nothing", async () => {
    const { client, index, thread } = await withThread();
    const appended = index.events.length;
    expect(
      await client.call("threads.arrange", { steps: [{ op: "unpin", threadId: thread.id }] }),
    ).toEqual({ threads: [] });
    expect(index.events.length).toBe(appended);
  });
});
