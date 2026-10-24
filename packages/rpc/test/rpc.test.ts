import { noopLogger } from "@jhin/kernel";
import { createMemoryStorage, type StoredEvent } from "@jhin/storage-api";
import type { Invocation } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  createCaller,
  createPeerPair,
  createRpcClient,
  serveRpc,
  type Peer,
  type RpcClient,
  webSocketPeer,
} from "../src/index.ts";

interface Harness {
  readonly client: RpcClient;
  readonly storage: ReturnType<typeof createMemoryStorage>;
  readonly invocations: Invocation[];
  /** Server ends of every connection so far, newest last. */
  readonly servers: Peer[];
}

function harness(options: { refuse?: boolean } = {}): Harness {
  const storage = createMemoryStorage();
  const invocations: Invocation[] = [];
  const servers: Peer[] = [];
  let traces = 0;
  const client = createRpcClient({
    retryDelay: () => 0,
    async connect() {
      if (options.refuse === true)
        throw Object.assign(new Error("Token refused"), { code: "UNAUTHENTICATED" });
      const [clientEnd, serverEnd] = createPeerPair();
      servers.push(serverEnd);
      serveRpc(serverEnd, {
        caller: { id: "owner", permissions: ["*"] },
        log: storage.log,
        logger: noopLogger,
        hello: () => ({ node: "test" }),
        newTraceId: () => `generated-${++traces}`,
        async execute(name, input, invocation) {
          invocations.push(invocation);
          if (name === "app.echo") return input;
          if (name === "app.fail")
            throw Object.assign(new Error("bad input"), {
              code: "COMMAND_INPUT_INVALID",
              details: { path: "x" },
            });
          if (name === "app.hang") return new Promise(() => undefined);
          throw Object.assign(new Error(`Command ${name} is not registered`), {
            code: "COMMAND_NOT_FOUND",
          });
        },
      });
      return clientEnd;
    },
  });
  return { client, storage, invocations, servers };
}

