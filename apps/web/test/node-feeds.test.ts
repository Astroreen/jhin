import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { createNodeFeeds, type NodeFeeds } from "../src/lib/node-feeds.ts";

type Event = { type: string; payload: unknown };

/** A client whose `load` and stream the test drives. */
function fakeClient() {
  let answer!: { resolve: (value: unknown) => void; reject: (error: unknown) => void };
  const loaded = new Promise((resolve, reject) => (answer = { resolve, reject }));
  const stream: {
    listener?: (event: Event) => void;
    onError?: (error: unknown) => void;
    after?: number;
    open: boolean;
  } = { open: false };
  const reads = { count: 0 };
  const client = {
    call: () => {
      reads.count += 1;
      return loaded;
    },
    subscribe: (
      _stream: string,
      options: { after: number; onError: (error: unknown) => void },
      listener: (event: Event) => void,
    ) => {
      Object.assign(stream, {
        listener,
        onError: options.onError,
        after: options.after,
        open: true,
      });
      return toDisposable(() => (stream.open = false));
    },
  };
  return { client, answer, stream, reads };
}

/** One connection `a` whose client can be replaced or closed. */
function fakeConnections(first: ReturnType<typeof fakeClient>["client"]) {
  const listeners = new Set<() => void>();
  let connection: NodeConnection | undefined = {
    id: "a",
    state: "open",
    client: first,
  } as unknown as NodeConnection;
  const connections = {
    list: () => (connection === undefined ? [] : [connection]),
    get: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as Connections;
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    connections,
    replace(client: unknown) {
      connection = { id: "a", state: "open", client } as unknown as NodeConnection;
      changed();
    },
    close() {
      connection = undefined;
      changed();
    },
  };
}

/** The next change of the feeds: a fact, not a wait. */
const changes = (feeds: NodeFeeds<readonly string[]>) =>
  new Promise<void>((resolve) => {
    const subscription = feeds.subscribe(() => {
      subscription.dispose();
      resolve();
    });
  });

const quiet = { warn() {} };
const source = {
  empty: [] as readonly string[],
  stream: "s",
  load: async (client: NodeConnection["client"]) => {
    const { head, items } = (await client.call("load", {})) as { head: number; items: string[] };
    return { head, state: items as readonly string[] };
  },
  apply: (items: readonly string[], event: Event) =>
    event.type === "add" ? [...items, event.payload as string] : items,
};

