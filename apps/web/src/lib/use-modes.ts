import type { Mode, Modes } from "@jhin/client-api";
import {
  createElement,
  useCallback,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

const noModes: {
  list: readonly Mode[];
  current: Mode | undefined;
  badges: ReadonlyMap<string, number>;
} = {
  list: [],
  current: undefined,
  badges: new Map(),
};

/** The modes and the active one, as one subscription; none without `client.modes@1`. */
export function useModes(modes: Modes | undefined) {
  const snapshot = useRef(noModes);
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = modes?.subscribe(listener);
      return () => subscription?.dispose();
    },
    [modes],
  );
  return useSyncExternalStore(subscribe, () => {
    const list = modes?.list() ?? noModes.list;
    const current = modes?.current();
    const badges = modes?.badges() ?? noModes.badges;
    // The same object while nothing changed, or React would render forever.
    if (
      snapshot.current.list !== list ||
      snapshot.current.current !== current ||
      snapshot.current.badges !== badges
    ) {
      snapshot.current = { list, current, badges };
    }
    return snapshot.current;
  });
}

/**
 * A mode's icon, or `fallback` when it has none. `client-api` stays free of
 * React, so `Mode.icon` is typed loosely and checked here once.
 */
export function ModeIcon({
  mode,
  className,
  fallback = null,
}: {
  mode: Mode;
  className?: string;
  fallback?: ReactNode;
}): ReactNode {
  if (typeof mode.icon !== "function") return fallback;
  return createElement(
    mode.icon as ComponentType<{ className?: string }>,
    className === undefined ? {} : { className },
  );
}
