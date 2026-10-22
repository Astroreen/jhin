import type { Mode, Modes, Navigation, Route } from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** Where each mode was last, by mode id; kept across reloads of the plugin (AGENTS.md rule 5). */
export interface ModePlaces {
  get(id: string): Route | undefined;
  set(id: string, route: Route): void;
}

/** Civilization mode's id (agents.md D741, `jhin.civilization`): routes into it name it. */
export const CIVILIZATION_MODE = "civilization";

/**
 * Panels of the route that are the whole app's, in every mode (D748): never a
 * mode's remembered place, so switching back returns to the mode's own page.
 */
export const APP_PANELS: ReadonlySet<string> = new Set(["settings", "connect"]);

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
  /** Takes the route's mode as the active one, telling subscribers once if it changed. */
  const follow = () => {
    const mode = resolve(navigation.current());
    if (mode === active) return false;
    active = mode;
    notify();
    return true;
  };
  /** Keeps the route as the place of the mode it names, never a fallback's or an app page (D744, D748). */
  const keepPlace = () => {
    const route = navigation.current();
    const named = modes.find((mode) => mode.id === route.mode);
    const place = named ?? (route.mode === undefined ? modes[0] : undefined);
    if (place !== undefined && (route.panel === undefined || !APP_PANELS.has(route.panel))) {
      places.set(place.id, route);
    }
  };
  const remember = () => {
    keepPlace();
    follow();
  };
  /**
   * The route that opens `mode` from `route`: its last place on the same node,
   * else the node alone; the default mode's route names no mode.
   */
  const placeOf = (mode: Mode, route: Route): Route => {
    const here: Route = {
      ...(route.node === undefined ? {} : { node: route.node }),
      ...(route.remote === undefined ? {} : { remote: route.remote }),
    };
    const kept = places.get(mode.id);
    // A place on another node is not this one's: the mode opens at the node alone.
    const sameNode = kept !== undefined && kept.node === route.node && kept.remote === route.remote;
    const { mode: _mode, ...place } = sameNode ? kept : here;
    // The default mode is the route without one, as before modes existed.
    return mode === modes[0] ? place : { ...place, mode: mode.id };
  };
  const following = navigation.subscribe(remember);

  return {
    register(mode) {
      if (modes.some((item) => item.id === mode.id)) {
        throw new Error(`A mode ${mode.id} is already registered`);
      }
      modes = sortModes([...modes, mode]);
      keepPlace();
      // The list changed either way: one notification for both.
      if (!follow()) notify();
      return toDisposable(() => {
        modes = modes.filter((item) => item !== mode);
        const route = navigation.current();
        const before = active;
        if (route.mode === mode.id) {
          // Gone while shown: the default mode takes over the route, so the mode
          // coming back later (a reconnect, a config change) does not take the page.
          // The default mode's own place: the rest of the route was the gone mode's.
          const fallback = modes[0];
          navigation.navigate(fallback === undefined ? {} : placeOf(fallback, route));
        }
        // Following the route above told subscribers already when the mode changed.
        if (active === before && !follow()) notify();
      });
    },
    list: () => modes,
    current: () => active,
    open(id) {
      const mode = modes.find((item) => item.id === id);
      if (mode === undefined) throw new Error(`No mode ${id}`);
      // Where the page is now, even if it opened there and never moved.
      keepPlace();
      const route = navigation.current();
      const onAppPage = route.panel !== undefined && APP_PANELS.has(route.panel);
      // The active mode's button leaves an app page for the mode's own place (D748).
      if (mode === resolve(route) && !onAppPage) {
        // A route naming a mode that is gone shows the default: drop the stale name.
        if (mode === modes[0] && route.mode !== undefined) {
          const { mode: _stale, ...rest } = route;
          navigation.navigate(rest);
        }
        return;
      }
      navigation.navigate(placeOf(mode, route));
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose: () => following.dispose(),
  };
}
