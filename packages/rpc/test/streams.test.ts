import { noopLogger } from "@jhin/kernel";
import { createMemoryStorage, type StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  createLiveStreams,
  createMemoryStreams,
  createPeerPair,
  createRpcClient,
  serveRpc,
  type LiveStreams,
  type Peer,
} from "../src/index.ts";

function harness(live: LiveStreams, permissions: string[] = ["*"]) {
  const storage = createMemoryStorage();
  const servers: Peer[] = [];
  const client = createRpcClient({
    retryDelay: () => 0,
    async connect() {
      const [clientEnd, serverEnd] = createPeerPair();
      servers.push(serverEnd);
      serveRpc(serverEnd, {
        caller: { id: "caller", permissions },
        log: storage.log,
        streams: live,
        logger: noopLogger,
        hello: () => ({}),
        newTraceId: () => "trace",
        execute: async () => ({}),
      });
      return clientEnd;
    },
  });
  return { client, storage, servers };
}

function collect(client: ReturnType<typeof harness>["client"], stream: string) {
  const events: StoredEvent[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  client.subscribe(stream, {}, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.count <= events.length)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  const reach = (count: number) =>
    events.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ count, resolve }));
  return { events, reach };
}

describe("live streams", () => {
  it("serves a stream from memory: what is kept, then what comes", async () => {
    const live = createLiveStreams();
    const memory = createMemoryStreams({ firstSequence: 1 });
    live.serve("live/", memory);
    const { client, storage } = harness(live);
    memory.append("live/a", "app.n", 1);
    memory.append("live/a", "app.n", 2);
    memory.drop("live/a", 1);
    await storage.log.append("other", [{ type: "app.n", payload: 9 }]);

    const fromMemory = collect(client, "live/a");
    const fromLog = collect(client, "other");
    await fromMemory.reach(1);
    memory.append("live/a", "app.n", 3);
    await fromMemory.reach(2);
    await fromLog.reach(1);

    expect(fromMemory.events.map((event) => [event.sequence, event.payload])).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(fromLog.events.map((event) => event.payload)).toEqual([9]);
    client.close();
  });

  it("resumes after a restart of the streams without waiting for old sequences", async () => {
    const live = createLiveStreams();
    let memory = createMemoryStreams({ firstSequence: 1000 });
    let served = live.serve("s", memory);
    const { client, servers } = harness(live);
    const seen = collect(client, "s");
    memory.append("s", "app.n", "before");
    await seen.reach(1);

    // The plugin keeping the stream starts over later, as after a node restart.
    served.dispose();
    memory = createMemoryStreams({ firstSequence: 2000 });
    served = live.serve("s", memory);
    memory.append("s", "app.n", "after");
    servers.at(-1)!.close(1006, "network gone");
    await seen.reach(2);

    expect(seen.events.map((event) => event.payload)).toEqual(["before", "after"]);
    client.close();
  });

  it("refuses a subscriber without the stream's permissions", async () => {
    const live = createLiveStreams();
    const memory = createMemoryStreams({ firstSequence: 1 });
    live.serve("secret/", memory, { permissions: ["secret.read"] });
    memory.append("secret/a", "app.n", 1);
    const refused = harness(live, ["other"]);
    await expect(
      new Promise((_, reject) =>
        refused.client.subscribe("secret/a", { onError: reject }, () => undefined),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", rpcCode: -32003 });
    refused.client.close();

    const allowed = harness(live, ["secret.read"]);
    const seen = collect(allowed.client, "secret/a");
    await seen.reach(1);
    expect(seen.events[0]?.payload).toBe(1);
    allowed.client.close();
  });

  it("starts a deleted stream over above its old sequences", () => {
    const memory = createMemoryStreams();
    const before = memory.append("s", "app.n", 1).sequence;
    memory.delete("s");
    expect(memory.events("s")).toEqual([]);
    expect(memory.append("s", "app.n", 2).sequence).toBeGreaterThan(before);
  });

  it("delivers to every listener and keeps the event when one listener throws", () => {
    const warnings: unknown[] = [];
    const memory = createMemoryStreams({
      firstSequence: 1,
      log: { warn: (message, fields) => warnings.push({ message, fields }) },
    });
    const seen: number[] = [];
    // A subscriber whose peer just closed: its send throws.
    memory.subscribe("s", () => {
      throw new Error("peer closed");
    });
    memory.subscribe("s", (event) => seen.push(event.sequence));

    const event = memory.append("s", "app.n", 1);
    expect(event.sequence).toBe(1);
    expect(seen).toEqual([1]);
    expect(memory.events("s")).toEqual([event]);
    expect(warnings).toEqual([
      {
        message: "a live stream listener failed",
        fields: { stream: "s", sequence: 1, error: "Error: peer closed" },
      },
    ]);
  });

  it("removes events in place: a held events() array follows", () => {
    const memory = createMemoryStreams({ firstSequence: 1 });
    for (const n of [1, 2, 3, 4]) memory.append("s", "app.n", n);
    const held = memory.events("s");
    memory.remove("s", new Set([1, 3]));
    expect(held.map((event) => event.payload)).toEqual([2, 4]);
    expect(memory.events("s")).toBe(held);
    memory.drop("s", 1);
    expect(held.map((event) => event.payload)).toEqual([4]);
  });

  it("keeps counting after a stream is cleared", () => {
    const memory = createMemoryStreams({ firstSequence: 5 });
    memory.append("s", "app.n", 1);
    memory.clear("s");
    expect(memory.events("s")).toEqual([]);
    expect(memory.append("s", "app.n", 2).sequence).toBe(6);
  });

  it("picks the longest prefix and refuses a name served twice", () => {
    const live = createLiveStreams();
    const a = createMemoryStreams();
    const b = createMemoryStreams();
    live.serve("t/", a);
    live.serve("t/x/", b);
    expect(live.sourceOf("t/y")?.source).toBe(a);
    expect(live.sourceOf("t/x/1")?.source).toBe(b);
    expect(live.sourceOf("t")).toBeUndefined();
    expect(() => live.serve("t/", b)).toThrow("already served");
  });
});
