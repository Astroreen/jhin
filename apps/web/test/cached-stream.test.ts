import { ThreadEvents } from "@jhin/agent-api";
import type { CachedStream, HistoryCache, StreamEvent } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { followCachedStream, type StreamInfo } from "../src/plugins/chat/cached-stream.ts";

const STREAM = "thread/t1";
const event = (sequence: number, type = "agent.turn.message"): StreamEvent => ({
  stream: STREAM,
  sequence,
  type,
  payload: { sequence },
  at: "2026-10-24T00:00:00.000Z",
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => event(from + index));

/** A history cache in memory that records what it was asked. */
function memoryCache(kept?: CachedStream) {
  const streams = new Map<string, CachedStream>();
  if (kept !== undefined) streams.set(`node|${STREAM}`, kept);
  const calls: string[] = [];
  const cache: HistoryCache = {
    enabled: () => true,
    async read(connection, stream) {
      calls.push(`read ${stream}`);
      return streams.get(`${connection}|${stream}`);
    },
    async append(connection, stream, epoch, events) {
      calls.push(`append ${events.map((item) => item.sequence).join(",")}`);
      const current = streams.get(`${connection}|${stream}`);
      const base = current?.epoch === epoch ? current.events : [];
      const all = [...base, ...events];
      streams.set(`${connection}|${stream}`, {
        epoch,
        lastSequence: all.at(-1)!.sequence,
        events: all,
      });
    },
    async drop(connection, stream) {
      calls.push(`drop ${stream}`);
      streams.delete(`${connection}|${stream}`);
    },
  };
  return { cache, calls, streams };
}

/** A client whose subscriptions the test feeds by hand. */
function fakeClient() {
  const subscriptions: {
    after: number;
    disposed: boolean;
    push(event: StreamEvent): void;
  }[] = [];
  const waiters: (() => void)[] = [];
  return {
    subscriptions,
    /** Resolves once the n-th subscription (from 1) exists. */
    subscribed(count: number) {
      return new Promise<void>((resolve) => {
        const check = () => (subscriptions.length >= count ? resolve() : waiters.push(check));
        check();
      });
    },
    client: {
      subscribe(
        _stream: string,
        options: { after?: number },
        onEvent: (event: StreamEvent) => void,
      ) {
        const entry = {
          after: options.after ?? 0,
          disposed: false,
          push: (item: StreamEvent) => {
            if (!entry.disposed) onEvent(item);
          },
        };
        subscriptions.push(entry);
        for (const waiter of waiters.splice(0)) waiter();
        return {
          lastSequence: 0,
          dispose: () => {
            entry.disposed = true;
          },
        };
      },
    },
  };
}

function follow(cache: HistoryCache | undefined, info: () => Promise<StreamInfo>) {
  const rpc = fakeClient();
  const batches: { sequences: number[]; reset: boolean }[] = [];
  let infoCalls = 0;
  const flushes: (() => void)[] = [];
  const handle = followCachedStream({
    client: rpc.client as never,
    cache,
    connection: "node",
    stream: STREAM,
    info: () => {
      infoCalls += 1;
      return info();
    },
    schedule: (flush) => {
      flushes.push(flush);
      return () => flushes.splice(flushes.indexOf(flush), 1);
    },
    onBatch: (events, reset) =>
      batches.push({ sequences: events.map((item) => item.sequence), reset }),
    onError: (error) => {
      throw error;
    },
  });
  return {
    ...rpc,
    batches,
    handle,
    infoCalls: () => infoCalls,
    /** Runs the frame that folds what arrived. */
    frame: () => {
      for (const flush of flushes.splice(0)) flush();
    },
  };
}

describe("a thread opens from the history cache (loading.md D1589, D1590)", () => {
  it("shows what is kept at once, then asks only for what follows and keeps it", async () => {
    const { cache, calls, streams } = memoryCache({
      epoch: "e1",
      lastSequence: 3,
      events: range(1, 3),
    });
    const run = follow(cache, async () => ({ epoch: "e1", head: 5 }));
    await run.subscribed(1);
    expect(run.batches).toEqual([{ sequences: [1, 2, 3], reset: true }]);
    expect(run.subscriptions[0]!.after).toBe(3);
    run.subscriptions[0]!.push(event(4));
    run.subscriptions[0]!.push(event(5));
    run.frame();
    expect(run.batches.at(-1)).toEqual({ sequences: [4, 5], reset: false });
    // One write for the batch of the frame.
    await Promise.resolve();
    expect(calls).toEqual(["read thread/t1", "append 4,5"]);
    expect(streams.get(`node|${STREAM}`)?.lastSequence).toBe(5);
  });

  it("with nothing kept follows from 0 and keeps the stream under the node's epoch", async () => {
    const { cache, streams } = memoryCache();
    const run = follow(cache, async () => ({ epoch: "e1", head: 2 }));
    await run.subscribed(1);
    expect(run.subscriptions[0]!.after).toBe(0);
    run.subscriptions[0]!.push(event(1));
    run.subscriptions[0]!.push(event(2));
    run.frame();
    await Promise.resolve();
    expect(streams.get(`node|${STREAM}`)).toMatchObject({ epoch: "e1", lastSequence: 2 });
  });

  it("drops what is kept under another epoch and reads the stream from 0", async () => {
    const { cache, calls, streams } = memoryCache({
      epoch: "old",
      lastSequence: 3,
      events: range(1, 3),
    });
    const run = follow(cache, async () => ({ epoch: "new", head: 3 }));
    await run.subscribed(1);
    expect(run.subscriptions[0]!.after).toBe(0);
    expect(calls).toContain("drop thread/t1");
    run.subscriptions[0]!.push(event(1));
    run.frame();
    // The kept events were shown, then folded again from nothing.
    expect(run.batches).toEqual([
      { sequences: [1, 2, 3], reset: true },
      { sequences: [1], reset: true },
    ]);
    await Promise.resolve();
    expect(streams.get(`node|${STREAM}`)).toMatchObject({ epoch: "new", lastSequence: 1 });
  });

  it("drops what is kept when the node's head is lower than its last sequence", async () => {
    const { cache, calls } = memoryCache({ epoch: "e1", lastSequence: 4, events: range(1, 4) });
    const run = follow(cache, async () => ({ epoch: "e1", head: 2 }));
    await run.subscribed(1);
    expect(run.subscriptions[0]!.after).toBe(0);
    expect(calls).toContain("drop thread/t1");
  });

  it("drops what is kept of a node that has no epoch", async () => {
    const { cache, calls } = memoryCache({ epoch: "e1", lastSequence: 2, events: range(1, 2) });
    const run = follow(cache, async () => ({ head: 2 }));
    await run.subscribed(1);
    expect(run.subscriptions[0]!.after).toBe(0);
    expect(calls).toContain("drop thread/t1");
    run.subscriptions[0]!.push(event(1));
    run.frame();
    await Promise.resolve();
    // Nothing is kept without an epoch to keep it under.
    expect(calls.filter((call) => call.startsWith("append"))).toEqual([]);
  });

  it("starts over from 0 when the first event is not the one after the kept ones (a gap, D498)", async () => {
    const { cache, calls } = memoryCache({ epoch: "e1", lastSequence: 3, events: range(1, 3) });
    const run = follow(cache, async () => ({ epoch: "e1", head: 9 }));
    await run.subscribed(1);
    run.subscriptions[0]!.push(event(7));
    await run.subscribed(2);
    expect(run.subscriptions[0]!.disposed).toBe(true);
    expect(run.subscriptions[1]!.after).toBe(0);
    expect(calls).toContain("drop thread/t1");
    run.subscriptions[1]!.push(event(1));
    run.frame();
    expect(run.batches.at(-1)).toEqual({ sequences: [1], reset: true });
  });

  it("drops what is kept of a thread that is gone", async () => {
    const { cache, calls } = memoryCache({ epoch: "e1", lastSequence: 2, events: range(1, 2) });
    const run = follow(cache, () =>
      Promise.reject(Object.assign(new Error("gone"), { code: "THREAD_NOT_FOUND" })),
    );
    await run.subscribed(1);
    expect(calls).toContain("drop thread/t1");
    expect(run.subscriptions[0]!.after).toBe(0);
  });

  it("forgets a thread whose stream says it was deleted", async () => {
    const { cache, calls, streams } = memoryCache();
    const run = follow(cache, async () => ({ epoch: "e1", head: 2 }));
    await run.subscribed(1);
    run.subscriptions[0]!.push(event(1));
    run.subscriptions[0]!.push(event(2, ThreadEvents.threadDeleted));
    run.frame();
    await Promise.resolve();
    expect(calls).toContain("drop thread/t1");
    expect(streams.size).toBe(0);
  });

  it("without a cache follows from 0 and never asks the node for its epoch", async () => {
    const run = follow(undefined, async () => ({ epoch: "e1", head: 1 }));
    await run.subscribed(1);
    expect(run.subscriptions[0]!.after).toBe(0);
    expect(run.infoCalls()).toBe(0);
  });

  it("keeps a thread opened before its creation reached the node, once its events come", async () => {
    const { cache, streams } = memoryCache();
    let created = false;
    const run = follow(cache, () =>
      created
        ? Promise.resolve({ epoch: "e1", head: 2 })
        : Promise.reject(Object.assign(new Error("not yet"), { code: "THREAD_NOT_FOUND" })),
    );
    await run.subscribed(1);
    created = true;
    run.subscriptions[0]!.push(event(1));
    run.frame();
    run.subscriptions[0]!.push(event(2));
    run.frame();
    // The second answer comes after both frames: what came meanwhile is kept at once.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    expect(streams.get(`node|${STREAM}`)).toMatchObject({ epoch: "e1", lastSequence: 2 });
    run.subscriptions[0]!.push(event(3));
    run.frame();
    expect(streams.get(`node|${STREAM}`)?.lastSequence).toBe(3);
  });

  it("follows what is kept when the node cannot be asked, and keeps nothing new", async () => {
    const { cache, calls } = memoryCache({ epoch: "e1", lastSequence: 3, events: range(1, 3) });
    const run = follow(cache, () =>
      Promise.reject(Object.assign(new Error("closed"), { code: "DISCONNECTED" })),
    );
    await run.subscribed(1);
    expect(run.subscriptions[0]!.after).toBe(3);
    expect(calls).not.toContain("drop thread/t1");
    run.subscriptions[0]!.push(event(4));
    run.frame();
    expect(run.batches.at(-1)).toEqual({ sequences: [4], reset: false });
    await Promise.resolve();
    expect(calls.filter((call) => call.startsWith("append"))).toEqual([]);
  });
});
