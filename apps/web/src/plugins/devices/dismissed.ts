// The device surfaces the user closed, by thread, kept on this device (preview.md D1427): T3's
// `dismissedDeviceSurfaceIds`, so an agent opening a device does not bring back what the user put
// away.

/** Where they are kept. */
export const DISMISSED_KEY = "jhin:device-dismissed:v1";
/** The threads whose dismissed devices are kept, the latest closed last (as the panel's places). */
export const MAX_DISMISSED_PLACES = 200;

export interface DismissedDevices {
  has(place: string, resource: string): boolean;
  /** The user closed these device surfaces of the thread. */
  dismiss(place: string, resources: readonly string[]): void;
  /** The user opened it again by hand: an agent may show it again. */
  forget(place: string, resource: string): void;
}

export function createDismissedDevices(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
): DismissedDevices {
  const byPlace = new Map<string, Set<string>>();
  try {
    const stored = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? "{}") as unknown;
    if (stored !== null && typeof stored === "object") {
      for (const [place, ids] of Object.entries(stored as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        byPlace.set(place, new Set(ids.filter((id): id is string => typeof id === "string")));
      }
    }
  } catch {
    // Unreadable or blocked storage: nothing dismissed yet.
  }
  const save = () => {
    for (const [place, ids] of byPlace) if (ids.size === 0) byPlace.delete(place);
    for (const place of [...byPlace.keys()].slice(0, -MAX_DISMISSED_PLACES)) byPlace.delete(place);
    try {
      storage?.setItem(
        DISMISSED_KEY,
        JSON.stringify(Object.fromEntries([...byPlace].map(([place, ids]) => [place, [...ids]]))),
      );
    } catch {
      // Blocked storage: dismissed for this page only.
    }
  };
  return {
    has: (place, resource) => byPlace.get(place)?.has(resource) === true,
    dismiss(place, resources) {
      if (resources.length === 0) return;
      const ids = byPlace.get(place) ?? new Set<string>();
      for (const resource of resources) ids.add(resource);
      // The thread closed in last goes last, so the oldest go first.
      byPlace.delete(place);
      byPlace.set(place, ids);
      save();
    },
    forget(place, resource) {
      if (byPlace.get(place)?.delete(resource) !== true) return;
      save();
    },
  };
}
