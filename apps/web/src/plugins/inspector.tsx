import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Keybindings,
  type Navigation,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  Button,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_SLOTS_CAPABILITY,
  type SlotRegistry,
} from "@jhin/ui";
import { BugIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { builtin } from "../lib/builtin.ts";
import { useExternal } from "../lib/hooks.ts";

const PANEL = "inspector";

/** D36: the live state of a node (`host.inspect`) in a panel. */
export const inspectorPlugin = builtin(
  "jhin.inspector",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);

      const toggle = () => {
        const route = navigation.current();
        const { panel: _panel, ...rest } = route;
        navigation.navigate(route.panel === PANEL ? rest : { ...route, panel: PANEL });
      };

      function Toggle() {
        const route = useExternal(navigation, navigation.current);
        const open = route.panel === PANEL;
        return (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Inspector"
                  aria-pressed={open}
                  onClick={toggle}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <BugIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Inspector</TooltipPopup>
          </Tooltip>
        );
      }

      function Panel() {
        const route = useExternal(navigation, navigation.current);
        const nodes = useExternal(connections, connections.list);
        const node = nodes.find((candidate) => candidate.id === route.node) ?? nodes[0];
        const [state, setState] = useState<{ value?: unknown; error?: string }>({});
        const load = useCallback(() => {
          if (node === undefined) return;
          node.client
            .call("host.inspect")
            .then((value) => setState({ value }))
            .catch((error: unknown) => setState({ error: (error as Error).message }));
        }, [node]);
        useEffect(() => {
          if (route.panel === PANEL) load();
        }, [route.panel, load]);
        if (route.panel !== PANEL) return null;
        return (
          <section
            aria-label="Inspector"
            className="absolute inset-y-0 right-0 z-30 flex w-[32rem] max-w-full flex-col border-l border-border bg-background shadow-xl/10"
          >
            <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 wco:pr-(--workspace-native-controls-inset)">
              <span className="truncate text-sm font-medium">
                Inspector · {node?.label ?? "no node"}
              </span>
              <div className="flex gap-1">
                <Button aria-label="Refresh" onClick={load} size="icon-xs" variant="ghost">
                  <RefreshCwIcon />
                </Button>
                <Button
                  aria-label="Close inspector"
                  onClick={toggle}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </div>
            </header>
            <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs text-foreground/85">
              {state.error ?? JSON.stringify(state.value, null, 2)}
            </pre>
          </section>
        );
      }

      context.commands.register({
        name: "inspector.toggle",
        title: "Toggle inspector",
        description: "Shows or hides the node's live state",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          toggle();
          return {};
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([{ key: "mod+alt+i", command: "inspector.toggle" }]),
        );
      }
      context.subscriptions.add(
        slots.contribute("sidebar.actions", { id: "jhin.inspector.toggle", component: Toggle }),
      );
      context.subscriptions.add(
        slots.contribute("app.overlay", { id: "jhin.inspector.panel", component: Panel }),
      );
    },
  }),
);
