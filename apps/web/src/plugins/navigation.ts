import { NAVIGATION_CAPABILITY, type Navigation, type Route } from "@jhin/client-api";
import { definePlugin, toDisposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

/** The route lives in the fragment: `#n=<node>&t=<thread>&p=<panel>`. */
function read(): Route {
  const params = new URLSearchParams(location.hash.slice(1));
  const value = (key: string) => params.get(key) ?? undefined;
  const node = value("n");
  const thread = value("t");
  const panel = value("p");
  return {
    ...(node === undefined ? {} : { node }),
    ...(thread === undefined ? {} : { thread }),
    ...(panel === undefined ? {} : { panel }),
  };
}

function write(route: Route): string {
  const params = new URLSearchParams();
  if (route.node !== undefined) params.set("n", route.node);
  if (route.thread !== undefined) params.set("t", route.thread);
  if (route.panel !== undefined) params.set("p", route.panel);
  return params.toString();
}

export const navigationPlugin = builtin(
  "jhin.navigation",
  { provides: { [NAVIGATION_CAPABILITY]: "1.0.0" } },
  definePlugin({
    activate(context) {
      const listeners = new Set<() => void>();
      let route = read();
      const changed = () => {
        route = read();
        for (const listener of Array.from(listeners)) listener();
      };
      window.addEventListener("hashchange", changed);
      context.subscriptions.add({
        dispose: () => window.removeEventListener("hashchange", changed),
      });

      const navigation: Navigation = {
        current: () => route,
        navigate(next) {
          const hash = write(next);
          history.pushState(
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
    },
  }),
);
