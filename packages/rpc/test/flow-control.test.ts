import { noopLogger } from "@jhin/kernel";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  RPC_ACK,
  RPC_EVENT,
  RPC_SUBSCRIPTION_ENDED,
  createLiveStreams,
  createMemoryStreams,
  createPeerPair,
  createRpcClient,
  serveRpc,
  type Peer,
  type RpcError,
} from "../src/index.ts";
import { MAX_WAITING_CHARACTERS } from "../src/server.ts";

/** A node serving `live/` from memory, and the raw client end of one connection. */
function rawConnection() {
  const live = createLiveStreams();
  const memory = createMemoryStreams({ firstSequence: 1 });
  live.serve("live/", memory);
  const [clientEnd, serverEnd] = createPeerPair();
  serveRpc(serverEnd, {
    caller: { id: "caller", permissions: ["*"] },
    streams: live,
    logger: noopLogger,
    hello: () => ({}),
    newTraceId: () => "trace",
    execute: async () => ({}),
  });
  const messages: { id?: number; method?: string; params?: { event?: StoredEvent } }[] = [];
  const replies = new Map<number, () => void>();
  clientEnd.onMessage((text) => {
    const message = JSON.parse(text) as (typeof messages)[number];
    messages.push(message);
    if (message.id !== undefined) replies.get(message.id)?.();
  });
  let nextId = 1;
  /** A request; resolves with its reply, after every message the server sent before it. */
  const request = (method: string, params: unknown) => {
    const id = nextId++;
    const replied = new Promise<void>((resolve) => replies.set(id, resolve));
    clientEnd.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return replied;
  };
  const notify = (method: string, params: unknown) =>
    clientEnd.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  const events = () =>
    messages.filter((message) => message.method === RPC_EVENT).map((m) => m.params!.event!);
  return { memory, request, notify, events, messages, clientEnd: clientEnd as Peer };
}

