import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { teamRoute } from "./route.ts";
import type { TeamsStore } from "./store.ts";
import type { TeamsServices } from "./view.tsx";

const said = (text: string) => ({
  loading: () => null,
  failed: (_props: object, retry: () => void) => <ChunkFailed retry={retry}>{text}</ChunkFailed>,
});

/**
 * `jhin.teams-view`: teams in Civilization mode (docs/plans/agents.md, A5:
 * D691). The Teams section of the sidebar lists the route's node's teams; a
 * team's page in `civilization.views` shows its agents with their status, its
 * culture, Start and Stop for the whole team, and a message to its lead.
 */
export const teamsViewPlugin = builtin(
  "jhin.teams-view",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      // The views and their store are a chunk of their own (D440), loaded once
      // the Teams section or a team shows: Threads mode never loads them.
      let store: TeamsStore | undefined;
      const viewChunk = () =>
        import("./view.tsx").then((module) => {
          store ??= context.subscriptions.add(module.createTeamsStore(connections, context.log));
          const services: TeamsServices = { navigation, connections, toasts, store };
          return { module, services };
        });
      const Sidebar = lazyChunk(
        () =>
          viewChunk().then(({ module, services }) => () => (
            <module.TeamsSidebar services={services} />
          )),
        said("Couldn't load teams."),
      );
      const Main = lazyChunk(
        () =>
          viewChunk().then(({ module, services }) => () => (
            <module.TeamsMain services={services} />
          )),
        said("Couldn't load the team."),
      );

      // Opening a team is a command, so the palette, CLI and MCP reach it (rule 6).
      context.subscriptions.add(
        context.commands.register({
          name: "civilization.team.open",
          title: "Open team",
          description: "Opens a team's page in Civilization mode (D691)",
          input: z.object({
            node: z.string().min(1).meta({ description: "The connection the team is on" }),
            teamId: z.string().min(1),
          }),
          output: z.object({}),
          handler: ({ node, teamId }) => {
            navigation.navigate(teamRoute({ node, mode: "civilization" }, teamId));
            return {};
          },
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.sidebar.teams", {
          id: "jhin.teams.sidebar",
          component: Sidebar,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.views", { id: "jhin.teams.view", component: Main }),
      );
    },
  }),
);
