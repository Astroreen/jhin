import {
  targetKey,
  type Connections,
  type NodeConnection,
  type NodeTarget,
} from "@jhin/client-api";
import type { ThreadPullRequest } from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import type { SourceControlStore, SourceControlView } from "../src/plugins/source-control/store.ts";
import { createWatchedWork } from "../src/plugins/source-control/work.ts";

/** A store whose views are set by hand, telling each follower of a node's change. */
function fakeStore() {
  const links = new Map<string, Map<string, ThreadPullRequest[]>>();
  const followers = new Map<string, Set<() => void>>();
  const store: Pick<SourceControlStore, "view" | "subscribe"> = {
    view: (target) =>
      ({ links: links.get(targetKey(target)) ?? new Map() }) as unknown as SourceControlView,
    subscribe(target, listener) {
      const set = followers.get(targetKey(target)) ?? new Set();
      followers.set(targetKey(target), set);
      set.add(listener);
      return { dispose: () => set.delete(listener) };
    },
  };
  return {
    store,
    followers: (node: string, remote?: string) =>
      followers.get(targetKey({ node, ...(remote === undefined ? {} : { remote }) }))?.size ?? 0,
    set(node: string, threadId: string, list: ThreadPullRequest[], remote?: string) {
      const key = targetKey({ node, ...(remote === undefined ? {} : { remote }) });
      const byThread = links.get(key) ?? new Map();
      links.set(key, byThread);
      byThread.set(threadId, list);
      for (const listener of Array.from(followers.get(key) ?? [])) listener();
    },
  };
}

function fakeConnections(ids: string[]) {
  let current = ids;
  let closed = new Set<string>();
  const listeners = new Set<() => void>();
  const connections: Pick<Connections, "list" | "subscribe"> = {
    list: () =>
      current.map(
        (id) => ({ id, state: closed.has(id) ? "connecting" : "open" }) as NodeConnection,
      ),
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    connections,
    set(next: string[]) {
      current = next;
      for (const listener of Array.from(listeners)) listener();
    },
    /** Not open any more: closed, or connecting again. */
    close(id: string) {
      closed = new Set([...closed, id]);
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

const link = (number: number, watched: boolean) =>
  ({
    key: `github.com/o/r#${number}`,
    number,
    url: `https://github.com/o/r/pull/${number}`,
    ...(watched ? { watch: {} } : {}),
  }) as unknown as ThreadPullRequest;

describe("source control's thread work (D1131)", () => {
  it("reports a watched pull request of a connected node, and tells only when watching changes", () => {
    const { store, set, followers } = fakeStore();
    const nodes = fakeConnections(["a"]);
    const work = createWatchedWork(store, nodes.connections);
    let told = 0;
    work.subscribe(() => told++);
    const a: NodeTarget = { node: "a" };
    expect(followers("a")).toBe(1);
    expect(work.tasks(a, "t")).toEqual([]);

    set("a", "t", [link(1, true), link(2, false)]);
    expect(told).toBe(1);
    expect(work.tasks(a, "t")).toEqual([
      {
        taskId: "pull-request-watch:github.com/o/r#1",
        description: "Watching pull request #1",
        kind: "monitor",
      },
    ]);
    // Another change of the view that leaves the watched links as they were is not told.
    set("a", "t", [link(1, true), link(2, false), link(3, false)]);
    expect(told).toBe(1);
    // A thread without links waits on nothing.
    expect(work.tasks(a, "other")).toEqual([]);

    // A node that goes away is unfollowed, its threads told, its last view not news.
    nodes.set([]);
    expect(told).toBe(2);
    expect(followers("a")).toBe(0);
    expect(work.tasks(a, "t")).toEqual([]);

    // Back again, what its view holds counts at once.
    nodes.set(["a"]);
    expect(told).toBe(3);
    expect(work.tasks(a, "t")).toHaveLength(1);

    // A node that connects watching nothing changes nothing for any thread: not told.
    nodes.set(["a", "b"]);
    expect(followers("b")).toBe(1);
    expect(told).toBe(3);

    // A connection that drops and is connecting again, still listed, is a node gone too.
    nodes.close("a");
    expect(told).toBe(4);
    expect(followers("a")).toBe(0);
    expect(work.tasks(a, "t")).toEqual([]);

    work.dispose();
    expect(followers("a")).toBe(0);
    nodes.set(["a", "b", "c"]);
    expect(followers("b")).toBe(0);
    expect(followers("c")).toBe(0);
  });

  it("follows a mesh member's threads through their connection once asked (D1289)", () => {
    const { store, set, followers } = fakeStore();
    const nodes = fakeConnections(["a"]);
    const work = createWatchedWork(store, nodes.connections);
    let told = 0;
    work.subscribe(() => told++);
    const member: NodeTarget = { node: "a", remote: "m" };
    // Not followed before something asks; asked, its empty view tells nothing.
    expect(followers("a", "m")).toBe(0);
    expect(work.tasks(member, "t")).toEqual([]);
    expect(followers("a", "m")).toBe(1);
    expect(told).toBe(0);
    // Asked again: still one follower.
    work.tasks(member, "t");
    expect(followers("a", "m")).toBe(1);

    set("a", "t", [link(4, true)], "m");
    expect(told).toBe(1);
    expect(work.tasks(member, "t")).toEqual([
      {
        taskId: "pull-request-watch:github.com/o/r#4",
        description: "Watching pull request #4",
        kind: "monitor",
      },
    ]);
    // The connection's own threads are another view.
    expect(work.tasks({ node: "a" }, "t")).toEqual([]);

    // The member goes with its connection: unfollowed, its threads told.
    nodes.set([]);
    expect(followers("a", "m")).toBe(0);
    expect(told).toBe(2);
    expect(work.tasks(member, "t")).toEqual([]);
    // A member of a node not connected is not followed.
    expect(followers("a", "m")).toBe(0);

    nodes.set(["a"]);
    work.tasks(member, "t");
    expect(followers("a", "m")).toBe(1);
    work.dispose();
    expect(followers("a", "m")).toBe(0);
  });
});
