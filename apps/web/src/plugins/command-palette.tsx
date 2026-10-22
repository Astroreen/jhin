// The palette follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/CommandPalette.tsx,
// CommandPaletteContent.tsx, CommandPaletteResults.tsx and EnvironmentMachineIcon.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MACHINES_CAPABILITY,
  MESH_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type Keybindings,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import {
  CommandDialog,
  CommandDialogPopup,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
} from "@jhin/ui";

import { useEffect } from "react";

import { builtin } from "../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../lib/lazy-chunk.tsx";
import { useExternal } from "../lib/hooks.ts";

/** Whether the palette is open; the palette plugin owns it. */
function createOpenState() {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: () => open,
    set(next: boolean) {
      if (open === next) return;
      open = next;
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

export const commandPalettePlugin = builtin(
  "jhin.command-palette",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      [MACHINES_CAPABILITY]: "^1",
      [MODES_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const open = createOpenState();
      // The palette's body is a chunk of its own, loaded when it first opens (D440, D1041).
      const PaletteBody = lazyChunk(
        () =>
          import("./command-palette-body.tsx").then((module) =>
            module.createPaletteBody(context, () => open.set(false)),
          ),
        {
          loading: () => null,
          failed: (_props, retry) => (
            <ChunkFailed retry={retry}>Couldn't load the command palette.</ChunkFailed>
          ),
        },
      );

      function Palette() {
        const isOpen = useExternal(open, open.get);
        // Fetched after the first paint, so the first ⌘K rarely opens an empty palette.
        useEffect(() => void import("./command-palette-body.tsx").catch(() => undefined), []);
        return (
          <CommandDialog onOpenChange={(next) => open.set(next)} open={isOpen}>
            {isOpen ? (
              <CommandDialogPopup
                aria-label="Command palette"
                className="overflow-hidden"
                data-command-palette="true"
                onBackdropPointerDown={() => open.set(false)}
              >
                <PaletteBody />
              </CommandDialogPopup>
            ) : null}
          </CommandDialog>
        );
      }

      context.commands.register({
        name: "palette.toggle",
        title: "Command palette",
        description: "Opens or closes the command palette",
        input: z.object({}),
        output: z.object({ open: z.boolean() }),
        handler: () => {
          open.set(!open.get());
          return { open: open.get() };
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+k", command: "palette.toggle", when: "!terminalFocus" },
          ]),
        );
      }
      context.subscriptions.add(
        slots.contribute("app.global", { id: "jhin.command-palette", component: Palette }),
      );
    },
  }),
);