describe("node feeds (D630, D731)", () => {
  it("keeps what a feed showed when its stream fails after it was read", async () => {
    const one = fakeClient();
    const { connections } = fakeConnections(one.client);
    const feeds = createNodeFeeds(connections, quiet, source);
    const ready = changes(feeds);
    one.answer.resolve({ head: 3, items: ["x"] });
    await ready;
    expect(one.stream.after).toBe(3);
    one.stream.listener!({ type: "add", payload: "y" });
    // A permission taken back mid-stream is a failure too, not "no such feature".
    one.stream.onError!(Object.assign(new Error("stream gone"), { code: "PERMISSION_DENIED" }));
    // A change this client made applies to the feed that is not live any more.
    feeds.apply("a", { type: "add", payload: "z" });
    expect(feeds.snapshot().get("a")).toEqual({
      status: "error",
      read: true,
      value: ["x", "y", "z"],
      error: "this client may no longer read it (stream gone)",
    });
    feeds.dispose();
  });

  it("reads and follows a dropped stream again, and marks a second drop at once not live", async () => {
    const one = fakeClient();
    const { connections } = fakeConnections(one.client);
    const feeds = createNodeFeeds(connections, quiet, source);
    let ready = changes(feeds);
    one.answer.resolve({ head: 3, items: ["x"] });
    await ready;
    // The first drop: marked not live, then read again and followed from its head.
    ready = new Promise<void>((resolve) => {
      const subscription = feeds.subscribe(() => {
        if (feeds.snapshot().get("a")?.status !== "ready") return;
        subscription.dispose();
        resolve();
      });
    });
    one.stream.onError!(new Error("stream gone"));
    // It stays as it was while it is read again: no flash of "not live".
    expect(feeds.snapshot().get("a")?.status).toBe("ready");
    await ready;
    expect(one.reads.count).toBe(2);
    expect(one.stream.open).toBe(true);
    // The second drop stays: not live until the connection is replaced.
    one.stream.onError!(new Error("stream gone again"));
    expect(feeds.snapshot().get("a")).toEqual({
      status: "error",
      read: true,
      value: ["x"],
      error: "stream gone again",
    });
    expect(one.reads.count).toBe(2);
    feeds.dispose();
  });

  it("follows a replaced connection's client again and drops the old one", async () => {
    const one = fakeClient();
    const nodes = fakeConnections(one.client);
    const feeds = createNodeFeeds(nodes.connections, quiet, source);
    let ready = changes(feeds);
    one.answer.resolve({ head: 1, items: ["old"] });
    await ready;

    const two = fakeClient();
    nodes.replace(two.client);
    expect(one.stream.open).toBe(false);
    expect(feeds.snapshot().get("a")?.status).toBe("loading");
    ready = changes(feeds);
    two.answer.resolve({ head: 9, items: ["new"] });
    await ready;
    expect(feeds.snapshot().get("a")).toMatchObject({ status: "ready", value: ["new"] });
    // A live feed is left to its stream.
    feeds.apply("a", { type: "add", payload: "local" });
    expect(feeds.snapshot().get("a")?.value).toEqual(["new"]);
    expect(two.stream.after).toBe(9);
    feeds.dispose();
  });

  it("ignores an answer that arrives after its connection closed", async () => {
    const one = fakeClient();
    const nodes = fakeConnections(one.client);
    const feeds = createNodeFeeds(nodes.connections, quiet, source);
    nodes.close();
    expect(feeds.snapshot().has("a")).toBe(false);
    one.answer.resolve({ head: 1, items: ["late"] });
    await one.client.call();
    expect(feeds.snapshot().has("a")).toBe(false);
    expect(one.stream.open).toBe(false);
    feeds.dispose();
  });

  it("tells what arrived while the stream was down, and retries again a minute later", async () => {
    // Each read answers the next list; the stream is driven by the test.
    const reads = [
      { head: 1, items: ["a"] },
      { head: 4, items: ["a", "b"] },
      { head: 6, items: ["a", "b", "c", "d"] },
    ];
    const stream: { listener?: (event: Event) => void; onError?: (error: unknown) => void } = {};
    const client = {
      call: async () => reads.shift(),
      subscribe: (
        _stream: string,
        options: { onError: (error: unknown) => void },
        listener: (event: Event) => void,
      ) => {
        Object.assign(stream, { listener, onError: options.onError });
        return toDisposable(() => {});
      },
    };
    // The feed's clock is the test's: a retry waits a minute after the last one.
    let time = 0;
    const { connections } = fakeConnections(client as never);
    const told: string[] = [];
    const feeds = createNodeFeeds(
      connections,
      quiet,
      {
        ...source,
        reread: (_connection, before, after) => {
          for (const item of after) if (!before.includes(item)) told.push(item);
        },
      },
      { clock: () => time },
    );
    const ready = () =>
      new Promise<void>((resolve) => {
        const subscription = feeds.subscribe(() => {
          if (feeds.snapshot().get("a")?.status !== "ready") return;
          subscription.dispose();
          resolve();
        });
      });
    let next = ready();
    await next;
    // A drop: read again, and "b", which came meanwhile, is told.
    next = ready();
    stream.onError!(new Error("dropped"));
    await next;
    expect(told).toEqual(["b"]);
    // A minute later a drop is retried too, quiet stream or not.
    stream.listener!({ type: "add", payload: "c" });
    time += 60_000;
    next = ready();
    stream.onError!(new Error("dropped again"));
    await next;
    expect(told).toEqual(["b", "d"]);
    expect(feeds.snapshot().get("a")?.value).toEqual(["a", "b", "c", "d"]);
    feeds.dispose();
  });

  it("ignores what an abandoned subscription still delivers or reports after a re-read", async () => {
    const reads = [
      { head: 1, items: ["a"] },
      { head: 2, items: ["a", "b"] },
    ];
    const listeners: ((event: Event) => void)[] = [];
    const onErrors: ((error: unknown) => void)[] = [];
    let onError: ((error: unknown) => void) | undefined;
    const client = {
      call: async () => reads.shift(),
      subscribe: (
        _stream: string,
        options: { onError: (error: unknown) => void },
        listener: (event: Event) => void,
      ) => {
        listeners.push(listener);
        onErrors.push(options.onError);
        onError = options.onError;
        return toDisposable(() => {});
      },
    };
    const { connections } = fakeConnections(client as never);
    const feeds = createNodeFeeds(connections, quiet, source);
    const ready = () =>
      new Promise<void>((resolve) => {
        const subscription = feeds.subscribe(() => {
          if (feeds.snapshot().get("a")?.status !== "ready") return;
          subscription.dispose();
          resolve();
        });
      });
    let next = ready();
    await next;
    next = ready();
    onError!(new Error("dropped"));
    // While the re-read is under way, the dropped subscription is not heard either.
    listeners[0]!({ type: "add", payload: "early" });
    expect(feeds.snapshot().get("a")?.value).toEqual(["a"]);
    await next;
    // The old subscription delivers "b" late, which the re-read already holds.
    listeners[0]!({ type: "add", payload: "b" });
    expect(feeds.snapshot().get("a")?.value).toEqual(["a", "b"]);
    // The new one is heard.
    listeners[1]!({ type: "add", payload: "c" });
    expect(feeds.snapshot().get("a")?.value).toEqual(["a", "b", "c"]);
    // Nor does its late failure count as a new drop.
    onErrors[0]!(new Error("old stream closing"));
    expect(feeds.snapshot().get("a")?.status).toBe("ready");
    feeds.dispose();
  });

  it("marks a second drop within a minute not live, and reads it again once the minute is over", async () => {
    let time = 0;
    const waiting: { ms: number; run: () => void }[] = [];
    const one = fakeClient();
    const { connections } = fakeConnections(one.client);
    const feeds = createNodeFeeds(connections, quiet, source, {
      clock: () => time,
      later: (ms, run) => {
        waiting.push({ ms, run });
        return toDisposable(() => {});
      },
    });
    let ready = changes(feeds);
    one.answer.resolve({ head: 1, items: ["x"] });
    await ready;
    ready = new Promise<void>((resolve) => {
      const subscription = feeds.subscribe(() => {
        if (feeds.snapshot().get("a")?.status !== "ready") return;
        subscription.dispose();
        resolve();
      });
    });
    one.stream.onError!(new Error("dropped"));
    await ready;
    // 59.999 s later: within the minute, so no retry now, one waiting for 1 ms.
    time += 59_999;
    one.stream.onError!(new Error("dropped again"));
    expect(feeds.snapshot().get("a")?.status).toBe("error");
    expect(one.reads.count).toBe(2);
    expect(waiting.map((retry) => retry.ms)).toEqual([1]);
    // The minute is over: read again, and live once more.
    time += 1;
    ready = changes(feeds);
    waiting[0]!.run();
    await ready;
    expect(feeds.snapshot().get("a")?.status).toBe("ready");
    expect(one.reads.count).toBe(3);
    feeds.dispose();
  });

  it("keeps a change this client made while a dropped stream was read again", async () => {
    let answer!: (value: unknown) => void;
    const reads: Promise<unknown>[] = [
      Promise.resolve({ head: 1, items: ["x"] }),
      new Promise((resolve) => (answer = resolve)),
    ];
    let onError: ((error: unknown) => void) | undefined;
    const client = {
      call: () => reads.shift(),
      subscribe: (_stream: string, options: { onError: (error: unknown) => void }) => {
        onError = options.onError;
        return toDisposable(() => {});
      },
    };
    const { connections } = fakeConnections(client as never);
    const feeds = createNodeFeeds(connections, quiet, source);
    await changes(feeds);
    onError!(new Error("dropped"));
    // A change made here (a dismissal) while the re-read is under way…
    feeds.apply("a", { type: "add", payload: "local" });
    expect(feeds.snapshot().get("a")?.value).toEqual(["x", "local"]);
    // …is kept when the re-read answers without it.
    const ready = changes(feeds);
    answer({ head: 2, items: ["x", "y"] });
    await ready;
    expect(feeds.snapshot().get("a")).toMatchObject({
      status: "ready",
      value: ["x", "y", "local"],
    });
    feeds.dispose();
  });

  it("tries a first load that failed again, telling nothing of it as new", async () => {
    const reads: (() => Promise<unknown>)[] = [
      () => Promise.reject(new Error("node busy")),
      async () => ({ head: 1, items: ["x"] }),
    ];
    const client = {
      call: () => reads.shift()!(),
      subscribe: () => toDisposable(() => {}),
    };
    const { connections } = fakeConnections(client as never);
    const told: string[] = [];
    const feeds = createNodeFeeds(connections, quiet, {
      ...source,
      reread: (_connection, before, after) => {
        for (const item of after) if (!before.includes(item)) told.push(item);
      },
    });
    await new Promise<void>((resolve) => {
      const subscription = feeds.subscribe(() => {
        if (feeds.snapshot().get("a")?.status !== "ready") return;
        subscription.dispose();
        resolve();
      });
    });
    expect(feeds.snapshot().get("a")?.value).toEqual(["x"]);
    expect(told).toEqual([]);
    feeds.dispose();
  });
});
