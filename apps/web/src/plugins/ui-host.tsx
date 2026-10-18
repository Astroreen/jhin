import { definePlugin } from "@jhin/sdk";
import { Slot, SlotsProvider, UI_SLOTS_CAPABILITY, createSlotRegistry } from "@jhin/ui";
import { createRoot } from "react-dom/client";

import { builtin } from "../lib/builtin.ts";

/**
 * The UI host: owns the page and its top-level slots. Everything visible is a
 * contribution of some plugin:
 * - `app.sidebar`  the left column
 * - `app.main`     the main view
 * - `app.overlay`  panels over the main view
 */
export const uiHostPlugin = builtin(
  "jhin.ui-react",
  { provides: { [UI_SLOTS_CAPABILITY]: "1.0.0" } },
  definePlugin({
    activate(context) {
      const registry = createSlotRegistry({
        onError: (id, error) =>
          context.log.error("contribution failed to render", {
            contribution: id,
            error: String(error),
          }),
      });
      context.services.provide(UI_SLOTS_CAPABILITY, registry);

      const root = createRoot(document.getElementById("root")!);
      root.render(
        <SlotsProvider registry={registry}>
          <div className="flex h-full">
            <aside
              data-app-sidebar
              aria-label="Sidebar"
              className="flex w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
            >
              <Slot name="app.sidebar" />
            </aside>
            <main className="relative flex min-w-0 flex-1 flex-col">
              <Slot name="app.main" />
              <Slot name="app.overlay" />
            </main>
          </div>
        </SlotsProvider>,
      );
      context.subscriptions.add({ dispose: () => root.unmount() });
    },
  }),
);
