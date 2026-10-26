// Every node Civilization mode reads (docs/plans/agents.md, M1: D1527): each
// open connection and each reachable member of its mesh, a member that is
// also connected read through its own connection, and one member once.
import {
  targetKey,
  type Connections,
  type MeshMember,
  type MeshMembership,
  type NodeConnection,
  type NodeTarget,
} from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

import { nodeChannel, type NodeChannel } from "./node-channel.ts";

/** A node to read, and how to reach it. */
export interface MeshTarget {
  /** `targetKey(target)`: a connection's id, or `<connection>|<member>`. */
  readonly key: string;
  readonly target: NodeTarget;
  readonly label: string;
  /** The open connection it is reached through. */
  readonly connection: NodeConnection;
  /** Its commands and streams, directly or through the connection (D504). */
  readonly channel: NodeChannel;
  /** Its id in the mesh, once the connection's mesh says. */
  readonly nodeId?: string;
}

/**
 * The open connections, each followed by its reachable members that are not
 * connected themselves and not listed already under an earlier connection.
 */
export function meshTargets(
  connections: readonly NodeConnection[],
  membersOf: (connection: string) => readonly MeshMember[] | undefined,
): MeshTarget[] {
  const open = connections.filter((connection) => connection.state === "open");
  const selfOf = new Map(
    open.map((connection) => [
      connection.id,
      membersOf(connection.id)?.find((member) => member.self)?.nodeId,
    ]),
  );
  const seen = new Set([...selfOf.values()].filter((id): id is string => id !== undefined));
  // Members wait until every connection's mesh has answered: a member that is
  // also connected is known only then, and is not read twice meanwhile.
  const known = open.every((connection) => membersOf(connection.id) !== undefined);
  return open.flatMap((connection): MeshTarget[] => {
    const self = selfOf.get(connection.id);
    const members = (known ? (membersOf(connection.id) ?? []) : []).filter((member) => {
      if (member.self || !member.reachable || seen.has(member.nodeId)) return false;
      seen.add(member.nodeId);
      return true;
    });
    return [
      {
        key: connection.id,
        target: { node: connection.id },
        label: connection.label,
        connection,
        channel: connection.client,
        ...(self === undefined ? {} : { nodeId: self }),
      },
      ...members.map((member): MeshTarget => {
        const target = { node: connection.id, remote: member.nodeId };
        return {
          key: targetKey(target),
          target,
          label: member.name,
          connection,
          channel: nodeChannel(connection.client, member.nodeId),
          nodeId: member.nodeId,
        };
      }),
    ];
  });
}

const sameTargets = (a: readonly MeshTarget[], b: readonly MeshTarget[]) =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index]!;
    return (
      item.key === other.key &&
      item.label === other.label &&
      item.channel === other.channel &&
      item.nodeId === other.nodeId
    );
  });

export interface MeshTargets extends Disposable {
  /** The nodes to read now: the same array until one changes. */
  snapshot(): readonly MeshTarget[];
  /** Hears every change of `snapshot`. */
  subscribe(listener: () => void): Disposable;
}

/**
 * Follows the connections and, without `mesh`, nothing else; with it, the
 * mesh of every open connection, so its members come and go with it.
 */
export function createMeshTargets(
  connections: Connections,
  mesh: MeshMembership | undefined,
): MeshTargets {
  const listeners = new Set<() => void>();
  const meshFeeds = new Map<string, Disposable>();
  let last: readonly MeshTarget[] = [];
  const compute = () =>
    meshTargets(connections.list(), (id) => (mesh === undefined ? undefined : mesh.members(id)));
  let syncing = false;
  let dirty = false;
  /** Follows the mesh of exactly the open connections; a feed answering at once is caught up after. */
  const follow = () => {
    if (mesh === undefined) return;
    const open = new Set(
      connections
        .list()
        .filter((connection) => connection.state === "open")
        .map((connection) => connection.id),
    );
    for (const id of open) if (!meshFeeds.has(id)) meshFeeds.set(id, mesh.subscribe(id, changed));
    for (const [id, feed] of meshFeeds)
      if (!open.has(id)) {
        feed.dispose();
        meshFeeds.delete(id);
      }
  };
  function changed() {
    dirty = true;
    if (syncing) return;
    syncing = true;
    try {
      while (dirty) {
        dirty = false;
        follow();
      }
    } finally {
      syncing = false;
    }
    const next = compute();
    if (sameTargets(next, last)) return;
    last = next;
    for (const listener of Array.from(listeners)) listener();
  }
  const watching = connections.subscribe(changed);
  changed();
  return {
    snapshot: () => last,
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose() {
      watching.dispose();
      listeners.clear();
      for (const feed of meshFeeds.values()) feed.dispose();
      meshFeeds.clear();
    },
  };
}

/** The node a route names (its connection, and the member through it), if any. */
export function routeTarget(route: { readonly node?: string; readonly remote?: string }) {
  if (route.node === undefined) return undefined;
  return route.remote === undefined
    ? { node: route.node }
    : { node: route.node, remote: route.remote };
}

/** The route fields that name `target`: `node`, and `remote` for a member. */
export const targetFields = (target: NodeTarget): { node: string; remote?: string } =>
  target.remote === undefined
    ? { node: target.node }
    : { node: target.node, remote: target.remote };
