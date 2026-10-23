import {
  targetKey,
  type Connections,
  type NodeTarget,
  type ThreadWorkSource,
} from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import type { SourceControlStore } from "./store.ts";

/**
 * The background work source control reports (D1131): a watched pull request
 * keeps its thread waiting between turns, as T3's pending background work.
 * Every connected node is followed while it is connected, outside any render:
 * a node's view is empty until something follows it. A mesh member's threads
 * (D1289) are followed through their connection from the first time one is
 * asked about, until that connection goes.
 */
export function createWatchedWork(
  store: Pick<SourceControlStore, "view" | "subscribe">,
  connections: Pick<Connections, "list" | "subscribe">,
): ThreadWorkSource & Disposable {
  const followed = new Map<string, Disposable>();
  /** Mesh members followed through a connection, by their target's key. */
  const members = new Map<string, { readonly node: string; readonly subscription: Disposable }>();
  const listeners = new Set<() => void>();
  /** Each node's watched links as last told, so only a change of them is told. */
  const watchedOf = new Map<string, string>();
  const tell = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const watchedNow = (target: NodeTarget) =>
    JSON.stringify(
      Array.from(store.view(target).links)
        .flatMap(([threadId, list]) =>
          list
            .filter((link) => link.watch !== undefined)
            .map((link) => JSON.stringify([threadId, link.key])),
        )
        .toSorted(),
    );
  const notify = (target: NodeTarget) => {
    const key = targetKey(target);
    const now = watchedNow(target);
    // A node first followed with nothing watched tells nothing: nothing changed for its threads.
    if ((watchedOf.get(key) ?? "[]") === now) return;
    watchedOf.set(key, now);
    tell();
  };
  const follow = () => {
    // Only an open connection is a connected node: a closed or reconnecting one's last
    // view is not news.
    const ids = new Set(
      connections
        .list()
        .filter((connection) => connection.state === "open")
        .map((connection) => connection.id),
    );
    for (const id of ids) {
      if (followed.has(id)) continue;
      const target: NodeTarget = { node: id };
      followed.set(
        id,
        store.subscribe(target, () => notify(target)),
      );
      // What the node's view holds already (followed by another part before) counts now.
      notify(target);
    }
    let dropped = false;
    for (const [id, subscription] of followed) {
      if (ids.has(id)) continue;
      subscription.dispose();
      followed.delete(id);
      watchedOf.delete(targetKey({ node: id }));
      dropped = true;
    }
    // A mesh member is reached through its connection: it goes with it.
    for (const [key, member] of members) {
      if (ids.has(member.node)) continue;
      member.subscription.dispose();
      members.delete(key);
      watchedOf.delete(key);
      dropped = true;
    }
    // A node that went away waits on nothing any more: its threads are told so.
    if (dropped) tell();
  };
  follow();
  const following = connections.subscribe(follow);
  return {
    tasks: (target, threadId) => {
      // Only a node followed now: a disconnected one's last view is not news.
      if (!followed.has(target.node)) return [];
      if (target.remote !== undefined) {
        const key = targetKey(target);
        if (!members.has(key)) {
          // Its view is empty until followed: nothing is told until its links come.
          const member: NodeTarget = { node: target.node, remote: target.remote };
          members.set(key, {
            node: target.node,
            subscription: store.subscribe(member, () => notify(member)),
          });
        }
      }
      return (store.view(target).links.get(threadId) ?? []).flatMap((link) =>
        link.watch === undefined
          ? []
          : [
              {
                taskId: `pull-request-watch:${link.key}`,
                description: `Watching pull request #${link.number}`,
                kind: "monitor" as const,
              },
            ],
      );
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      following.dispose();
      for (const subscription of followed.values()) subscription.dispose();
      followed.clear();
      for (const member of members.values()) member.subscription.dispose();
      members.clear();
      listeners.clear();
    },
  };
}
