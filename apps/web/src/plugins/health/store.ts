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
import type { Connections, MeshMembership } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import type { MeshTarget } from "../../lib/mesh-targets.ts";

import {
  createNodeFeeds,
  newestToTell,
  type NodeFeed,
  type NodeFeeds,
} from "../../lib/node-feeds.ts";

export type NodeHealth = NodeFeed<HealthState>;
export type HealthStore = NodeFeeds<HealthState>;

/**
 * Follows health on every open connection, and with `mesh` on every reachable
 * member of one (M1, D1530), for as long as the plugin runs, so
 * a warning is told to the owner in any mode: `health.catalog`, then the
 * `health` stream after its head. `raised` hears each warning raised after
 * the catalog, never the ones already there.
 */
export function createHealthStore(
  connections: Connections,
  log: {
    warn(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
  },
  raised: (node: MeshTarget, warning: Warning) => void,
  mesh?: MeshMembership,
): HealthStore & Disposable {
  return createNodeFeeds<HealthState>(
    connections,
    log,
    {
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
          },
        };
      },
      // Commits are no part of the fold: the counts come from `health.status`.
      apply: applyHealthEvent,
      reread: (connection, before, after) => {
        const fresh = Object.values(after.warnings)
          .filter(
            (warning) =>
              warning.status === "open" && before.warnings[warning.warningId] === undefined,
          )
          .toSorted((a, b) => b.raisedAt.localeCompare(a.raisedAt));
        for (const warning of newestToTell(fresh, log, HEALTH_STREAM)) raised(connection, warning);
      },
      seen: (connection, event, before) => {
        const warning = (event.payload as { warning?: Warning } | null)?.warning;
        // A warning told once: a replayed raise of a known warning is not news.
        if (
          event.type === HealthEvents.warningRaised &&
          warning !== undefined &&
          before.warnings[warning.warningId] === undefined
        ) {
          raised(connection, warning);
        }
      },
    },
    {},
    mesh,
  );
}

/** The open warnings of every node, newest first, with the key of the node each is on. */
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
