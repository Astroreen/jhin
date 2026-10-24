import { ThreadEvents, THREADS_STREAM } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  HISTORY_CACHE_CAPABILITY,
  MESH_CAPABILITY,
  THREADS_CAPABILITY,
  type CachedCatalog,
  type Connections,
  type HistoryCache,
  type MeshMembership,
  type NodeCatalog,
  type NodeConnection,
  type ProjectRecord,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { createTestKernel, mockCapability, testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { applyIndexEvent, threadsStorePlugin } from "../src/plugins/threads-store.ts";

const scratch: ProjectRecord = {
  id: "scratch",
  name: "No project",
  path: "/data/scratch",
  scratch: true,
  createdAt: "2026-10-18T10:00:00.000Z",
};
const app: ProjectRecord = {
  id: "app",
  name: "app",
  path: "/src/app",
  scratch: false,
  createdAt: "2026-10-18T11:00:00.000Z",
};
const thread = (id: string, projectId: string, createdAt: string): ThreadRecord => ({
  id,
  projectId,
  title: id,
  createdAt,
});

describe("applyIndexEvent", () => {
  const catalog: NodeCatalog = {
    status: "ready",
    projects: [scratch],
    threads: [thread("t1", "scratch", "2026-10-18T12:00:00.000Z")],
  };

  it("adds and replaces records, keeping threads oldest first and scratch first", () => {
    const withProject = applyIndexEvent(catalog, {
      type: ThreadEvents.projectCreated,
      payload: app,
    });
    expect(withProject.projects.map((project) => project.id)).toEqual(["scratch", "app"]);

    const older = thread("t0", "app", "2026-10-18T11:30:00.000Z");
    const withThread = applyIndexEvent(withProject, {
      type: ThreadEvents.threadCreated,
      payload: older,
    });
    expect(withThread.threads.map((item) => item.id)).toEqual(["t0", "t1"]);

    const renamed = applyIndexEvent(withThread, {
      type: ThreadEvents.threadUpdated,
      payload: { ...older, title: "Renamed" },
    });
    expect(renamed.threads.map((item) => item.title)).toEqual(["Renamed", "t1"]);
  });

  it("removes a deleted project with its threads, and ignores anything else", () => {
    const both = applyIndexEvent(
      applyIndexEvent(catalog, { type: ThreadEvents.projectCreated, payload: app }),
      {
        type: ThreadEvents.threadCreated,
        payload: thread("t2", "app", "2026-10-18T13:00:00.000Z"),
      },
    );
    const removed = applyIndexEvent(both, {
      type: ThreadEvents.projectDeleted,
      payload: { id: "app" },
    });
    expect(removed.projects.map((project) => project.id)).toEqual(["scratch"]);
    expect(removed.threads.map((item) => item.id)).toEqual(["t1"]);
    expect(applyIndexEvent(catalog, { type: "other", payload: { id: "t1" } })).toBe(catalog);
    expect(applyIndexEvent(catalog, { type: ThreadEvents.threadDeleted, payload: null })).toBe(
      catalog,
    );
  });

  it("leaves an agent's generation out, and drops a thread that becomes one (D745)", () => {
    const generation = {
      ...thread("g1", "scratch", "2026-10-18T13:00:00.000Z"),
      generationOf: "lead",
    };
    const created = applyIndexEvent(catalog, {
      type: ThreadEvents.threadCreated,
      payload: generation,
    });
    expect(created.threads.map((item) => item.id)).toEqual(["t1"]);

    const marked = applyIndexEvent(catalog, {
      type: ThreadEvents.threadUpdated,
      payload: { ...catalog.threads[0]!, generationOf: "lead" },
    });
    expect(marked.threads).toEqual([]);
  });
});

/** A node's RPC client: answers from `answers`, records `threads` subscriptions. */
function fakeNode(answers: Record<string, () => Promise<unknown>>) {
  const calls: string[] = [];
  const subscriptions: {
    after: number | undefined;
    onEvent: (event: StoredEvent) => void;
    onError?: (error: Error) => void;
  }[] = [];
  let open = 0;
  const onSubscribe: (() => void)[] = [];
  const client = {
    state: "open",
    call: (method: string) => {
      calls.push(method);
      const answer = answers[method];
      return answer === undefined ? Promise.reject(new Error(`unexpected ${method}`)) : answer();
    },
    subscribe: (
      stream: string,
      options: { after?: number; onError?: (error: Error) => void },
      onEvent: (event: StoredEvent) => void,
    ) => {
      if (stream !== THREADS_STREAM) throw new Error(`unexpected stream ${stream}`);
      subscriptions.push({
        after: options.after,
        onEvent,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      });
      open += 1;
      for (const resolve of onSubscribe.splice(0)) resolve();
      return { lastSequence: 0, dispose: () => (open -= 1) };
    },
  } as unknown as RpcClient;
  let sequence = 0;
  return {
    client,
    calls,
    subscriptions,
    open: () => open,
    /** Resolves once the index is subscribed to. */
    subscribed: () =>
      open > 0 ? Promise.resolve() : new Promise<void>((resolve) => onSubscribe.push(resolve)),
    /** The node refuses the latest subscription (it is then over, as the client disposes it). */
    refuse(message: string) {
      open -= 1;
      subscriptions.at(-1)!.onError?.(new Error(message));
    },
    /** Appends an event to the node's index, as every open subscription sees it. */
    append(type: string, payload: unknown, at?: number) {
      sequence = at ?? sequence + 1;
      for (const { onEvent } of subscriptions) {
        onEvent({
          stream: THREADS_STREAM,
          sequence,
          type,
          payload: payload as StoredEvent["payload"],
          at: "",
        });
      }
    },
  };
}

const connection = (client: RpcClient): NodeConnection => ({
  id: "ws://a/rpc",
  url: "ws://a/rpc",
  label: "a",
  client,
  state: "open",
});

function oneConnection(node: NodeConnection): Connections {
  return {
    list: () => [node],
    get: (id) => (id === node.id ? node : undefined),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
}

const noMesh: MeshMembership = {
  members: () => [],
  subscribe: () => toDisposable(() => undefined),
};

async function start(client: RpcClient, cache?: HistoryCache) {
  let store: ThreadsCatalog | undefined;
  const kernel = await createTestKernel({
    side: "client",
    plugins: [
      mockCapability(CONNECTIONS_CAPABILITY, oneConnection(connection(client))),
      mockCapability(MESH_CAPABILITY, noMesh),
      ...(cache === undefined ? [] : [mockCapability(HISTORY_CACHE_CAPABILITY, cache, "1.1.0")]),
      threadsStorePlugin,
      {
        manifest: testManifest("app.consumer", {
          side: "client",
          requires: { [THREADS_CAPABILITY]: "^1" },
        }),
        definition: definePlugin({
          activate(context) {
            store = context.services.get(THREADS_CAPABILITY);
          },
        }),
      },
    ],
  });
  return { kernel, store: store! };
}

/** Subscribes to the node's catalog and resolves with each catalog it is told about. */
function follow(store: ThreadsCatalog) {
  const target = { node: "ws://a/rpc" };
  const waiting: ((catalog: NodeCatalog) => void)[] = [];
  const subscription = store.subscribe(target, () => {
    waiting.shift()?.(store.catalog(target));
  });
  return {
    subscription,
    next: () => new Promise<NodeCatalog>((resolve) => waiting.push(resolve)),
    current: () => store.catalog(target),
  };
}

describe("client.threads@1", () => {
  it("loads a node's catalog, then follows its index from the head it reflects", async () => {
    const node = fakeNode({
      "threads.catalog": async () => ({
        head: 7,
        projects: [scratch],
        threads: [thread("t1", "scratch", "2026-10-18T12:00:00.000Z")],
      }),
    });
    const { kernel, store } = await start(node.client);
    const feed = follow(store);
    expect(feed.current().status).toBe("loading");

    const loaded = await feed.next();
    expect(loaded.status).toBe("ready");
    expect(loaded.threads.map((item) => item.id)).toEqual(["t1"]);

    // The index is followed once the catalog is in.
    await node.subscribed();
    const changed = feed.next();
    node.append(ThreadEvents.threadCreated, thread("t2", "scratch", "2026-10-18T13:00:00.000Z"));
    expect((await changed).threads.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([7]);

    // The feed stops once nobody is back within the tick.
    feed.subscription.dispose();
    await Promise.resolve();
    expect(node.open()).toBe(0);
    await kernel.stop();
  });

  it("keeps a feed whose subscriber comes back within the tick, without loading it again", async () => {
    let loads = 0;
    const node = fakeNode({
      "threads.catalog": async () => {
        loads += 1;
        return { head: 0, projects: [scratch], threads: [] };
      },
    });
    const { kernel, store } = await start(node.client);
    const target = { node: "ws://a/rpc" };
    const first = follow(store);
    await first.next();
    await node.subscribed();

    // A re-render or a route change: unsubscribed and subscribed again at once.
    first.subscription.dispose();
    const second = store.subscribe(target, () => undefined);
    await Promise.resolve();
    expect(store.catalog(target).status).toBe("ready");
    expect(loads).toBe(1);
    expect(node.open()).toBe(1);

    second.dispose();
    await Promise.resolve();
    expect(node.open()).toBe(0);
    await kernel.stop();
  });

  it("falls back to the lists on a node without threads.catalog", async () => {
    let listed = 0;
    const node = fakeNode({
      "threads.catalog": () =>
        Promise.reject(Object.assign(new Error("no such command"), { code: "COMMAND_NOT_FOUND" })),
      "projects.list": async () => [scratch],
      "threads.list": async () => {
        listed += 1;
        return listed === 1
          ? [thread("t1", "scratch", "2026-10-18T12:00:00.000Z")]
          : [
              thread("t1", "scratch", "2026-10-18T12:00:00.000Z"),
              thread("t2", "scratch", "2026-10-18T13:00:00.000Z"),
            ];
      },
    });
    const { kernel, store } = await start(node.client);
    const feed = follow(store);
    expect((await feed.next()).threads.map((item) => item.id)).toEqual(["t1"]);

    // Any index event refetches the lists.
    await node.subscribed();
    const changed = feed.next();
    node.append("threads.something.new", { id: "t2" });
    expect((await changed).threads.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([0]);

    feed.subscription.dispose();
    await kernel.stop();
  });
});

/** A history cache in memory that keeps one connection's catalog and records drops. */
function catalogCache(kept?: CachedCatalog) {
  let catalog = kept;
  const drops: string[] = [];
  const writes: CachedCatalog[] = [];
  const waiters: (() => void)[] = [];
  const cache: HistoryCache = {
    enabled: () => true,
    read: async () => undefined,
    append: async () => undefined,
    drop: async (_connection, stream) => {
      drops.push(stream ?? "all");
    },
    readCatalog: async () => catalog,
    writeCatalog: async (_connection, next) => {
      catalog = next;
      writes.push(next);
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
  return {
    cache,
    drops,
    writes,
    /** Resolves once the catalog was written `count` times. */
    written: (count: number) =>
      new Promise<CachedCatalog>((resolve) => {
        const check = () =>
          writes.length >= count ? resolve(writes[count - 1]!) : waiters.push(check);
        check();
      }),
  };
}

describe("client.threads@1 with the history cache (loading.md D1591)", () => {
  const kept: CachedCatalog = {
    epoch: "e1",
    head: 7,
    projects: [scratch],
    threads: [
      thread("t1", "scratch", "2026-10-18T12:00:00.000Z"),
      thread("t2", "scratch", "2026-10-18T13:00:00.000Z"),
    ],
  };

  it("shows the kept catalog and follows the index after its head, without reading the catalog", async () => {
    const node = fakeNode({ "threads.epoch": async () => ({ epoch: "e1", head: 9 }) });
    const { cache, written, drops } = catalogCache(kept);
    const { kernel, store } = await start(node.client, cache);
    const feed = follow(store);
    const shown = await feed.next();
    expect(shown.status).toBe("ready");
    expect(shown.threads.map((item) => item.id)).toEqual(["t1", "t2"]);
    await node.subscribed();
    expect(node.calls).toEqual(["threads.epoch"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([7]);

    // What follows is kept too, with the head it reflects; a gone thread drops its stream.
    node.append(ThreadEvents.threadDeleted, { id: "t2" }, 8);
    const after = await written(1);
    expect(after).toMatchObject({ epoch: "e1", head: 8 });
    expect(after.threads.map((item) => item.id)).toEqual(["t1"]);
    expect(drops).toEqual(["thread/t2"]);
    await kernel.stop();
  });

  it("reads the catalog when the node's epoch is another one", async () => {
    const node = fakeNode({
      "threads.epoch": async () => ({ epoch: "e2", head: 9 }),
      "threads.catalog": async () => ({
        head: 3,
        epoch: "e2",
        projects: [scratch],
        threads: [thread("t9", "scratch", "2026-10-18T14:00:00.000Z")],
      }),
    });
    const { cache, written } = catalogCache(kept);
    const { kernel, store } = await start(node.client, cache);
    follow(store);
    await node.subscribed();
    expect(node.calls).toEqual(["threads.epoch", "threads.catalog"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([3]);
    expect(store.catalog({ node: "ws://a/rpc" }).threads.map((item) => item.id)).toEqual(["t9"]);
    expect(await written(1)).toMatchObject({ epoch: "e2", head: 3 });
    await kernel.stop();
  });

  it("reads the catalog when the node's index is behind the kept head", async () => {
    const node = fakeNode({
      "threads.epoch": async () => ({ epoch: "e1", head: 2 }),
      "threads.catalog": async () => ({ head: 2, epoch: "e1", projects: [scratch], threads: [] }),
    });
    const { kernel, store } = await start(node.client, catalogCache(kept).cache);
    follow(store);
    await node.subscribed();
    expect(node.calls).toEqual(["threads.epoch", "threads.catalog"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([2]);
    await kernel.stop();
  });

  it("reads the catalog after all when the index skips past the kept head (a gap, D498)", async () => {
    const node = fakeNode({
      "threads.epoch": async () => ({ epoch: "e1", head: 12 }),
      "threads.catalog": async () => ({ head: 12, epoch: "e1", projects: [scratch], threads: [] }),
    });
    const { kernel, store } = await start(node.client, catalogCache(kept).cache);
    const feed = follow(store);
    await node.subscribed();
    node.append(
      ThreadEvents.threadCreated,
      thread("t5", "scratch", "2026-10-18T15:00:00.000Z"),
      11,
    );
    // The event after the gap is not applied: the catalog is read instead.
    let catalog = await feed.next();
    while (catalog.threads.length !== 0) catalog = await feed.next();
    // The index is followed again after the head of the catalog read.
    await node.subscribed();
    expect(node.calls).toEqual(["threads.epoch", "threads.catalog"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([7, 12]);
    await kernel.stop();
  });

  it("keeps the catalog it read when nothing was kept", async () => {
    const node = fakeNode({
      "threads.catalog": async () => ({ head: 4, epoch: "e1", projects: [scratch], threads: [] }),
    });
    const { cache, written } = catalogCache();
    const { kernel, store } = await start(node.client, cache);
    follow(store);
    expect(await written(1)).toMatchObject({ epoch: "e1", head: 4, projects: [scratch] });
    expect(node.calls).toEqual(["threads.catalog"]);
    await kernel.stop();
  });

  it("reads the catalog after all when the node refuses to follow the index from the kept head", async () => {
    const node = fakeNode({
      "threads.epoch": async () => ({ epoch: "e1", head: 9 }),
      "threads.catalog": async () => ({ head: 9, epoch: "e1", projects: [scratch], threads: [] }),
    });
    const { kernel, store } = await start(node.client, catalogCache(kept).cache);
    const feed = follow(store);
    await node.subscribed();
    node.refuse("STREAM_TRIMMED");
    let catalog = await feed.next();
    while (catalog.threads.length !== 0) catalog = await feed.next();
    await node.subscribed();
    expect(catalog.status).toBe("ready");
    expect(node.calls).toEqual(["threads.epoch", "threads.catalog"]);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([7, 9]);
    await kernel.stop();
  });

  it("forgets the kept catalog of a node that answers no epoch (D1607)", async () => {
    const node = fakeNode({
      "threads.epoch": () =>
        Promise.reject(Object.assign(new Error("no"), { code: "COMMAND_NOT_FOUND" })),
      "threads.catalog": async () => ({ head: 2, projects: [scratch], threads: [] }),
    });
    const { cache, drops, writes } = catalogCache(kept);
    const { kernel, store } = await start(node.client, cache);
    follow(store);
    await node.subscribed();
    expect(drops).toContain("all");
    expect(writes).toEqual([]);
    await kernel.stop();
  });
});
