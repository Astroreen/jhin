import {
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Keybindings,
  type Navigation,
  type Route,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

/** Fragment keys of each route field. */
const KEYS = {
  node: "n",
  remote: "r",
  thread: "t",
  project: "j",
  panel: "p",
  section: "s",
  anchor: "a",
  mode: "m",
} as const satisfies Record<keyof Route, string>;

/** The route lives in the fragment: `#n=<node>&r=<remote>&t=<thread>&j=<project>&p=<panel>&s=<section>&a=<anchor>&m=<mode>`. */
export function readRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const route: Record<string, string> = {};
  for (const [field, key] of Object.entries(KEYS)) {
    const value = params.get(key);
    if (value !== null) route[field] = value;
  }
  return route as Route;
}

export function writeRoute(route: Route): string {
  const params = new URLSearchParams();
  for (const [field, key] of Object.entries(KEYS)) {
    const value = route[field as keyof Route];
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

export const navigationPlugin = builtin(
  "jhin.navigation",
  {
    // 1.1: `navigate(route, {replace})` (t3-parity.md D1421); 1.2: `Route.anchor` (config-ui.md D1628).
    provides: { [NAVIGATION_CAPABILITY]: "1.2.0" },
    optional: { [KEYBINDINGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const listeners = new Set<() => void>();
      let route = readRoute(location.hash);
      const changed = () => {
        route = readRoute(location.hash);
        for (const listener of Array.from(listeners)) listener();
      };
      window.addEventListener("hashchange", changed);
      window.addEventListener("popstate", changed);
      context.subscriptions.add({
        dispose: () => {
          window.removeEventListener("hashchange", changed);
          window.removeEventListener("popstate", changed);
        },
      });

      const navigation: Navigation = {
        current: () => route,
        navigate(next, options) {
          const hash = writeRoute(next);
          if (hash === writeRoute(route)) return;
          history[options?.replace === true ? "replaceState" : "pushState"](
            null,
            "",
            `${location.pathname}${location.search}${hash === "" ? "" : `#${hash}`}`,
          );
          changed();
        },
        subscribe(listener) {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      };
      context.services.provide(NAVIGATION_CAPABILITY, navigation);

      context.commands.register({
        name: "navigation.back",
        title: "Go back",
        description: "Goes back to the previous view",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          history.back();
          return {};
        },
      });
      context.commands.register({
        name: "navigation.forward",
        title: "Go forward",
        description: "Goes forward again after going back",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          history.forward();
          return {};
        },
      });
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+[", command: "navigation.back", when: "!terminalFocus && !editableFocus" },
            {
              key: "mod+]",
              command: "navigation.forward",
              when: "!terminalFocus && !editableFocus",
            },
          ]),
        );
      }
    },
  }),
);
