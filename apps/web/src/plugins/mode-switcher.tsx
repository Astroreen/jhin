import {
  KEYBINDINGS_CAPABILITY,
  MODES_CAPABILITY,
  type Keybindings,
  type Modes,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";

import { builtin } from "../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../lib/lazy-chunk.tsx";
import { useModes } from "../lib/use-modes.ts";

// Loaded once there is a second mode (D440).
const Buttons = lazyChunk(() => import("./mode-buttons.tsx").then((module) => module.ModeButtons), {
  loading: () => null,
  failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load the modes.</ChunkFailed>,
});

/**
 * `jhin.mode-switcher`: the mode switcher (D746), one button per mode, as the
 * contribution `jhin.modes.switcher` to `app.sidebar.modes` at the foot of
 * the left column. It shows nothing while there is a single mode, so a client
 * without other modes looks as it did before modes; `jhin.ui` rules can hide
 * or move it like any contribution.
 */
export const modeSwitcherPlugin = builtin(
  "jhin.mode-switcher",
  {
    requires: { [MODES_CAPABILITY]: "^1.1", [UI_SLOTS_CAPABILITY]: "^1" },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const modes = context.services.get<Modes>(MODES_CAPABILITY);
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);

      function ModeSwitcher() {
        const { list, current, badges } = useModes(modes);
        if (list.length < 2) return null;
        return (
          <Buttons
            badges={badges}
            context={context}
            current={current}
            keybindings={keybindings}
            list={list}
          />
        );
      }

      context.subscriptions.add(
        slots.contribute("app.sidebar.modes", {
          id: "jhin.modes.switcher",
          component: ModeSwitcher,
        }),
      );
    },
  }),
);
