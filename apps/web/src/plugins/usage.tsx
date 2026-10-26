// The Usage page's limits (t3-parity.md D1308–D1310). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/components/usage/UsagePage.tsx (its
// "Limits" view: the breadcrumb, "Refresh limits"), UsageLimitsPooled.tsx (PoolSection,
// PoolWindowCard, PoolBar, PoolSegment, LimitNotices) and the sidebar's "Usage" item
// (SidebarChrome.tsx). The page itself is usage-page.tsx.
import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type Connections,
  type MeshMembership,
  type Navigation,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_SLOTS_CAPABILITY,
  type SlotRegistry,
} from "@jhin/ui";
import { ChartNoAxesColumnIcon } from "lucide-react";

import { builtin } from "../lib/builtin.ts";
import { useExternal } from "../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../lib/lazy-chunk.tsx";
import { createShownNodes } from "../lib/nodes.ts";
import type { UsagePageProps } from "./usage-page.tsx";

/** The panel the page shows in (`client.navigation@1`'s `panel`). */
const USAGE_PANEL = "usage";

const UsagePage = lazyChunk<UsagePageProps>(
  () => import("./usage-page.tsx").then((module) => module.UsagePage),
  {
    loading: () => null,
    failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load the usage.</ChunkFailed>,
  },
);

export const usagePlugin = builtin(
  "jhin.usage",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const shown = createShownNodes(
        context.services.get<Connections>(CONNECTIONS_CAPABILITY),
        context.services.get<MeshMembership>(MESH_CAPABILITY),
        threads,
      );

      const open = () => {
        const { section: _section, ...route } = navigation.current();
        navigation.navigate({ ...route, panel: USAGE_PANEL });
      };
      const close = () => {
        const { panel: _panel, section: _section, ...rest } = navigation.current();
        navigation.navigate(rest);
      };

      context.commands.register({
        name: "usage.open",
        title: "Open usage",
        description: "Opens the Usage page: every node's agents and their usage limits",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          open();
          return {};
        },
      });

      function UsageButton() {
        return (
          <SidebarMenuItem className="shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuButton
                    aria-label="Usage"
                    onClick={() => void context.commands.execute("usage.open", {})}
                    size="icon"
                  />
                }
              >
                <ChartNoAxesColumnIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Usage</TooltipPopup>
            </Tooltip>
          </SidebarMenuItem>
        );
      }

      // The page is a chunk of its own, loaded when it first opens (D1595).
      function UsagePageSlot() {
        const route = useExternal(navigation, navigation.current);
        if (route.panel !== USAGE_PANEL) return null;
        return <UsagePage close={close} log={context.log} shown={shown} threads={threads} />;
      }

      context.subscriptions.add(
        slots.contribute("sidebar.footer", {
          id: "jhin.usage.sidebar-item",
          order: 10,
          component: UsageButton,
        }),
      );
      context.subscriptions.add(
        slots.contribute("app.main", { id: "jhin.usage.page", component: UsagePageSlot }),
      );
    },
  }),
);
