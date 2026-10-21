import type { Connections, NodeConnection } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import { threadDraftKey, newThreadDraftKey, type Drafts } from "../../lib/composer.ts";

/**
 * Follows `threads/drafts` on every connection and takes another device's
 * text when it is later than this one's (D486). Members of a connection's
 * mesh are not followed: their drafts are read when a composer opens.
 */
export function followDrafts(
  connections: Connections,
  drafts: Pick<Drafts, "take">,
  enabled: () => boolean,
): Disposable {
  const followed = new Map<string, { client: NodeConnection["client"]; stop(): void }>();
  const sync = () => {
    const listed = connections.list();
    for (const [id, feed] of followed) {
      if (listed.find((connection) => connection.id === id)?.client === feed.client) continue;
      feed.stop();
      followed.delete(id);
    }
    for (const connection of listed) {
      if (followed.has(connection.id)) continue;
      const subscription = connection.client.subscribe(
        "threads/drafts",
        // An older node has no such stream: its drafts stay per device.
        { onError: () => undefined },
        (event) => {
          const change = event.payload as { key?: unknown; prompt?: unknown; at?: unknown };
          if (!enabled() || typeof change.key !== "string") return;
          if (typeof change.prompt !== "string" || typeof change.at !== "number") return;
          const [kind, id] = [
            change.key.slice(0, change.key.indexOf(":")),
            change.key.slice(change.key.indexOf(":") + 1),
          ];
          const target = { node: connection.id };
          const key =
            kind === "thread"
              ? threadDraftKey(target, id)
              : kind === "project"
                ? newThreadDraftKey(target, id)
                : undefined;
          if (key !== undefined) drafts.take(key, change.prompt, change.at);
        },
      );
      followed.set(connection.id, {
        client: connection.client,
        stop: () => subscription.dispose(),
      });
    }
  };
  sync();
  const subscription = connections.subscribe(sync);
  return {
    dispose() {
      subscription.dispose();
      for (const feed of followed.values()) feed.stop();
      followed.clear();
    },
  };
}
