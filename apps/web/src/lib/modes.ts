import type { Mode, Modes, Navigation, Route } from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** Where each mode was last, by mode id; kept across reloads of the plugin (AGENTS.md rule 5). */
export interface ModePlaces {
  get(id: string): Route | undefined;
  set(id: string, route: Route): void;
}

const sortModes = (modes: readonly Mode[]) =>
  modes.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

/**
 * `client.modes@1` over the route (D742, D744): the active mode is the
 * route's `mode`, the default mode (the first) writes none, and every route
 * change is remembered as its mode's last place.
 */
export function createModes(navigation: Navigation, places: ModePlaces): Modes & Disposable {
  let modes: readonly Mode[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const resolve = (route: Route): Mode | undefined =>
    modes.find((mode) => mode.id === route.mode) ?? modes[0];

  let active = resolve(navigation.current());
  const remember = () => {
    const route = navigation.current();
    const mode = resolve(route);
    if (mode !== undefined) places.set(mode.id, route);
    if (mode !== active) {
      active = mode;
      notify();
    }
  };
  const following = navigation.subscribe(remember);

  return {
    register(mode) {
      if (modes.some((item) => item.id === mode.id)) {
        throw new Error(`A mode ${mode.id} is already registered`);
      }
      modes = sortModes([...modes, mode]);
      remember();
      notify();
      return toDisposable(() => {
        modes = modes.filter((item) => item !== mode);
        remember();
        notify();
      });
    },
    list: () => modes,
    current: () => active,
    open(id) {
      const mode = modes.find((item) => item.id === id);
      if (mode === undefined) throw new Error(`No mode ${id}`);
      const route = navigation.current();
      if (mode === resolve(route)) return;
      const fallback: Route = {
        ...(route.node === undefined ? {} : { node: route.node }),
        ...(route.remote === undefined ? {} : { remote: route.remote }),
      };
      const { mode: _mode, ...place } = places.get(id) ?? fallback;
      // The default mode is the route without one, as before modes existed.
      navigation.navigate(mode === modes[0] ? place : { ...place, mode: id });
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose: () => following.dispose(),
  };
}
