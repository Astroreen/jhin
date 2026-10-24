import {
  CONNECTIONS_CAPABILITY,
  type Connections,
  type NodeConnection,
  type StreamEvent,
} from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { createTestKernel, mockCapability } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { historyCachePlugin } from "../src/plugins/history-cache/index.ts";
import { STALE_AFTER_MS } from "../src/plugins/history-cache/service.ts";
import { DATABASE, openHistoryStore } from "../src/plugins/history-cache/store.ts";

const event = (stream: string, sequence: number): StreamEvent => ({
  stream,
  sequence,
  type: "agent.turn.message",
  payload: {},
  at: "2026-10-24T00:00:00.000Z",
});

afterEach(
  () =>
    new Promise<void>((resolve) => {
      const deleting = indexedDB.deleteDatabase(DATABASE);
      deleting.addEventListener("success", () => resolve());
    }),
);

/** Saved connections the test changes; `set` tells the listeners once. */
function savedNodes(ids: string[]) {
  let list = ids;
  const listeners = new Set<() => void>();
  const node = (id: string) =>
    ({ id, url: id, label: id, state: "open", client: {} }) as unknown as NodeConnection;
  const connections = {
    list: () => list.map(node),
    get: (id: string) => (list.includes(id) ? node(id) : undefined),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as Connections;
  return {
    connections,
    set(next: string[]) {
      list = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

type Status = { enabled: boolean; entries: number; bytes: number };

describe("jhin.history-cache (loading.md D1592, D1593)", () => {
  it("evicts stale streams at boot, forgets a removed node, and deletes everything when turned off", async () => {
    // What an earlier session kept: one stream opened long ago, two lately.
    const seed = openHistoryStore();
    const now = Date.now();
    await seed.append("a", "thread/old", "e1", [event("thread/old", 1)], now - STALE_AFTER_MS - 1);
    await seed.append("a", "thread/new", "e1", [event("thread/new", 1)], now);
    await seed.append("b", "thread/new", "e2", [event("thread/new", 1)], now);
    seed.close();

    const nodes = savedNodes(["a", "b"]);
    const kernel = await createTestKernel({
      side: "client",
      plugins: [mockCapability(CONNECTIONS_CAPABILITY, nodes.connections), historyCachePlugin],
    });
    const status = () => kernel.commands.execute("history-cache.status", {}) as Promise<Status>;
    // The status waits for what the boot queued: the stale stream is gone.
    expect(await status()).toMatchObject({ enabled: true, entries: 2 });

    nodes.set(["a"]);
    expect(await status()).toMatchObject({ entries: 1 });

    kernel.config.setLayer("node", { "jhin.history-cache": { enabled: false } });
    expect(await status()).toEqual({ enabled: false, entries: 0, bytes: 0 });
    await kernel.stop();
  });

  it("deletes what is kept at boot when the setting is off", async () => {
    const seed = openHistoryStore();
    await seed.append("a", "thread/new", "e1", [event("thread/new", 1)], Date.now());
    seed.close();
    const kernel = await createTestKernel({
      side: "client",
      plugins: [historyCachePlugin],
      config: { node: { "jhin.history-cache": { enabled: false } } },
    });
    expect(await kernel.commands.execute("history-cache.status", {})).toEqual({
      enabled: false,
      entries: 0,
      bytes: 0,
    });
    expect(await kernel.commands.execute("history-cache.clear", {})).toEqual({ cleared: 0 });
    await kernel.stop();
  });
});
