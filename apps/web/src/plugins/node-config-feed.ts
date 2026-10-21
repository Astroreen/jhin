import {
  CONNECTIONS_CAPABILITY,
  NODE_CONFIG_CHANGED,
  type Connections,
  type NodeConfigChanged,
  type NodeConnection,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

/**
 * `jhin.node-config-feed`: follows `host/config` (D483) on every open
 * connection and tells the client's plugins with `node.config.changed`
 * (D484). A node older than the stream sends nothing; its changes still show
 * after a reconnect or a reload.
 */
export const nodeConfigFeedPlugin = builtin(
  "jhin.node-config-feed",
  { requires: { [CONNECTIONS_CAPABILITY]: "^1" } },
  definePlugin({
    activate(context) {
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      /** One subscription per connection client; the client resubscribes on reconnect. */
      const followed = new Map<string, { client: NodeConnection["client"]; stop(): void }>();
      /** Each connection's state as last seen, to tell when it opens again. */
      const states = new Map<string, NodeConnection["state"]>();
      /** Connections that were open once: only those open "again". */
      const wasOpen = new Set<string>();
      const sync = () => {
        const listed = connections.list();
        for (const connection of listed) {
          const before = states.get(connection.id);
          states.set(connection.id, connection.state);
          // Nothing is replayed from host/config: whatever changed while away is read again.
          if (connection.state === "open" && wasOpen.has(connection.id) && before !== "open") {
            context.events.emit(NODE_CONFIG_CHANGED, {
              connection: connection.id,
              layer: "node",
              sections: [],
              all: true,
            } satisfies NodeConfigChanged);
          }
        }
        for (const connection of listed)
          if (connection.state === "open") wasOpen.add(connection.id);
        for (const id of states.keys())
          if (!listed.some((connection) => connection.id === id)) {
            states.delete(id);
            wasOpen.delete(id);
          }
        for (const [id, feed] of followed) {
          const connection = listed.find((candidate) => candidate.id === id);
          if (connection?.client === feed.client) continue;
          feed.stop();
          followed.delete(id);
        }
        for (const connection of listed) {
          if (followed.has(connection.id)) continue;
          const subscription = connection.client.subscribe(
            "host/config",
            // A node that refuses (older, or no permission) is simply not followed.
            {
              onError: (error) =>
                context.log.debug("host/config not followed", {
                  connection: connection.id,
                  error: error.message,
                }),
            },
            (event) => {
              const payload = event.payload as Partial<Omit<NodeConfigChanged, "connection">>;
              if (!Array.isArray(payload.sections)) return;
              context.events.emit(NODE_CONFIG_CHANGED, {
                connection: connection.id,
                layer: payload.layer === "project" ? "project" : "node",
                sections: payload.sections.filter((section) => typeof section === "string"),
              } satisfies NodeConfigChanged);
            },
          );
          followed.set(connection.id, {
            client: connection.client,
            stop: () => subscription.dispose(),
          });
        }
      };
      sync();
      context.subscriptions.add(connections.subscribe(sync));
      context.subscriptions.add({
        dispose: () => {
          for (const feed of followed.values()) feed.stop();
          followed.clear();
        },
      });
    },
  }),
);