describe("flow control (D470)", () => {
  it("keeps at most a window unacknowledged, and sends more as acknowledgements come", async () => {
    const { memory, request, notify, events } = rawConnection();
    for (const n of [1, 2, 3, 4, 5]) memory.append("live/a", "app.n", n);
    await request("rpc.subscribe", {
      subscription: "s",
      stream: "live/a",
      window: { events: 2, bytes: 1024 * 1024 },
    });
    expect(events().map((event) => event.payload)).toEqual([1, 2]);

    // Live events wait too.
    memory.append("live/a", "app.n", 6);
    await request("rpc.hello", {});
    expect(events()).toHaveLength(2);

    notify(RPC_ACK, { subscription: "s", sequence: 1 });
    await request("rpc.hello", {});
    expect(events().map((event) => event.payload)).toEqual([1, 2, 3]);

    // One acknowledgement for several events frees them all.
    notify(RPC_ACK, { subscription: "s", sequence: 3 });
    await request("rpc.hello", {});
    expect(events().map((event) => event.payload)).toEqual([1, 2, 3, 4, 5]);
    notify(RPC_ACK, { subscription: "s", sequence: 5 });
    await request("rpc.hello", {});
    expect(events().map((event) => event.payload)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("counts the window in JSON characters too", async () => {
    const { memory, request, notify, events } = rawConnection();
    memory.append("live/a", "app.n", "x".repeat(1500));
    memory.append("live/a", "app.n", "y");
    await request("rpc.subscribe", {
      subscription: "s",
      stream: "live/a",
      window: { events: 100, bytes: 1024 },
    });
    // The first is sent although it is larger than the window; the next waits.
    expect(events()).toHaveLength(1);
    notify(RPC_ACK, { subscription: "s", sequence: events()[0]!.sequence });
    await request("rpc.hello", {});
    expect(events()).toHaveLength(2);
  });

  it("sends everything as it comes without a window", async () => {
    const { memory, request, events } = rawConnection();
    for (const n of [1, 2, 3, 4, 5]) memory.append("live/a", "app.n", n);
    await request("rpc.subscribe", { subscription: "s", stream: "live/a" });
    expect(events()).toHaveLength(5);
  });

  it("ends a subscription that falls too far behind, and tells the client why", async () => {
    const { memory, request, events, messages } = rawConnection();
    await request("rpc.subscribe", {
      subscription: "s",
      stream: "live/a",
      window: { events: 1, bytes: 1024 },
    });
    const half = "z".repeat(MAX_WAITING_CHARACTERS / 2);
    memory.append("live/a", "app.n", "first");
    memory.append("live/a", "app.n", half);
    memory.append("live/a", "app.n", half);
    await request("rpc.hello", {});
    expect(events()).toHaveLength(1);
    const ended = messages.find((message) => message.method === RPC_SUBSCRIPTION_ENDED);
    expect(ended?.params).toMatchObject({
      subscription: "s",
      error: { data: { code: "SUBSCRIPTION_OVERFLOW" } },
    });
    // Nothing more comes for it.
    memory.append("live/a", "app.n", "late");
    await request("rpc.hello", {});
    expect(events()).toHaveLength(1);
  });

  it("acknowledges an event once its handler's promise settles, and reports an overflow", async () => {
    const live = createLiveStreams();
    const memory = createMemoryStreams({ firstSequence: 1 });
    live.serve("live/", memory);
    const client = createRpcClient({
      retryDelay: () => 0,
      async connect() {
        const [clientEnd, serverEnd] = createPeerPair();
        serveRpc(serverEnd, {
          caller: { id: "caller", permissions: ["*"] },
          streams: live,
          logger: noopLogger,
          hello: () => ({}),
          newTraceId: () => "trace",
          execute: async () => ({}),
        });
        return clientEnd;
      },
    });
    const seen: unknown[] = [];
    const done: (() => void)[] = [];
    let arrived!: () => void;
    let next = new Promise<void>((resolve) => (arrived = resolve));
    let failed!: (error: RpcError) => void;
    const failure = new Promise<RpcError>((resolve) => (failed = resolve));
    client.subscribe("live/a", { window: { events: 1, bytes: 1024 }, onError: failed }, (event) => {
      seen.push(event.payload);
      arrived();
      return new Promise<void>((resolve) => done.push(resolve));
    });
    memory.append("live/a", "app.n", 1);
    memory.append("live/a", "app.n", 2);
    await next;
    next = new Promise<void>((resolve) => (arrived = resolve));
    await client.call("rpc.hello");
    expect(seen).toEqual([1]);
    done.shift()!();
    await next;
    expect(seen).toEqual([1, 2]);

    // Unacknowledged past what the node keeps waiting: it ends the subscription.
    const half = "z".repeat(MAX_WAITING_CHARACTERS / 2);
    memory.append("live/a", "app.n", half);
    memory.append("live/a", "app.n", half);
    expect((await failure).code).toBe("SUBSCRIPTION_OVERFLOW");
    client.close();
  });

  /** A client of a node serving `live/` from memory, whose connection the test can cut. */
  function windowedClient() {
    const live = createLiveStreams();
    const memory = createMemoryStreams({ firstSequence: 1 });
    live.serve("live/", memory);
    const servers: Peer[] = [];
    const client = createRpcClient({
      retryDelay: () => 0,
      async connect() {
        const [clientEnd, serverEnd] = createPeerPair();
        servers.push(serverEnd);
        serveRpc(serverEnd, {
          caller: { id: "caller", permissions: ["*"] },
          streams: live,
          logger: noopLogger,
          hello: () => ({}),
          newTraceId: () => "trace",
          execute: async () => ({}),
        });
        return clientEnd;
      },
    });
    return { client, memory, servers };
  }

  it("fails a subscription whose backlog is past the bound, instead of hanging (D470)", async () => {
    const { client, memory } = windowedClient();
    const half = "z".repeat(MAX_WAITING_CHARACTERS / 2);
    memory.append("live/a", "app.n", "first");
    memory.append("live/a", "app.n", half);
    memory.append("live/a", "app.n", half);
    const failure = new Promise<RpcError>((resolve) =>
      client.subscribe(
        "live/a",
        { window: { events: 1, bytes: 1024 }, onError: resolve },
        () =>
          // Never shown: the window stays full.
          new Promise<void>(() => undefined),
      ),
    );
    expect((await failure).code).toBe("SUBSCRIPTION_OVERFLOW");
    client.close();
  });

  it("acknowledges the settled front only, and resent events after a reconnect", async () => {
    const { client, memory, servers } = windowedClient();
    const seen: number[] = [];
    const done = new Map<number, () => void>();
    const arrivals: { count: number; resolve: () => void }[] = [];
    const arrived = (count: number) =>
      seen.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => arrivals.push({ count, resolve }));
    client.subscribe("live/a", { window: { events: 2, bytes: 1024 * 1024 } }, (event) => {
      seen.push(event.payload as number);
      for (const waiter of arrivals.filter((item) => seen.length >= item.count)) {
        arrivals.splice(arrivals.indexOf(waiter), 1);
        waiter.resolve();
      }
      return new Promise<void>((resolve) => done.set(event.payload as number, resolve));
    });
    for (const n of [1, 2, 3]) memory.append("live/a", "app.n", n);
    await arrived(2);
    // The second is shown before the first: nothing may be acknowledged yet.
    done.get(2)!();
    await client.call("rpc.hello");
    await client.call("rpc.hello");
    expect(seen).toEqual([1, 2]);
    done.get(1)!();
    await arrived(3);
    expect(seen).toEqual([1, 2, 3]);

    // A reconnect resends from where the client is; with a window of one,
    // an event the client already had must not hold the window.
    done.get(3)!();
    await client.call("rpc.hello");
    const reopened = new Promise<void>((resolve) => {
      const watching = client.onState((state) => {
        if (state !== "open") return;
        watching.dispose();
        resolve();
      });
    });
    servers.at(-1)!.close(1006, "cut by test");
    await reopened;
    memory.append("live/a", "app.n", 4);
    await arrived(4);
    done.get(4)!();
    memory.append("live/a", "app.n", 5);
    await arrived(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    client.close();
  });
});
