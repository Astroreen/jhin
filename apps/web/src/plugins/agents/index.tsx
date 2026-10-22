// Civilization mode's agents (docs/plans/agents.md, A1: D614–D617): the
// roster in the `civilization.sidebar.agents` slot and an agent's page in
// `civilization.views`, its generations read through `thread.transcript`.
import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type Connections,
  type Navigation,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { useExternal } from "../../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { agentRoute, parseAgentSection, AGENT_PANEL } from "./route.ts";
import type { AgentsStore } from "./store.ts";
import type { AgentsView } from "./views.tsx";

// The views are a chunk of their own (D440), loaded once Civilization mode shows them.
const viewsChunk = () => import("./views.tsx");
const Roster = lazyChunk(() => viewsChunk().then((module) => module.Roster), {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load the agents.</ChunkFailed>
  ),
});
const Page = lazyChunk(() => viewsChunk().then((module) => module.AgentPage), {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load this agent.</ChunkFailed>
  ),
});

/**
 * `jhin.agents-view`: the defined agents of the connected nodes in
 * Civilization mode (D614). It reads them with the `agents.*` commands and
 * events, and puts nothing into Threads mode.
 */
export const agentsViewPlugin = builtin(
  "jhin.agents-view",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      // The store comes with the views' chunk, made when they first show (D440).
      const held: { store?: AgentsStore } = {};
      context.subscriptions.add({ dispose: () => held.store?.dispose() });
      const view: AgentsView = { context, held, connections, navigation, threads, toasts };

      // Opening an agent is a command, so the palette, CLI and MCP reach it (rule 6).
      context.subscriptions.add(
        context.commands.register({
          name: "civilization.agent.open",
          title: "Open agent",
          description:
            "Opens a defined agent's page in Civilization mode, at its current generation or the one named (D615)",
          input: z.object({
            node: z.string().min(1).meta({ description: "The connection the agent is on" }),
            agentId: z.string().min(1),
            generation: z.number().int().positive().optional(),
          }),
          output: z.object({}),
          handler: ({ node, agentId, generation }) => {
            navigation.navigate(agentRoute(node, agentId, generation));
            return {};
          },
        }),
      );

      const AgentsRoster = () => <Roster view={view} />;
      const AgentView = () => {
        const route = useExternal(navigation, navigation.current);
        // Only its own panel: the other views of `civilization.views` render theirs (D750).
        if (route.panel !== AGENT_PANEL || route.node === undefined) return null;
        const section = parseAgentSection(route.section);
        if (section === undefined) return null;
        return (
          <Page
            agentId={section.agentId}
            generation={section.generation}
            key={`${route.node}|${section.agentId}`}
            node={route.node}
            view={view}
          />
        );
      };

      context.subscriptions.add(
        slots.contribute("civilization.sidebar.agents", {
          id: "jhin.agents.roster",
          component: AgentsRoster,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.views", { id: "jhin.agents.page", component: AgentView }),
      );
    },
  }),
);
