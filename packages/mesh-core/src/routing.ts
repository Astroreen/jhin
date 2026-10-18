import type { MemberRecord } from "./types.ts";

/**
 * Shortest path from `from` to `to` (D28). An edge between two other nodes
 * counts only when both list each other as neighbors: a node that went away
 * cannot update its own record, but its neighbors drop it from theirs. The
 * starting node's own edges are its live links only, so the first hop is
 * always usable.
 */
export function shortestPath(
  records: ReadonlyMap<string, MemberRecord>,
  from: string,
  liveLinks: ReadonlySet<string>,
  to: string,
): string[] | undefined {
  if (from === to) return [from];
  const edges = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (a === b || !records.has(a) || !records.has(b)) return;
    if (a === from || b === from) return;
    (edges.get(a) ?? edges.set(a, new Set()).get(a)!).add(b);
    (edges.get(b) ?? edges.set(b, new Set()).get(b)!).add(a);
  };
  for (const record of records.values()) {
    for (const neighbor of record.neighbors) {
      if (records.get(neighbor)?.neighbors.includes(record.nodeId) === true) {
        connect(record.nodeId, neighbor);
      }
    }
  }
  edges.set(from, new Set([...liveLinks].filter((id) => records.has(id))));
  for (const id of liveLinks) (edges.get(id) ?? edges.set(id, new Set()).get(id)!).add(from);

  const previous = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of [...(edges.get(node) ?? [])].toSorted()) {
      if (previous.has(next)) continue;
      previous.set(next, node);
      if (next === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(previous.get(path[0]!)!);
        return path;
      }
      queue.push(next);
    }
  }
  return undefined;
}
