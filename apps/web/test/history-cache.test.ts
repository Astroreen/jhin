import type { Connections, NodeConnection, StreamEvent } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  createHistoryCache,
  forgetWithConnections,
  STALE_AFTER_MS,
} from "../src/plugins/history-cache/service.ts";
import type { HistoryStore, StreamEntry } from "../src/plugins/history-cache/store.ts";

const event = (sequence: number): StreamEvent => ({
  stream: "thread/a",
  sequence,
  type: "agent.turn.message",
  payload: {},
  at: "",
});

/** A store in memory whose writes fail with the quota while `full` says so. */
function memoryStore(entries: StreamEntry[] = []) {
  let kept = [...entries];
  const state = { full: 0, appends: 0 };
  const store: HistoryStore = {
    read: async (connection, stream) =>
      kept.some((entry) => entry.connection === connection && entry.stream === stream)
        ? { epoch: "e1", lastSequence: 0, events: [] }
        : undefined,
    async append(connection, stream, epoch, events, now) {
      state.appends += 1;
      if (state.full > 0) {
        state.full -= 1;
        throw new DOMException("full", "QuotaExceededError");
      }
      kept = kept.filter((entry) => entry.connection !== connection || entry.stream !== stream);
      kept.push({
        connection,
        stream,
        epoch,
        lastSequence: events.at(-1)!.sequence,
        openedAt: now,
        bytes: 10,
      });
    },
    async drop(connection, stream) {
      kept = kept.filter(
        (entry) =>
          (connection !== undefined && entry.connection !== connection) ||
          (stream !== undefined && entry.stream !== stream),
      );
    },
    readCatalog: async () => undefined,
    writeCatalog: async () => undefined,
    entries: async () => [...kept],
    close: () => undefined,
  };
  return { store, state, kept: () => kept.map((entry) => `${entry.connection} ${entry.stream}`) };
}

const entry = (connection: string, stream: string, openedAt: number): StreamEntry => ({
  connection,
  stream,
  epoch: "e1",
  lastSequence: 1,
  openedAt,
  bytes: 100,
});

describe("the history cache's service (loading.md D1592, D1593)", () => {
  it("off, reads and writes nothing", async () => {
    const { store, state } = memoryStore([entry("n", "thread/a", 0)]);
    const cache = createHistoryCache(store, { enabled: () => false });
    expect(cache.enabled()).toBe(false);
    expect(await cache.read("n", "thread/a")).toBeUndefined();
    await cache.append("n", "thread/b", "e1", [event(1)]);
    expect(state.appends).toBe(0);
    expect(await cache.status()).toEqual({ enabled: false, entries: 1, bytes: 100 });
  });

  it("over the quota forgets the least recently opened streams and writes again", async () => {
    const { store, state, kept } = memoryStore([
      entry("n", "thread/old", 1),
      entry("n", "thread/newer", 2),
      entry("n", "thread/newest", 3),
    ]);
    state.full = 1;
    const cache = createHistoryCache(store, { enabled: () => true, now: () => 10 });
    await cache.append("n", "thread/a", "e1", [event(1)]);
    expect(kept()).toEqual(["n thread/newer", "n thread/newest", "n thread/a"]);
    expect(cache.enabled()).toBe(true);
  });

  it("stops for the session when a write is still over the quota", async () => {
    const { store, state } = memoryStore([entry("n", "thread/old", 1)]);
    state.full = 2;
    const cache = createHistoryCache(store, { enabled: () => true });
    await expect(cache.append("n", "thread/a", "e1", [event(1)])).rejects.toThrow("full");
    expect(cache.enabled()).toBe(false);
    // Threads then open from 0.
    expect(await cache.read("n", "thread/old")).toBeUndefined();
  });

  it("forgets the streams no thread opened for 30 days", async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const { store, kept } = memoryStore([
      entry("n", "thread/stale", now - STALE_AFTER_MS - 1),
      entry("n", "thread/recent", now - 1000),
    ]);
    const cache = createHistoryCache(store, { enabled: () => true, now: () => now });
    expect(await cache.evictStale()).toBe(1);
    expect(kept()).toEqual(["n thread/recent"]);
  });

  it("clears one connection or everything and says how many streams went", async () => {
    const { store, kept } = memoryStore([
      entry("one", "thread/a", 0),
      entry("one", "thread/b", 0),
      entry("two", "thread/a", 0),
    ]);
    const cache = createHistoryCache(store, { enabled: () => true });
    expect(await cache.clear("one")).toBe(2);
    expect(kept()).toEqual(["two thread/a"]);
    expect(await cache.clear()).toBe(1);
    expect(kept()).toEqual([]);
  });
});

describe("what a device forgets, the cache forgets (D1593)", () => {
  function connections() {
    let list: NodeConnection[] = [];
    const listeners = new Set<() => void>();
    const node = (id: string, closeCode?: string): NodeConnection =>
      ({
        id,
        url: id,
        label: id,
        state: closeCode === undefined ? "open" : "closed",
        client: { closeReason: closeCode === undefined ? undefined : { code: closeCode } },
      }) as unknown as NodeConnection;
    const service = {
      list: () => list,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    } as unknown as Connections;
    return {
      service,
      set(next: NodeConnection[]) {
        list = next;
        for (const listener of listeners) listener();
      },
      node,
    };
  }

  it("forgets a node once it is removed, and never one that was not there yet", () => {
    const nodes = connections();
    const forgotten: string[] = [];
    const watch = forgetWithConnections(nodes.service, (id) => forgotten.push(id));
    nodes.set([nodes.node("a"), nodes.node("b")]);
    expect(forgotten).toEqual([]);
    nodes.set([nodes.node("b")]);
    expect(forgotten).toEqual(["a"]);
    watch.dispose();
  });

  it("forgets a node whose token was refused, once", () => {
    const nodes = connections();
    const forgotten: string[] = [];
    forgetWithConnections(nodes.service, (id) => forgotten.push(id));
    nodes.set([nodes.node("a")]);
    nodes.set([nodes.node("a", "DISCONNECTED")]);
    expect(forgotten).toEqual([]);
    nodes.set([nodes.node("a", "UNAUTHENTICATED")]);
    nodes.set([nodes.node("a", "UNAUTHENTICATED")]);
    expect(forgotten).toEqual(["a"]);
  });
});
