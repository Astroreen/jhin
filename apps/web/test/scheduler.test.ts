import type { Connections, NodeConnection } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { SCHEDULER_STREAM, SchedulerEvents, type ScheduledTask } from "@jhin/scheduler-api";
import { toDisposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  applySchedulerEvent,
  createSchedulerStore,
  withWebhookUrl,
  type SchedulerView,
} from "../src/plugins/scheduler/store.ts";

const task = (fields: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1",
  title: "Check the build",
  prompt: "Check the build",
  enabled: true,
  schedule: { type: "interval", everyMs: 300_000 },
  projectId: "scratch",
  threadId: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  nextRunAt: "2026-10-19T10:05:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  lastRunThreadId: null,
  runCount: 0,
  ...fields,
});

const hook = (path: string | null, fields: Partial<ScheduledTask> = {}) =>
  task({
    id: "h1",
    schedule: { type: "webhook", signature: null },
    nextRunAt: null,
    webhook: { path, url: path === null ? null : `http://node${path}`, hasSecret: false },
    ...fields,
  });

describe("applySchedulerEvent", () => {
  const view: SchedulerView = { status: "ready", tasks: [task(), hook("/api/hooks/h1/abc")] };

  it("adds, replaces and deletes tasks, and ignores what it does not know", () => {
    const added = applySchedulerEvent(view, {
      type: SchedulerEvents.taskUpdated,
      payload: task({ id: "t2" }),
    });
    expect(added.tasks.map((t) => t.id)).toEqual(["t1", "h1", "t2"]);
    const paused = applySchedulerEvent(added, {
      type: SchedulerEvents.taskUpdated,
      payload: task({ enabled: false }),
    });
    expect(paused.tasks[0]?.enabled).toBe(false);
    const deleted = applySchedulerEvent(paused, {
      type: SchedulerEvents.taskDeleted,
      payload: { id: "t1" },
    });
    expect(deleted.tasks.map((t) => t.id)).toEqual(["h1", "t2"]);
    expect(applySchedulerEvent(view, { type: "other", payload: {} })).toBe(view);
    expect(applySchedulerEvent(view, { type: SchedulerEvents.taskUpdated, payload: null })).toBe(
      view,
    );
    expect(applySchedulerEvent(view, { type: SchedulerEvents.taskDeleted, payload: null })).toBe(
      view,
    );
  });

  it("shows no URL for a webhook task the stream changed until it is read again", () => {
    const next = applySchedulerEvent(view, {
      type: SchedulerEvents.taskUpdated,
      payload: hook(null, { enabled: false }),
    });
    // Maybe a rotation: the old URL is not offered meanwhile.
    expect(next.tasks[1]?.webhook?.path).toBeNull();
    expect(next.urls?.get("h1")).toBe("loading");
    expect(next.tasks[1]?.enabled).toBe(false);
  });

  it("takes only the URL from a read, never older fields", () => {
    // The stream said paused after the read went out; the read still says enabled.
    const paused = applySchedulerEvent(view, {
      type: SchedulerEvents.taskUpdated,
      payload: hook(null, { enabled: false }),
    });
    const read = hook("/api/hooks/h1/rotated", { enabled: true });
    const next = withWebhookUrl(paused, read);
    expect(next.tasks[1]).toMatchObject({
      enabled: false,
      webhook: { path: "/api/hooks/h1/rotated", url: "http://node/api/hooks/h1/rotated" },
    });
    expect(next.urls?.has("h1")).toBe(false);
    // A reader's read has no URL to give: no longer loading, still no URL.
    const readers = withWebhookUrl(paused, hook(null));
    expect(readers.tasks[1]?.webhook?.path).toBeNull();
    expect(readers.urls?.has("h1")).toBe(false);
    // A read of a task gone changes nothing.
    expect(withWebhookUrl(paused, hook("/x", { id: "gone" }))).toBe(paused);
  });
});

