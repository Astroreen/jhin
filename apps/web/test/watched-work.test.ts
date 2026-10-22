import type { Connections, NodeConnection, NodeTarget } from "@jhin/client-api";
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
      ({ links: links.get(target.node) ?? new Map() }) as unknown as SourceControlView,
    subscribe(target, listener) {
      const set = followers.get(target.node) ?? new Set();
      followers.set(target.node, set);
      set.add(listener);
      return { dispose: () => set.delete(listener) };
    },
  };
  return {
    store,
    followers: (node: string) => followers.get(node)?.size ?? 0,
    set(node: string, threadId: string, list: ThreadPullRequest[]) {
      const byThread = links.get(node) ?? new Map();
      links.set(node, byThread);
      byThread.set(threadId, list);
      for (const listener of Array.from(followers.get(node) ?? [])) listener();
    },
  };
}

function fakeConnections(ids: string[]) {
  let current = ids;
  const listeners = new Set<() => void>();
  const connections: Pick<Connections, "list" | "subscribe"> = {
    list: () => current.map((id) => ({ id }) as NodeConnection),
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
    // A remote target, or a thread without links, waits on nothing here.
    expect(work.tasks({ node: "a", remote: "r" }, "t")).toEqual([]);
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

    work.dispose();
    expect(followers("a")).toBe(0);
    nodes.set(["a", "b"]);
    expect(followers("b")).toBe(0);
  });
});
