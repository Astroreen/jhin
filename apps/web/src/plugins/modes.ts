import {
  KEYBINDINGS_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_MODE,
  type Keybindings,
  type Navigation,
  type Route,
} from "@jhin/client-api";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import { MessagesSquareIcon } from "lucide-react";

import { builtin } from "../lib/builtin.ts";
import { createModes } from "../lib/modes.ts";

const PLACES_KEY = "places";

/**
 * `jhin.modes`: the client's modes (D741, D742). It registers Threads mode,
 * today's layout in `app.sidebar` and `app.main` (D743); other plugins add
 * theirs, Civilization mode among them. Switching is a command, so the
 * switcher, the palette and a shortcut all run the same thing.
 */
export const modesPlugin = builtin(
  "jhin.modes",
  {
    provides: { [MODES_CAPABILITY]: "1.0.0" },
    requires: { [NAVIGATION_CAPABILITY]: "^1" },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const places = context.state.get<Record<string, Route>>(PLACES_KEY) ?? {};
      context.state.set(PLACES_KEY, places);
      const modes = context.subscriptions.add(
        createModes(navigation, {
          get: (id) => places[id],
          set: (id, route) => {
            places[id] = route;
          },
        }),
      );
      context.services.provide(MODES_CAPABILITY, modes);
      context.subscriptions.add(
        modes.register({
          id: THREADS_MODE,
          title: "Threads",
          description: "Many projects, each with an agent you work alongside, turn by turn",
          order: 0,
          icon: MessagesSquareIcon,
          sidebarSlot: "app.sidebar",
          mainSlot: "app.main",
        }),
      );

      context.commands.register({
        name: "ui.mode.switch",
        title: "Switch mode",
        description: "Switches the client to a mode (Threads, Civilization, …), at its last place",
        input: z.object({ mode: z.string().min(1) }),
        output: z.object({ mode: z.string() }),
        handler: ({ mode }) => {
          modes.open(mode);
          return { mode };
        },
      });
      // Only while there is somewhere else to go, so a client with one mode
      // offers no switching anywhere (D746).
      let next: Disposable | undefined;
      const offerNext = () => {
        if (modes.list().length > 1 && next === undefined) {
          next = context.commands.register({
            name: "ui.mode.next",
            title: "Switch to the next mode",
            description: "Switches to the mode after the current one, at its last place",
            input: z.object({}),
            output: z.object({ mode: z.string() }),
            handler: () => {
              const list = modes.list();
              const index = list.indexOf(modes.current()!);
              const mode = list[(index + 1) % list.length]!;
              modes.open(mode.id);
              return { mode: mode.id };
            },
          });
        } else if (modes.list().length <= 1 && next !== undefined) {
          next.dispose();
          next = undefined;
        }
      };
      context.subscriptions.add(modes.subscribe(offerNext));
      context.subscriptions.add({ dispose: () => next?.dispose() });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+alt+m", command: "ui.mode.next", when: "!terminalFocus" },
          ]),
        );
      }
    },
  }),
);
