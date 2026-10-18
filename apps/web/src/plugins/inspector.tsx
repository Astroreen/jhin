import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { Button, UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";
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
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);

      function Toggle() {
        const route = useExternal(navigation, navigation.current);
        const open = route.panel === PANEL;
        return (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Inspector"
            aria-pressed={open}
            onClick={() => {
              const { panel: _panel, ...rest } = route;
              navigation.navigate(open ? rest : { ...route, panel: PANEL });
            }}
          >
            <BugIcon />
          </Button>
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
        const { panel: _panel, ...closed } = route;
        return (
          <section
            aria-label="Inspector"
            className="absolute inset-y-0 right-0 z-10 flex w-[32rem] max-w-full flex-col border-l bg-card shadow-lg"
          >
            <header className="flex h-12 items-center justify-between border-b px-4">
              <span className="font-medium">Inspector · {node?.label ?? "no node"}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={load}>
                  <RefreshCwIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close inspector"
                  onClick={() => navigation.navigate(closed)}
                >
                  <XIcon />
                </Button>
              </div>
            </header>
            <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs">
              {state.error ?? JSON.stringify(state.value, null, 2)}
            </pre>
          </section>
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
