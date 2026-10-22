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
import type { Disposable } from "@jhin/sdk";

/** A node the client shows: a connection, or a reachable member of an open connection's mesh. */
export interface ShownNode {
  readonly target: NodeTarget;
  readonly label: string;
  readonly state: NodeConnection["state"];
  /** The connection itself; undefined for a mesh member reached through it. */
  readonly connection?: NodeConnection;
}

/** Every node the client shows, each connection followed by the other reachable nodes of its mesh. */
export function shownNodes(
  connections: readonly NodeConnection[],
  membersOf: (connection: string) => readonly MeshMember[] | undefined,
): ShownNode[] {
  return connections.flatMap((connection): ShownNode[] => [
    {
      target: { node: connection.id },
      label: connection.label,
      state: connection.state,
      connection,
    },
    ...(connection.state === "open" ? (membersOf(connection.id) ?? []) : [])
      .filter((member) => !member.self && member.reachable)
      .map((member): ShownNode => ({
        target: { node: connection.id, remote: member.nodeId },
        label: member.name,
        state: "open",
      })),
  ]);
}

/**
 * Whether rows name the node they live on: only while the client shows more
 * than one node. With one node every row lives there, so none says so.
 */
export const showsHosts = (nodes: readonly ShownNode[]): boolean => nodes.length > 1;

/** A shown node with what the client knows of its projects and threads. */
export interface NodeWithCatalog extends ShownNode {
  readonly catalog: NodeCatalog;
}

const sameNodes = (a: readonly NodeWithCatalog[], b: readonly NodeWithCatalog[]) =>
  a.length === b.length &&
  a.every((node, index) => {
    const other = b[index]!;
    return (
      targetKey(node.target) === targetKey(other.target) &&
      node.label === other.label &&
      node.state === other.state &&
      node.connection === other.connection &&
      node.catalog === other.catalog
    );
  });

/**
 * The shown nodes and their catalogs as one store: while somebody subscribes it
 * follows the connections, the mesh of each connection and the catalog of each
 * shown node, so a view of all nodes at once (the sidebar) needs one hook.
 * `snapshot` is the same array until something in it changes.
 */
export function createShownNodes(
  connections: Connections,
  mesh: MeshMembership,
  threads: ThreadsCatalog,
) {
  const listeners = new Set<() => void>();
  const meshFeeds = new Map<string, Disposable>();
  const catalogFeeds = new Map<string, Disposable>();
  let connectionFeed: Disposable | undefined;
  let last: readonly NodeWithCatalog[] = [];
  let syncing = false;
  let dirty = false;

  const compute = (): NodeWithCatalog[] =>
    shownNodes(connections.list(), (id) => mesh.members(id)).map((node) => ({
      ...node,
      catalog: threads.catalog(node.target),
    }));

  /** Follows exactly the connections and nodes shown now; a feed answering at once is caught up after. */
  const follow = () => {
    const ids = new Set(connections.list().map((connection) => connection.id));
    for (const id of ids) if (!meshFeeds.has(id)) meshFeeds.set(id, mesh.subscribe(id, changed));
    for (const [id, feed] of meshFeeds)
      if (!ids.has(id)) {
        feed.dispose();
        meshFeeds.delete(id);
      }
    const targets = new Map(
      shownNodes(connections.list(), (id) => mesh.members(id)).map((node) => [
        targetKey(node.target),
        node.target,
      ]),
    );
    for (const [key, target] of targets)
      if (!catalogFeeds.has(key)) catalogFeeds.set(key, threads.subscribe(target, changed));
    for (const [key, feed] of catalogFeeds)
      if (!targets.has(key)) {
        feed.dispose();
        catalogFeeds.delete(key);
      }
  };

  function changed() {
    dirty = true;
    if (syncing) return;
    syncing = true;
    try {
      while (dirty) {
        dirty = false;
        if (listeners.size > 0) follow();
      }
    } finally {
      syncing = false;
    }
    for (const listener of Array.from(listeners)) listener();
  }

  return {
    snapshot(): readonly NodeWithCatalog[] {
      const next = compute();
      if (!sameNodes(next, last)) last = next;
      return last;
    },
    subscribe(listener: () => void): Disposable {
      listeners.add(listener);
      if (connectionFeed === undefined) {
        connectionFeed = connections.subscribe(changed);
        changed();
      }
      return {
        dispose() {
          listeners.delete(listener);
          if (listeners.size > 0) return;
          connectionFeed?.dispose();
          connectionFeed = undefined;
          for (const feed of [...meshFeeds.values(), ...catalogFeeds.values()]) feed.dispose();
          meshFeeds.clear();
          catalogFeeds.clear();
        },
      };
    },
  };
}