/** Collects events; `reach(n)` resolves once n events arrived. */
function collect(client: RpcClient, stream: string, after = 0) {
  const events: StoredEvent[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const subscription = client.subscribe(stream, { after }, (event) => {
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
  return { events, reach, subscription };
}

const append = (storage: Harness["storage"], stream: string, from: number, to: number) =>
  storage.log.append(
    stream,
    Array.from({ length: to - from + 1 }, (_, index) => ({ type: "app.n", payload: from + index })),
  );

function nextState(client: RpcClient, state: string): Promise<void> {
  return new Promise((resolve) => {
    const subscription = client.onState((next) => {
      if (next === state) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

describe("rpc", () => {
  it("runs commands with the connection's caller and the request's trace", async () => {
    const { client, invocations } = harness();

    expect(await client.call("app.echo", { a: 1 }, { trace: "t-123" })).toEqual({ a: 1 });
    expect(await client.call("rpc.hello")).toEqual({ node: "test" });
    await client.call("app.echo", {});

    expect(invocations).toEqual([
      {
        traceId: "t-123",
        caller: { id: "owner", permissions: ["*"] },
        signal: expect.objectContaining({ aborted: false }),
      },
      {
        traceId: "generated-2",
        caller: { id: "owner", permissions: ["*"] },
        signal: expect.objectContaining({ aborted: false }),
      },
    ]);
    expect(invocations[0]!.signal!.aborted).toBe(false);
    client.close();
  });

  it("maps errors to JSON-RPC codes and keeps Jhin's code", async () => {
    const { client } = harness();

    await expect(client.call("app.fail")).rejects.toMatchObject({
      rpcCode: -32602,
      code: "COMMAND_INPUT_INVALID",
      details: { path: "x" },
    });
    await expect(client.call("app.nope")).rejects.toMatchObject({
      rpcCode: -32601,
      code: "COMMAND_NOT_FOUND",
    });
    client.close();
  });

  it("replays the backlog, then delivers live events, each exactly once", async () => {
    const { client, storage } = harness();
    await append(storage, "s", 1, 3);
    const { events, reach } = collect(client, "s", 1);
    await reach(2);

    await append(storage, "s", 4, 5);
    await reach(4);

    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4, 5]);
    expect(events.at(-1)?.payload).toBe(5);
    client.close();
  });

  it("resumes subscriptions after a reconnect without gaps or duplicates", async () => {
    const { client, storage, servers } = harness();
    const { events, reach } = collect(client, "s");
    await append(storage, "s", 1, 3);
    await reach(3);

    const reconnected = nextState(client, "open");
    servers.at(-1)!.close(1006, "network gone");
    await append(storage, "s", 4, 6); // appended while the client is away
    await reconnected;
    await append(storage, "s", 7, 8);
    await reach(8);

    expect(servers).toHaveLength(2);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    client.close();
  });

  it("rejects calls in flight when the connection drops", async () => {
    const { client, servers } = harness();
    await nextState(client, "open");

    const hanging = client.call("app.hang");
    servers.at(-1)!.close(1006, "gone");

    await expect(hanging).rejects.toMatchObject({ code: "DISCONNECTED" });
    client.close();
  });

  it("aborts the signal of a connection's calls when the connection closes (D1501)", async () => {
    const { client, invocations, servers } = harness();
    await nextState(client, "open");

    const hanging = client.call("app.hang");
    await client.call("app.echo", {});
    const signal = invocations[0]!.signal!;
    expect(signal.aborted).toBe(false);
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve()),
    );
    servers.at(-1)!.close(1006, "gone");

    await aborted;
    expect(signal.aborted).toBe(true);
    await expect(hanging).rejects.toMatchObject({ code: "DISCONNECTED" });
    client.close();
  });

  it("stops for good when the token is refused", async () => {
    const { client } = harness({ refuse: true });
    await nextState(client, "closed");

    expect(client.closeReason).toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(client.call("app.echo")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects calls waiting for a connection when the client is closed", async () => {
    const client = createRpcClient({
      retryDelay: () => 0,
      connect: () =>
        Promise.reject(Object.assign(new Error("nobody home"), { code: "CONNECT_FAILED" })),
    });
    const waiting = client.call("app.echo");

    client.close();

    await expect(waiting).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("cleans up a subscription whose replay failed, so the same id can be retried", async () => {
    const storage = createMemoryStorage();
    await storage.log.append("s", [{ type: "app.a", payload: 1 }]);
    let failNextRead = true;
    const log = {
      ...storage.log,
      read: (stream: string, options?: { after?: number; limit?: number }) => {
        if (failNextRead) {
          failNextRead = false;
          return Promise.reject(new Error("disk hiccup"));
        }
        return storage.log.read(stream, options);
      },
    };
    const [clientEnd, serverEnd] = createPeerPair();
    serveRpc(serverEnd, {
      caller: { id: "owner", permissions: ["*"] },
      log,
      logger: noopLogger,
      hello: () => ({}),
      newTraceId: () => "t",
      execute: async () => null,
    });
    const responses: {
      id?: number;
      error?: unknown;
      method?: string;
      params?: { event: { sequence: number } };
    }[] = [];
    const next = () =>
      new Promise<void>((resolve) => {
        const subscription = clientEnd.onMessage(() => {
          subscription.dispose();
          resolve();
        });
      });
    clientEnd.onMessage((text) => responses.push(JSON.parse(text)));
    const subscribe = (id: number) =>
      clientEnd.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "rpc.subscribe",
          params: { subscription: "a", stream: "s" },
        }),
      );

    let arrived = next();
    subscribe(1);
    await arrived;
    while (!responses.some((message) => message.id === 1)) {
      arrived = next();
      await arrived;
    }
    expect(responses.find((message) => message.id === 1)?.error).toBeDefined();

    subscribe(2);
    while (!responses.some((message) => message.id === 2)) {
      arrived = next();
      await arrived;
    }
    expect(responses.find((message) => message.id === 2)).toMatchObject({
      result: { subscription: "a", head: 1 },
    });
    expect(
      responses
        .filter((message) => message.method === "rpc.event")
        .map((message) => message.params?.event.sequence),
    ).toEqual([1]);
  });

  it("does not crash when the connection closes while a reply is on its way", async () => {
    const { client, servers } = harness();
    await nextState(client, "open");
    const pendingCall = client.call("app.echo", { late: true });
    servers.at(-1)!.close(1006, "gone");

    await expect(pendingCall).rejects.toMatchObject({ code: "DISCONNECTED" });
    client.close();
  });

  it("reports a refused subscription through onError and stops it", async () => {
    const [clientEnd, serverEnd] = createPeerPair();
    serveRpc(serverEnd, {
      caller: { id: "owner", permissions: ["*"] },
      logger: noopLogger,
      hello: () => ({}),
      newTraceId: () => "t",
      execute: async () => null,
    });
    const client = createRpcClient({ retryDelay: () => 0, connect: async () => clientEnd });
    const error = await new Promise((resolve) =>
      client.subscribe("s", { onError: resolve }, () => undefined),
    );

    expect(error).toMatchObject({ code: "UNAVAILABLE" });
    client.close();
  });

  it("carries calls both ways over one channel", async () => {
    const [clientEnd, serverEnd] = createPeerPair();
    const serve = (name: string) => ({
      caller: { id: "peer", permissions: ["*"] },
      logger: noopLogger,
      hello: () => ({}),
      newTraceId: () => "t",
      execute: async (method: string, input: unknown) => ({ answeredBy: name, method, input }),
    });
    serveRpc(serverEnd, serve("server"));
    const back = createCaller(serverEnd);
    const client = createRpcClient({
      retryDelay: () => 0,
      connect: async () => clientEnd,
      onConnected: (peer) => void serveRpc(peer, serve("client")),
    });

    const [there, here] = await Promise.all([
      client.call("app.ping", { n: 1 }),
      back.call("app.ping", { n: 2 }),
    ]);

    expect(there).toEqual({ answeredBy: "server", method: "app.ping", input: { n: 1 } });
    expect(here).toEqual({ answeredBy: "client", method: "app.ping", input: { n: 2 } });
    back.dispose();
    client.close();
  });

  it("keeps WebSocket messages that arrive before anyone listens, for everyone who listens next", async () => {
    const handlers: ((event: { data: unknown }) => void)[] = [];
    const socket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) =>
        void (type === "message" && handlers.push(handler)),
      removeEventListener: () => undefined,
    };
    const peer = webSocketPeer(socket as never);
    for (const handler of handlers) handler({ data: "early-1" });
    for (const handler of handlers) handler({ data: "early-2" });

    const first: string[] = [];
    const second: string[] = [];
    peer.onMessage((text) => first.push(text));
    peer.onMessage((text) => second.push(text));
    await Promise.resolve();
    for (const handler of handlers) handler({ data: "live" });

    expect(first).toEqual(["early-1", "early-2", "live"]);
    expect(second).toEqual(["early-1", "early-2", "live"]);
  });

  it("holds messages again after the last listener leaves", async () => {
    const handlers: ((event: { data: unknown }) => void)[] = [];
    const socket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) =>
        void (type === "message" && handlers.push(handler)),
      removeEventListener: () => undefined,
    };
    const peer = webSocketPeer(socket as never);
    const first = peer.onMessage(() => undefined);
    await Promise.resolve();
    first.dispose();
    for (const handler of handlers) handler({ data: "while-nobody-listens" });

    const later: string[] = [];
    peer.onMessage((text) => later.push(text));
    await Promise.resolve();

    expect(later).toEqual(["while-nobody-listens"]);
  });
});
