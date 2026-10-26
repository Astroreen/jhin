import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Keybindings,
  type MeshMembership,
  type Modes,
  type Navigation,
} from "@jhin/client-api";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";
import { LandmarkIcon } from "lucide-react";

import { AGENTS_STREAM } from "@jhin/agent-api";

import { askAgents } from "../lib/agents-presence.ts";
import { builtin } from "../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../lib/lazy-chunk.tsx";
import { createMeshTargets } from "../lib/mesh-targets.ts";
import { CIVILIZATION_MODE } from "../lib/modes.ts";
import type { CivilizationShell } from "./civilization-shell.tsx";

// The shell is a chunk of its own (D440), loaded once Civilization mode shows.
const shellChunk = () => import("./civilization-shell.tsx");
// The sidebar and main area say when the chunk failed; the footer's buttons stay out.
const said = {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load Civilization mode.</ChunkFailed>
  ),
};
const quiet = { loading: () => null, failed: () => null };
const Sidebar = lazyChunk(() => shellChunk().then((module) => module.CivilizationSidebar), said);
const Settings = lazyChunk(() => shellChunk().then((module) => module.SettingsButton), quiet);
const Palette = lazyChunk(() => shellChunk().then((module) => module.PaletteButton), quiet);
const Main = lazyChunk(() => shellChunk().then((module) => module.CivilizationMain), said);

/** The `jhin.civilization` config section (D747). */
const CIVILIZATION_SECTION = "jhin.civilization";
export const CivilizationConfig = z
  .object({
    enabled: z.enum(["auto", "on", "off"]).default("auto").meta({
      title: "Civilization mode",
      description:
        "auto: offered once a node of the mesh has a defined agent (agents.catalog); on: always; off: never.",
    }),
  })
  .meta({
    title: "Civilization",
    description: "The client's mode for long projects run by agent teams (docs/plans/agents.md).",
  });
export type CivilizationConfig = z.output<typeof CivilizationConfig>;

/**
 * `jhin.civilization`: the Civilization shell (D741, D747–D750). It adds the
 * mode, its sidebar sections and main area as slots, with empty states that
 * name the workstream that fills each. It shows no data of its own.
 */
