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
  const client = {
    call: () => loaded,
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
  return { client, answer, stream };
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
    one.stream.onError!(new Error("stream gone"));
    expect(feeds.snapshot().get("a")).toEqual({
      status: "error",
      value: ["x", "y"],
      error: "stream gone",
    });
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
});
