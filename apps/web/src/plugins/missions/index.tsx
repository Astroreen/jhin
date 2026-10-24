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
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  type Dialogs,
  type SlotRegistry,
} from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { CIVILIZATION_MODE } from "../../lib/modes.ts";
import { MISSION_ASIDE_SLOT, routeOf, type MissionAsideProps } from "./route.ts";
import type { MissionsStore } from "./store.ts";
import type { MissionsServices } from "./view.tsx";

const said = (text: string) => ({
  loading: () => null,
  failed: (_props: object, retry: () => void) => <ChunkFailed retry={retry}>{text}</ChunkFailed>,
});

/**
 * `jhin.missions-view`: missions in Civilization mode (docs/plans/agents.md, A3:
 * D653–D656). The Missions section of the sidebar lists a node's missions; the
 * view in `civilization.views` shows a mission with the project's intent and its
 * waves of slices, a slice with its spec and proof, and a thread working on it,
 * read only. It reads `missions.catalog` and follows the `missions` stream;
 * editing stays with the `missions.*` and `slices.*` commands (Deferred).
 */
export const missionsViewPlugin = builtin(
  "jhin.missions-view",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: { [MESH_CAPABILITY]: "^1", [UI_DIALOGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const shared = {
        navigation: context.services.get<Navigation>(NAVIGATION_CAPABILITY),
        connections,
        threads: context.services.get<ThreadsCatalog>(THREADS_CAPABILITY),
        mesh: context.services.tryGet<MeshMembership>(MESH_CAPABILITY),
        // Deleting, like stopping, is confirmed or not done (D1090, D1395).
        dialogs: context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY),
      };
      // The view and its store are a chunk of their own (D440), loaded once the
      // Missions section or a mission shows: Threads mode never loads them. The
      // store is made once, with the first load.
      let store: MissionsStore | undefined;
      const viewChunk = () =>
        import("./view.tsx").then((module) => {
          store ??= context.subscriptions.add(module.createMissionsStore(connections, context.log));
          return { module, services: { ...shared, store } satisfies MissionsServices };
        });
      const Sidebar = lazyChunk(
        () =>
          viewChunk().then(({ module, services }) => () => (
            <module.MissionsSidebar services={services} />
          )),
        said("Couldn't load missions."),
      );
      const Main = lazyChunk(
        () =>
          viewChunk().then(({ module, services }) => () => (
            <module.MissionsMain services={services} />
          )),
        said("Couldn't load the mission view."),
      );

      context.subscriptions.add(
        slots.contribute("civilization.sidebar.missions", {
          id: "jhin.missions.sidebar",
          component: Sidebar,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.views", {
          id: "jhin.missions.view",
          component: Main,
        }),
      );
      // Opening a mission is a command, so the palette, CLI, MCP and the Lead
      // view's report card reach it (rule 6, D1393).
      context.subscriptions.add(
        context.commands.register({
          name: "civilization.mission.open",
          title: "Open mission",
          description: "Opens a mission in Civilization mode's mission view (D1393)",
          input: z.object({
            node: z.string().min(1).meta({ description: "The connection the mission is on" }),
            remote: z.string().min(1).optional().meta({
              description: "A member of that connection's mesh the mission is on (D1529)",
            }),
            missionId: z.string().min(1),
          }),
          output: z.object({}),
          handler: ({ node, remote, missionId }) => {
            shared.navigation.navigate(
              routeOf(
                { node, ...(remote === undefined ? {} : { remote }), mode: CIVILIZATION_MODE },
                { kind: "mission", missionId },
              ),
            );
            return {};
          },
        }),
      );
      // The orchestrator beside a mission (C2: D1087), a chunk of its own.
      const orchestrator = {
        connections,
        mesh: shared.mesh,
        threads: shared.threads,
        dialogs: shared.dialogs,
      };
      const Orchestrator = lazyChunk(
        () =>
          import("./orchestrator.tsx").then((module) => (props: MissionAsideProps) => (
            <module.OrchestratorPanel {...props} services={orchestrator} />
          )),
        said("Couldn't load the orchestrator."),
      );
      context.subscriptions.add(
        slots.contribute(MISSION_ASIDE_SLOT, {
          id: "jhin.orchestrator.panel",
          component: Orchestrator,
        }),
      );
    },
  }),
);
