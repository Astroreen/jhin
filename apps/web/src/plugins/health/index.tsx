// Health in Civilization mode (docs/plans/agents.md, A7: D731): open warnings
// in `civilization.sidebar.health`, the overview and a warning's page with the
// events behind it in `civilization.views`, and a notification when one is raised.
import type { Warning } from "@jhin/health-api";
import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
  type NodeConnection,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { HeartPulseIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal } from "../../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { tellOwner } from "../../lib/tell-owner.tsx";
import { HEALTH_PANEL, detectorLabel, groupLabel, healthRoute } from "./route.ts";
import { createHealthStore } from "./store.ts";
import type { HealthView } from "./views.tsx";

// The views are a chunk of their own (D440), loaded once Civilization mode shows them.
const viewsChunk = () => import("./views.tsx");
const List = lazyChunk(() => viewsChunk().then((module) => module.HealthList), {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load health.</ChunkFailed>
  ),
});
const Page = lazyChunk(() => viewsChunk().then((module) => module.HealthPage), {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load this warning.</ChunkFailed>
  ),
});

/**
 * `jhin.health`: the health warnings of every connected node (D731). It shows
 * in Civilization mode only (D741); the notification of a new warning shows
 * in any mode and opens it there.
 */
export const healthPlugin = builtin(
  "jhin.health",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);

      const open = (node: string, warningId?: string) =>
        navigation.navigate(healthRoute(node, warningId));
      /** A new warning: told the owner the way an ask is (D630, D731). */
      const raised = (connection: NodeConnection, warning: Warning) =>
        tellOwner(context.config, toasts, {
          title: `${detectorLabel(warning)}: ${groupLabel(warning.group)}`,
          body: warning.summary,
          tag: warning.warningId,
          icon: <HeartPulseIcon className="size-4" />,
          actionLabel: "Open health",
          // Through the command, as the palette, CLI and MCP open it.
          open: () =>
            void context.commands
              .execute("civilization.health.open", {
                node: connection.id,
                warningId: warning.warningId,
              })
              .catch((error: unknown) =>
                context.log.warn("opening a health warning failed", { error: String(error) }),
              ),
        });
      const store = createHealthStore(connections, context.log, raised);
      context.subscriptions.add(store);
      const view: HealthView = { store, connections, navigation, toasts };

      // Opening health is a command, so the palette, CLI and MCP reach it (rule 6).
      context.subscriptions.add(
        context.commands.register({
          name: "civilization.health.open",
          title: "Open health",
          description:
            "Opens Civilization mode's health: a warning with the events behind it, or the overview of ceremony and progress (D731). A warning id the node's health, once read, does not hold is WARNING_NOT_FOUND; while it is still being read the page opens and says so",
          input: z.object({
            node: z.string().min(1).meta({ description: "The connection the warning is on" }),
            warningId: z.string().min(1).optional(),
          }),
          output: z.object({}),
          handler: ({ node, warningId }) => {
            // The client's codes (`connections`, `machines`), and the node's for a warning.
            if (connections.get(node)?.state !== "open") {
              throw Object.assign(new Error(`Not connected to ${node}`), {
                code: "NODE_NOT_FOUND",
                details: { node },
              });
            }
            const feed = store.snapshot().get(node);
            if (
              warningId !== undefined &&
              (feed?.status === "ready" || feed?.status === "error") &&
              feed.value.warnings[warningId] === undefined
            ) {
              throw Object.assign(new Error(`No warning ${warningId}`), {
                code: "WARNING_NOT_FOUND",
                details: { node, warningId },
              });
            }
            open(node, warningId);
            return {};
          },
        }),
      );

      const HealthList = () => <List view={view} />;
      const HealthPage = () => {
        const route = useExternal(navigation, navigation.current);
        // Only its own panel: the other views of `civilization.views` render theirs (D750).
        if (route.panel !== HEALTH_PANEL || route.node === undefined) return null;
        return (
          <Page
            key={`${route.node}|${route.section ?? ""}`}
            node={route.node}
            view={view}
            {...(route.section === undefined ? {} : { warningId: route.section })}
          />
        );
      };
      context.subscriptions.add(
        slots.contribute("civilization.sidebar.health", {
          id: "jhin.health.list",
          component: HealthList,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.views", { id: "jhin.health.page", component: HealthPage }),
      );
    },
  }),
);