/** A connection whose node answers `scheduler.tasks.list` from `answer`. */
function fakeNode(
  answer: () => Promise<{ tasks: ScheduledTask[]; head: number }>,
  get: (id: string) => Promise<ScheduledTask> = () => Promise.reject(new Error("no get")),
) {
  const subscriptions: {
    after: number | undefined;
    onEvent: (event: StoredEvent) => void;
    onError: ((error: unknown) => void) | undefined;
  }[] = [];
  const makeClient = () =>
    ({
      call: async (method: string, params: { id?: string }) => {
        if (method === "scheduler.tasks.list") return answer();
        if (method === "scheduler.tasks.get") return get(params.id ?? "");
        throw new Error(`unexpected ${method}`);
      },
      subscribe(
        stream: string,
        options: { after?: number; onError?: (error: unknown) => void },
        onEvent: (event: StoredEvent) => void,
      ) {
        if (stream !== SCHEDULER_STREAM) throw new Error(`unexpected stream ${stream}`);
        subscriptions.push({ after: options.after, onEvent, onError: options.onError });
        return { lastSequence: 0, dispose: () => undefined };
      },
    }) as unknown as RpcClient;
  let connection: NodeConnection = {
    id: "ws://a/rpc",
    url: "ws://a/rpc",
    label: "a",
    client: makeClient(),
    state: "open",
  };
  const listeners = new Set<() => void>();
  const connections: Connections = {
    list: () => [connection],
    get: (id) => (id === connection.id ? connection : undefined),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
  return {
    connections,
    subscriptions,
    /** The connection drops (`closed`) or comes back with a new client (`open`). */
    setState(state: "open" | "closed") {
      connection = { ...connection, state, client: makeClient() };
      for (const listener of listeners) listener();
    },
  };
}

const quiet = { warn: () => undefined };

function follow(store: ReturnType<typeof createSchedulerStore>) {
  const waiting: ((view: SchedulerView) => void)[] = [];
  store.subscribe("ws://a/rpc", () => waiting.shift()?.(store.view("ws://a/rpc")));
  return { next: () => new Promise<SchedulerView>((resolve) => waiting.push(resolve)) };
}

describe("the scheduler store", () => {
  it("lists, follows the stream after its head, and shows nothing stale after a reconnect", async () => {
    let tasks = [task()];
    const node = fakeNode(async () => ({ tasks, head: 3 }));
    const store = createSchedulerStore(node.connections, quiet);
    const feed = follow(store);
    expect((await feed.next()).tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(node.subscriptions.map((s) => s.after)).toEqual([3]);

    // The connection drops: loading, not the old tasks as if live.
    const dropped = feed.next();
    node.setState("closed");
    expect(await dropped).toEqual({ status: "loading", tasks: [] });

    tasks = [task({ id: "t9" })];
    const reloaded = feed.next();
    node.setState("open");
    expect((await reloaded).tasks.map((t) => t.id)).toEqual(["t9"]);
    store.dispose();
  });

  it("starts over when the stream breaks", async () => {
    let lists = 0;
    const node = fakeNode(async () => ({ tasks: [task({ runCount: lists++ })], head: lists }));
    const store = createSchedulerStore(node.connections, quiet);
    const feed = follow(store);
    await feed.next();
    const broken = feed.next();
    // Not even an Error: still shown, and the feed still starts over.
    node.subscriptions[0]?.onError?.("stream lost");
    expect(await broken).toMatchObject({ status: "error", error: "stream lost" });
    const again = await feed.next();
    expect(again).toMatchObject({ status: "ready", tasks: [{ runCount: 1 }] });
    expect(node.subscriptions.map((s) => s.after)).toEqual([1, 2]);
    store.dispose();
  });

  it("backs off when the stream keeps failing right after a good list", async () => {
    let lists = 0;
    const node = fakeNode(async () => ({ tasks: [task()], head: ++lists }));
    const delayed: { run: () => void; ms: number }[] = [];
    const store = createSchedulerStore(node.connections, quiet, (run, ms) => {
      delayed.push({ run, ms });
      return () => undefined;
    });
    const feed = follow(store);
    await feed.next();
    // The first failure starts over at once…
    const first = feed.next();
    node.subscriptions[0]?.onError?.(new Error("refused"));
    expect(await first).toMatchObject({ status: "error" });
    expect((await feed.next()).status).toBe("ready");
    expect(lists).toBe(2);
    // …the second waits, though the list in between worked.
    node.subscriptions[1]?.onError?.(new Error("refused"));
    expect(delayed.map((entry) => entry.ms)).toEqual([1000]);
    expect(lists).toBe(2);
    const ready = feed.next();
    delayed[0]?.run();
    expect((await ready).status).toBe("ready");
    expect(lists).toBe(3);
    node.subscriptions[2]?.onError?.(new Error("refused"));
    expect(delayed.map((entry) => entry.ms)).toEqual([1000, 2000]);
    // An event shows the stream works again: the next failure starts over at once.
    const fourth = feed.next();
    delayed[1]?.run();
    await fourth;
    node.subscriptions[3]?.onEvent({
      stream: SCHEDULER_STREAM,
      sequence: 9,
      type: SchedulerEvents.taskUpdated,
      payload: task({ runCount: 5 }) as never,
      at: "",
    });
    const restarted = feed.next().then(() => feed.next());
    node.subscriptions[3]?.onError?.(new Error("refused"));
    expect((await restarted).status).toBe("ready");
    expect(delayed).toHaveLength(2);
    expect(lists).toBe(5);
    store.dispose();
  });

  it("reads a webhook task again for its URL; only the latest read counts, a failed one drops the URL", async () => {
    const pending: { resolve(task: ScheduledTask): void; reject(error: Error): void }[] = [];
    const node = fakeNode(
      async () => ({ tasks: [hook("/api/hooks/h1/old")], head: 1 }),
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    );
    const store = createSchedulerStore(node.connections, quiet);
    const feed = follow(store);
    await feed.next();
    const event = (fields: Partial<ScheduledTask>) =>
      node.subscriptions[0]?.onEvent({
        stream: SCHEDULER_STREAM,
        sequence: 2,
        type: SchedulerEvents.taskUpdated,
        payload: hook(null, fields) as never,
        at: "",
      });
    // Every path the view shows, in order.
    const shown: (string | null | undefined)[] = [];
    store.subscribe("ws://a/rpc", () =>
      shown.push(store.view("ws://a/rpc").tasks[0]?.webhook?.path),
    );
    // A rotation, then an edit: two reads go out.
    event({});
    event({ title: "Renamed" });
    expect(pending).toHaveLength(2);
    // The newer read answers first; the older one, with a stale token, answers after it.
    const newer = feed.next();
    pending[1]?.resolve(hook("/api/hooks/h1/new"));
    expect((await newer).tasks[0]?.webhook?.path).toBe("/api/hooks/h1/new");
    pending[0]?.resolve(hook("/api/hooks/h1/old"));
    // A third read, answered after the stale one, is applied after it: once it shows, the
    // stale answer has been handled for sure.
    event({});
    const third = feed.next();
    pending[2]?.resolve(hook("/api/hooks/h1/third"));
    expect((await third).tasks[0]?.webhook?.path).toBe("/api/hooks/h1/third");
    expect(shown).not.toContain("/api/hooks/h1/old");

    // A read that fails leaves no URL that may no longer work.
    event({});
    const dropped = feed.next();
    pending[3]?.reject(new Error("offline"));
    const failedRead = await dropped;
    expect(failedRead.tasks[0]?.webhook).toMatchObject({ path: null, url: null });
    // Said apart from a reader's missing rights, until a read works again.
    expect(failedRead.urls?.get("h1")).toBe("failed");
    event({});
    const recovered = feed.next();
    pending[4]?.resolve(hook("/api/hooks/h1/new"));
    expect((await recovered).urls?.has("h1")).toBe(false);
    store.dispose();
  });

  it("reads nothing again for a client the node shows no URLs to", async () => {
    const reads: string[] = [];
    const node = fakeNode(
      async () => ({ tasks: [hook(null)], head: 1 }),
      async (id) => {
        reads.push(id);
        return hook(null);
      },
    );
    const store = createSchedulerStore(node.connections, quiet);
    const feed = follow(store);
    await feed.next();
    const updated = feed.next();
    node.subscriptions[0]?.onEvent({
      stream: SCHEDULER_STREAM,
      sequence: 2,
      type: SchedulerEvents.taskUpdated,
      payload: hook(null, { title: "Renamed" }) as never,
      at: "",
    });
    const view = await updated;
    expect(view.tasks[0]?.title).toBe("Renamed");
    expect(view.urls?.has("h1")).toBe(false);
    expect(reads).toEqual([]);
    store.dispose();
  });

  it("says unavailable for a node without the scheduler", async () => {
    const node = fakeNode(async () => {
      throw Object.assign(new Error("no command"), { code: "COMMAND_NOT_FOUND" });
    });
    const store = createSchedulerStore(node.connections, quiet);
    const feed = follow(store);
    expect((await feed.next()).status).toBe("unavailable");
    store.dispose();
  });
});
