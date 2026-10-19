import {
  targetKey,
  type Connections,
  type MeshMember,
  type MeshMembership,
  type NodeCatalog,
  type NodeConnection,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { createShownNodes, shownNodes, showsHosts } from "../src/lib/nodes.ts";

const connection = (id: string, state: NodeConnection["state"] = "open"): NodeConnection =>
  ({ id, url: id, label: `label ${id}`, state, client: {} }) as unknown as NodeConnection;

const member = (name: string, extra: Partial<MeshMember> = {}): MeshMember => ({
  nodeId: `id-${name}`,
  name,
  self: false,
  reachable: true,
  ...extra,
});

describe("the nodes the client shows (D70)", () => {
  it("lists each connection, then the other reachable nodes of its mesh", () => {
    const nodes = shownNodes([connection("a"), connection("x")], (id) =>
      id === "a"
        ? [member("a", { self: true }), member("b"), member("gone", { reachable: false })]
        : undefined,
    );
    expect(nodes.map((node) => [targetKey(node.target), node.label, node.state])).toEqual([
      ["a", "label a", "open"],
      ["a|id-b", "b", "open"],
      ["x", "label x", "open"],
    ]);
    expect(nodes[0]!.connection?.id).toBe("a");
    expect(nodes[1]!.connection).toBeUndefined();
  });

  it("shows no mesh member through a connection that is not open", () => {
    const nodes = shownNodes([connection("a", "connecting")], () => [member("b")]);
    expect(nodes.map((node) => targetKey(node.target))).toEqual(["a"]);
  });

  it("names the node of each row only while several nodes are shown", () => {
    expect(showsHosts(shownNodes([connection("a")], () => [member("a", { self: true })]))).toBe(
      false,
    );
    expect(showsHosts(shownNodes([connection("a")], () => [member("b")]))).toBe(true);
    expect(showsHosts(shownNodes([connection("a"), connection("x")], () => undefined))).toBe(true);
    expect(showsHosts([])).toBe(false);
  });
});

/** Connections, mesh and catalogs a test changes by hand; each counts its open subscriptions. */
function world() {
  const listeners = new Set<() => void>();
  let list: readonly NodeConnection[] = [];
  const meshListeners = new Map<string, Set<() => void>>();
  const members = new Map<string, readonly MeshMember[]>();
  const catalogListeners = new Map<string, Set<() => void>>();
  const catalogs = new Map<string, NodeCatalog>();
  const loading: NodeCatalog = { status: "loading", projects: [], threads: [] };
  const fire = (set: Set<() => void> | undefined) => {
    for (const listener of Array.from(set ?? [])) listener();
  };
  const add = <K>(map: Map<K, Set<() => void>>, key: K, listener: () => void) => {
    const set = map.get(key) ?? new Set();
    map.set(key, set);
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  const connections = {
    list: () => list,
    subscribe: (listener: () => void) => add(new Map([[0, listeners]]), 0, listener),
  } as unknown as Connections;
  const mesh: MeshMembership = {
    members: (id) => members.get(id),
    subscribe: (id, listener) => add(meshListeners, id, listener),
  };
  const threads = {
    catalog: (target: NodeTarget) => catalogs.get(targetKey(target)) ?? loading,
    subscribe: (target: NodeTarget, listener: () => void) =>
      add(catalogListeners, targetKey(target), listener),
  } as unknown as ThreadsCatalog;
  const open = (map: Map<string, Set<() => void>>) =>
    [...map].filter(([, set]) => set.size > 0).map(([key]) => key);
  return {
    connections,
    mesh,
    threads,
    setConnections(next: readonly NodeConnection[]) {
      list = next;
      fire(listeners);
    },
    setMembers(id: string, next: readonly MeshMember[]) {
      members.set(id, next);
      fire(meshListeners.get(id));
    },
    setCatalog(target: NodeTarget, catalog: NodeCatalog) {
      catalogs.set(targetKey(target), catalog);
      fire(catalogListeners.get(targetKey(target)));
    },
    following: () => ({ mesh: open(meshListeners), catalogs: open(catalogListeners) }),
  };
}

describe("the sidebar's view of every shown node (D70)", () => {
  it("follows the mesh of each connection and the catalog of each shown node, and lets go", () => {
    const w = world();
    const view = createShownNodes(w.connections, w.mesh, w.threads);
    let changes = 0;
    w.setConnections([connection("a")]);
    const subscription = view.subscribe(() => (changes += 1));
    expect(w.following()).toEqual({ mesh: ["a"], catalogs: ["a"] });

    // A member of a's mesh becomes reachable: its catalog is followed too.
    w.setMembers("a", [member("a", { self: true }), member("b")]);
    expect(w.following()).toEqual({ mesh: ["a"], catalogs: ["a", "a|id-b"] });
    expect(view.snapshot().map((node) => node.label)).toEqual(["label a", "b"]);

    const ready: NodeCatalog = { status: "ready", projects: [], threads: [] };
    const before = changes;
    w.setCatalog({ node: "a", remote: "id-b" }, ready);
    expect(changes).toBe(before + 1);
    expect(view.snapshot()[1]!.catalog).toBe(ready);

    // b leaves: its catalog is no longer followed.
    w.setMembers("a", [member("a", { self: true })]);
    expect(w.following()).toEqual({ mesh: ["a"], catalogs: ["a"] });

    subscription.dispose();
    expect(w.following()).toEqual({ mesh: [], catalogs: [] });
  });

  it("keeps the same snapshot until something in it changes", () => {
    const w = world();
    const view = createShownNodes(w.connections, w.mesh, w.threads);
    w.setConnections([connection("a")]);
    const subscription = view.subscribe(() => undefined);
    const first = view.snapshot();
    expect(view.snapshot()).toBe(first);
    w.setCatalog({ node: "a" }, { status: "ready", projects: [], threads: [] });
    expect(view.snapshot()).not.toBe(first);
    subscription.dispose();
  });
});
