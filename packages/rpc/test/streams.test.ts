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

describe("guarded streams of the event log (security.md D415)", () => {
  /** Subscribes once through the protocol itself: resolves with the head, or rejects. */
  const subscribe = (client: ReturnType<typeof harness>["client"], stream: string) =>
    client.call("rpc.subscribe", { subscription: `s-${stream}`, stream });

  it("needs what a guard names, or events.read for a stream nobody guards", async () => {
    const live = createLiveStreams();
    live.guard("thread/", ["threads.read"]);
    live.guard("threads", ["threads.read"]);

    const reader = harness(live, ["threads.read"]);
    await reader.storage.log.append("thread/1", [{ type: "app.a", payload: 1 }]);
    await expect(subscribe(reader.client, "thread/1")).resolves.toMatchObject({ head: 1 });
    await expect(subscribe(reader.client, "other")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { stream: "other", missing: ["events.read"] },
    });

    const stranger = harness(live, ["git.*"]);
    await expect(subscribe(stranger.client, "threads")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { missing: ["threads.read"] },
    });

    // A pattern grant holds what a guard names.
    const patterned = harness(live, ["threads.*", "events.read"]);
    await expect(subscribe(patterned.client, "threads")).resolves.toMatchObject({ head: 0 });
    await expect(subscribe(patterned.client, "other")).resolves.toMatchObject({ head: 0 });
    for (const { client } of [reader, stranger, patterned]) client.close();
  });

  it("asks a guard given as a function per stream", () => {
    const live = createLiveStreams();
    live.guard("mirror/", (stream) =>
      stream.endsWith("/mesh") ? ["mesh.read"] : ["threads.read"],
    );
    expect(live.guardOf("mirror/n1/mesh")).toEqual(["mesh.read"]);
    expect(live.guardOf("mirror/n1/thread/7")).toEqual(["threads.read"]);
  });

  it("refuses a name guarded twice and frees it on dispose", () => {
    const live = createLiveStreams();
    const first = live.guard("a/", ["x"]);
    expect(() => live.guard("a/", ["y"])).toThrow(/already guarded/);
    expect(live.guardOf("a/b/c")).toEqual(["x"]);
    first.dispose();
    expect(live.guardOf("a/b")).toBeUndefined();
  });
});

describe("followed sources (rpc.streams@1.2, D500)", () => {
  /** A source that reads elsewhere: the test feeds it, and settles when it is attached. */
  function elsewhere() {
    const opened: {
      stream: string;
      after: number;
      listener: (event: StoredEvent) => void;
      end: (error: unknown) => void;
      attach(head: number): void;
      refuse(error: Error): void;
      disposed: boolean;
    }[] = [];
    let opening!: () => void;
    /** Resolves once the server followed the source. */
    const firstOpen = new Promise<void>((resolve) => (opening = resolve));
    const source = {
      head: async () => 0,
      read: async () => [],
      subscribe: () => ({ dispose: () => undefined }),
      follow(
        stream: string,
        after: number,
        listener: (event: StoredEvent) => void,
        end: (error: unknown) => void,
      ) {
        let attach!: (head: number) => void;
        let refuse!: (error: Error) => void;
        const ready = new Promise<number>((ok, fail) => {
          attach = ok;
          refuse = fail;
        });
        const entry = { stream, after, listener, end, attach, refuse, disposed: false };
        opened.push(entry);
        opening();
        return { ready, dispose: () => void (entry.disposed = true) };
      },
    };
    const event = (sequence: number): StoredEvent => ({
      stream: "relay/x/s",
      sequence,
      type: "app.a",
      payload: sequence,
      at: "",
    });
    return { source, opened, event, firstOpen };
  }

  it("answers with the head once the source attached, and passes its events on once each", async () => {
    const live = createLiveStreams();
    const { source, opened, event, firstOpen } = elsewhere();
    live.serve("relay/", source);
    const { client } = harness(live);
    const heads: number[] = [];
    const events: number[] = [];
    let delivered!: () => void;
    const two = new Promise<void>((resolve) => (delivered = resolve));
    const ready = new Promise<void>((resolve) =>
      client.subscribe(
        "relay/x/s",
        {
          after: 4,
          onReady: (head) => {
            heads.push(head);
            resolve();
          },
        },
        (item) => {
          events.push(item.sequence);
          if (events.length === 2) delivered();
        },
      ),
    );
    await firstOpen;
    expect(opened[0]).toMatchObject({ stream: "relay/x/s", after: 4 });
    opened[0]!.listener(event(5));
    opened[0]!.attach(7);
    await ready;
    opened[0]!.listener(event(5));
    opened[0]!.listener(event(6));
    await two;
    expect(heads).toEqual([7]);
    expect(events).toEqual([5, 6]);
  });

  it("fails the subscription with the source's error, leaving nothing behind", async () => {
    const live = createLiveStreams();
    const { source, opened, firstOpen } = elsewhere();
    live.serve("relay/", source);
    const { client } = harness(live);
    const failed = new Promise<{ code: string }>((resolve) =>
      client.subscribe("relay/x/s", { onError: (error) => resolve(error) }, () => undefined),
    );
    await firstOpen;
    opened[0]!.refuse(Object.assign(new Error("not shared"), { code: "STREAM_NOT_SHARED" }));
    expect(await failed).toMatchObject({ code: "STREAM_NOT_SHARED" });
    expect(opened[0]!.disposed).toBe(true);
  });

  it("ends an attached subscription when the source ends it, telling the client (rpc.subscription.ended)", async () => {
    const live = createLiveStreams();
    const { source, opened, firstOpen } = elsewhere();
    live.serve("relay/", source);
    const { client } = harness(live);
    let attached!: () => void;
    const ready = new Promise<void>((resolve) => (attached = resolve));
    const ended = new Promise<{ code: string }>((resolve) =>
      client.subscribe(
        "relay/x/s",
        { onReady: () => attached(), onError: (error) => resolve(error) },
        () => undefined,
      ),
    );
    await firstOpen;
    opened[0]!.attach(1);
    await ready;
    opened[0]!.end(Object.assign(new Error("not shared"), { code: "STREAM_NOT_SHARED" }));
    expect(await ended).toMatchObject({ code: "STREAM_NOT_SHARED" });
    expect(opened[0]!.disposed).toBe(true);
  });

  it("takes events and an end a source sends while follow() still runs", async () => {
    const live = createLiveStreams();
    const event = (sequence: number): StoredEvent => ({
      stream: "relay/x/s",
      sequence,
      type: "app.a",
      payload: sequence,
      at: "",
    });
    live.serve("relay/", {
      head: async () => 0,
      read: async () => [],
      subscribe: () => ({ dispose: () => undefined }),
      follow(_stream, _after, listener, end) {
        listener(event(1));
        end(Object.assign(new Error("gone"), { code: "STREAM_NOT_SHARED" }));
        return { ready: Promise.resolve(1), dispose: () => undefined };
      },
    });
    const { client } = harness(live);
    const seen: number[] = [];
    const ended = new Promise<{ code: string }>((resolve) =>
      client.subscribe("relay/x/s", { onError: (error) => resolve(error) }, (item) => {
        seen.push(item.sequence);
      }),
    );
    expect(await ended).toMatchObject({ code: "STREAM_NOT_SHARED" });
    expect(seen).toEqual([1]);
  });
});
