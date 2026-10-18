import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  type Connections,
  type MeshMember,
  type MeshMembership,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

/** One connection's feed: a single `mesh` subscription, however many views watch it. */
interface Feed {
  readonly listeners: Set<() => void>;
  /** The client the feed reads from; `undefined` while the connection is not open. */
  client: RpcClient | undefined;
  members: readonly MeshMember[] | undefined;
  stop: (() => void) | undefined;
}

export const meshPlugin = builtin(
  "jhin.mesh-membership",
  {
    provides: { [MESH_CAPABILITY]: "1.0.0" },
    requires: { [CONNECTIONS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const feeds = new Map<string, Feed>();

      const notify = (feed: Feed) => {
        for (const listener of Array.from(feed.listeners)) {
          // One faulty consumer (e.g. a user plugin) never keeps the update from the others.
          try {
            listener();
          } catch (error) {
            context.log.error("a client.mesh listener failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };

      /** Starts the feed on the connection's current client, or stops it when there is none. */
      const sync = (id: string, feed: Feed) => {
        const node = connections.get(id);
        const client = node?.state === "open" ? node.client : undefined;
        if (client === feed.client) return;
        feed.stop?.();
        feed.stop = undefined;
        feed.client = client;
        // A new client (or none) never shows the previous one's members: the
        // reset is announced first, then the new client's answers follow.
        if (feed.members !== undefined) {
          feed.members = undefined;
          notify(feed);
          // The last subscriber may have left while being told.
          if (feeds.get(id) !== feed) return;
        }
        if (client !== undefined) feed.stop = follow(client, feed);
      };

      const follow = (client: RpcClient, feed: Feed): (() => void) => {
        let stopped = false;
        let latest = 0;
        const update = (members: readonly MeshMember[]) => {
          feed.members = members;
          notify(feed);
        };
        const load = () => {
          // Answers can arrive out of order: only the newest request may update.
          const request = ++latest;
          void client
            .call<MeshMember[]>("mesh.nodes")
            .then((members) => {
              if (!stopped && request === latest) update(members);
            })
            // A later failure says nothing new about the mesh: keep what is known.
            // Without any answer (no mesh plugin, or it fails) no remote is known; a
            // transient first failure reads as unreachable until the next mesh event.
            .catch(() => {
              if (!stopped && request === latest && feed.members === undefined) update([]);
            });
        };
        load();
        const subscription = client.subscribe("mesh", {}, load);
        return () => {
          stopped = true;
          subscription.dispose();
        };
      };

      const membership: MeshMembership = {
        members: (id) => feeds.get(id)?.members,
        subscribe(id, listener) {
          let feed = feeds.get(id);
          if (feed === undefined) {
            feed = { listeners: new Set(), client: undefined, members: undefined, stop: undefined };
            feeds.set(id, feed);
            sync(id, feed);
          }
          const current = feed;
          // A wrapper per subscription: the same listener may subscribe twice.
          const entry = () => listener();
          current.listeners.add(entry);
          return toDisposable(() => {
            current.listeners.delete(entry);
            if (current.listeners.size > 0 || feeds.get(id) !== current) return;
            current.stop?.();
            feeds.delete(id);
          });
        },
      };

      context.subscriptions.add(
        connections.subscribe(() => {
          for (const [id, feed] of feeds) sync(id, feed);
        }),
      );
      context.subscriptions.add({
        dispose() {
          for (const feed of feeds.values()) feed.stop?.();
          feeds.clear();
        },
      });
      context.services.provide(MESH_CAPABILITY, membership);
    },
  }),
);
