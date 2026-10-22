// Health on each connected node (docs/plans/agents.md, A7: D721, D731): its
// warnings, kept current from the `health` stream.
import {
  EMPTY_HEALTH,
  HEALTH_STREAM,
  HealthEvents,
  applyHealthEvent,
  type HealthState,
  type Idea,
  type Warning,
} from "@jhin/health-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import { createNodeFeeds, type NodeFeed, type NodeFeeds } from "../../lib/node-feeds.ts";

export type NodeHealth = NodeFeed<HealthState>;
export type HealthStore = NodeFeeds<HealthState>;

/**
 * Follows health on every open connection for as long as the plugin runs, so
 * a warning is told to the owner in any mode: `health.catalog`, then the
 * `health` stream after its head. `raised` hears each warning raised after
 * the catalog, never the ones already there.
 */
export function createHealthStore(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  raised: (connection: NodeConnection, warning: Warning) => void,
): HealthStore & Disposable {
  return createNodeFeeds<HealthState>(connections, log, {
    empty: EMPTY_HEALTH,
    stream: HEALTH_STREAM,
    load: async (client) => {
      const { head, warnings, ideas } = await client.call<{
        head: number;
        warnings: Warning[];
        ideas: Idea[];
      }>("health.catalog", {});
      return {
        head,
        state: {
          warnings: Object.fromEntries(warnings.map((warning) => [warning.warningId, warning])),
          ideas: Object.fromEntries(ideas.map((idea) => [idea.ideaId, idea])),
          progress: [],
        },
      };
    },
    apply: applyHealthEvent,
    seen: (connection, event) => {
      const warning = (event.payload as { warning?: Warning } | null)?.warning;
      if (event.type === HealthEvents.warningRaised && warning !== undefined) {
        raised(connection, warning);
      }
    },
  });
}

/** The open warnings of every node, newest first, with the connection each is on. */
export function openWarnings(
  nodes: ReadonlyMap<string, NodeHealth>,
): { readonly node: string; readonly warning: Warning }[] {
  return [...nodes]
    .flatMap(([node, feed]) =>
      Object.values(feed.value.warnings)
        .filter((warning) => warning.status === "open")
        .map((warning) => ({ node, warning })),
    )
    .toSorted((a, b) => b.warning.raisedAt.localeCompare(a.warning.raisedAt));
}