export const civilizationPlugin = builtin(
  "jhin.civilization",
  {
    requires: {
      [MODES_CAPABILITY]: "^1",
      [UI_SLOTS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
    },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1", [MESH_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const modes = context.services.get<Modes>(MODES_CAPABILITY);
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      context.config.define(CIVILIZATION_SECTION, CivilizationConfig);
      // Every node of the mesh is asked, members of a connection too (M1, D1531).
      const targets = context.subscriptions.add(
        createMeshTargets(connections, context.services.tryGet<MeshMembership>(MESH_CAPABILITY)),
      );

      // --- Whether to offer the mode (D747) ----------------------------------
      /** Nodes (by `targetKey`) that have agents, as last asked while open. */
      const withAgents = new Map<string, boolean>();
      const asked = new Set<string>();
      /** Each connection's current opening: an answer from an earlier one is dropped. */
      const openings = new Map<string, number>();
      let opening = 0;
      /** Unknown answers per connection in this opening; after three it is taken as none. */
      const failures = new Map<string, number>();
      const MAX_FAILURES = 3;
      /**
       * Connections whose agents are asked for again when one arrives (D1398): the
       * `agents` stream of every open node that does not have agents yet. Dropped
       * once it does, when its connection closes and with the plugin.
       */
      const following = new Map<string, Disposable>();
      /** Asks in flight, and those an `agents` event came for meanwhile: asked once more. */
      const inFlight = new Set<string>();
      const stale = new Set<string>();
      const unfollow = (id: string) => {
        following.get(id)?.dispose();
        following.delete(id);
      };
      let registration: Disposable | undefined;
      // An answer that arrives after deactivation registers nothing.
      let disposed = false;
      const update = () => {
        if (disposed) return;
        const { enabled } = context.config.get<CivilizationConfig>(CIVILIZATION_SECTION);
        const open = targets.snapshot().map((node) => ({
          id: node.key,
          client: node.channel,
        }));
        // Ask each node once per time it opens: plugins may have changed while it was away.
        // An answer that came after its connection closed is forgotten as well.
        for (const id of new Set([
          ...asked,
          ...withAgents.keys(),
          ...failures.keys(),
          ...openings.keys(),
        ])) {
          if (!open.some((connection) => connection.id === id)) {
            unfollow(id);
            inFlight.delete(id);
            stale.delete(id);
            asked.delete(id);
            withAgents.delete(id);
            failures.delete(id);
            openings.delete(id);
          }
        }
        if (enabled !== "auto") for (const id of following.keys()) unfollow(id);
        if (enabled === "auto") {
          for (const connection of open) {
            if (asked.has(connection.id)) continue;
            asked.add(connection.id);
            if (!openings.has(connection.id)) openings.set(connection.id, ++opening);
            const asking = openings.get(connection.id);
            const id = connection.id;
            inFlight.add(id);
            void askAgents(connection.client)
              .then(({ answer, head }) => {
                // Closed (and maybe opened again) meanwhile: the answer is another opening's.
                if (disposed || openings.get(id) !== asking) return;
                inFlight.delete(id);
                // An agents event came while this was asked: the answer may be older.
                const newer = stale.delete(id);
                // Final for the opening: agents, or a token that may not read them (D747).
                if (answer === "some" || answer === "denied") unfollow(id);
                else if (!following.has(id)) {
                  // Followed from the catalog's head, so nothing between it and the
                  // subscription is missed and the backlog is not replayed; with no
                  // catalog (no agents plugin yet) from the start. What arrives is
                  // asked for at once (D1398).
                  following.set(
                    id,
                    connection.client.subscribe(AGENTS_STREAM, { after: head ?? 0 }, () => {
                      if (disposed || openings.get(id) !== asking) return;
                      if (inFlight.has(id)) {
                        stale.add(id);
                        return;
                      }
                      asked.delete(id);
                      failures.delete(id);
                      update();
                    }),
                  );
                }
                if (answer === "unknown") {
                  // Not known yet: asked again on the next change of the connections,
                  // at most three times per opening, or at once when an event came.
                  const count = (failures.get(id) ?? 0) + 1;
                  failures.set(id, count);
                  if (count < MAX_FAILURES || newer) asked.delete(id);
                  if (newer) update();
                  return;
                }
                withAgents.set(id, answer === "some");
                if (newer && (answer === "none" || answer === "missing")) asked.delete(id);
                update();
              })
              .catch((error: unknown) =>
                context.log.error("offering Civilization mode failed", { error: String(error) }),
              );
          }
        }
        const offered =
          enabled === "on" ||
          (enabled === "auto" && open.some((connection) => withAgents.get(connection.id) === true));
        if (offered && registration === undefined) {
          registration = modes.register({
            id: CIVILIZATION_MODE,
            title: "Civilization",
            description: "Long projects run by agent teams: steer through the lead and missions",
            order: 100,
            icon: LandmarkIcon,
            sidebarSlot: "civilization.sidebar",
            mainSlot: "civilization.main",
          });
        } else if (!offered && registration !== undefined) {
          registration.dispose();
          registration = undefined;
        }
      };
      // Every change of the connections asks again what is not known (D747),
      // and every change of the nodes shown, members included.
      context.subscriptions.add(connections.subscribe(update));
      context.subscriptions.add(targets.subscribe(update));
      context.subscriptions.add(
        context.config.onDidChange(CIVILIZATION_SECTION, () => {
          // A changed setting asks every open node afresh, given-up ones too.
          asked.clear();
          failures.clear();
          update();
        }),
      );
      context.subscriptions.add({
        dispose: () => {
          disposed = true;
          for (const id of following.keys()) unfollow(id);
          registration?.dispose();
        },
      });
      update();

      // --- The shell (D749, D750), loaded with the mode ------------------------
      const shell: CivilizationShell = {
        context,
        mode: CIVILIZATION_MODE,
        navigation,
        connections,
        keybindings,
      };
      const CivilizationSidebar = () => <Sidebar shell={shell} />;
      const SettingsButton = () => <Settings shell={shell} />;
      const PaletteButton = () => <Palette shell={shell} />;
      const CivilizationMain = () => <Main shell={shell} />;

      context.subscriptions.add(
        slots.contribute("civilization.sidebar", {
          id: "jhin.civilization.sidebar",
          component: CivilizationSidebar,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.sidebar.footer", {
          id: "jhin.civilization.settings",
          order: 0,
          component: SettingsButton,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.sidebar.footer", {
          id: "jhin.civilization.palette",
          order: 100,
          component: PaletteButton,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.main", {
          id: "jhin.civilization.main",
          component: CivilizationMain,
        }),
      );
    },
  }),
);
