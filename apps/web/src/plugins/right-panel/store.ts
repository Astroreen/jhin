// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/rightPanelStore.ts
// (a thread's surfaces, the active one, closing with its fallback, moving, reconciling a kind's
// surfaces, what its persisted state may hold).
//
// A place's right panel as data (t3-parity.md D1421), apart from the plugin so it is tested alone.
import {
  rightPanelSurfaceId,
  type RightPanelState,
  type RightPanelSurface,
} from "@jhin/client-api";

export const EMPTY_STATE: RightPanelState = Object.freeze({
  surfaces: Object.freeze([]) as readonly RightPanelSurface[],
  activeId: null,
  open: false,
  maximized: false,
});

export function surfaceOf(kind: string, resource?: string): RightPanelSurface {
  return {
    id: rightPanelSurfaceId(kind, resource),
    kind,
    ...(resource === undefined ? {} : { resource }),
  };
}

/** T3's `upsertSurface`: the panel opens on it, added at the end when new. */
export function upsert(
  state: RightPanelState,
  surface: RightPanelSurface,
  activate = true,
): RightPanelState {
  const known = state.surfaces.some((entry) => entry.id === surface.id);
  return {
    ...state,
    open: true,
    surfaces: known ? state.surfaces : [...state.surfaces, surface],
    activeId: activate ? surface.id : state.activeId,
  };
}

/** T3's `closeSurface`: the one now in its place shows, else the last; none closes the panel. */
export function closeSurface(state: RightPanelState, id: string): RightPanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index < 0) return state;
  const surfaces = state.surfaces.filter((surface) => surface.id !== id);
  const next = { ...state, surfaces, open: surfaces.length > 0 && state.open };
  if (state.activeId !== id) return next;
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
  return { ...next, activeId: fallback?.id ?? null };
}

/** T3's `closeOtherSurfaces`. */
export function closeOthers(state: RightPanelState, id: string): RightPanelState {
  const surface = state.surfaces.find((entry) => entry.id === id);
  if (surface === undefined || state.surfaces.length === 1) return state;
  return { ...state, open: true, surfaces: [surface], activeId: surface.id };
}

/** T3's `closeSurfacesToRight`. */
export function closeToRight(state: RightPanelState, id: string): RightPanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index < 0 || index === state.surfaces.length - 1) return state;
  const surfaces = state.surfaces.slice(0, index + 1);
  const activeKept = surfaces.some((surface) => surface.id === state.activeId);
  return { ...state, surfaces, activeId: activeKept ? state.activeId : id };
}

/** T3's `closeAllSurfaces`. */
export function closeAll(state: RightPanelState): RightPanelState {
  if (state.surfaces.length === 0) return state;
  return { ...state, open: false, surfaces: [], activeId: null };
}

/** T3's `moveSurface`. */
export function move(state: RightPanelState, id: string, toIndex: number): RightPanelState {
  const fromIndex = state.surfaces.findIndex((surface) => surface.id === id);
  if (fromIndex < 0 || fromIndex === toIndex) return state;
  const surfaces = [...state.surfaces];
  surfaces.splice(toIndex, 0, ...surfaces.splice(fromIndex, 1));
  return { ...state, surfaces };
}

/**
 * T3's `reconcileBrowserSurfaces` for any kind: its surfaces become `resources`, new ones at
 * the end, others kept in place. An active surface that went falls back to the kind's first,
 * else the first of all.
 */
export function reconcile(
  state: RightPanelState,
  kind: string,
  resources: readonly string[],
): RightPanelState {
  const valid = new Set(resources);
  const kept = state.surfaces.filter(
    (surface) =>
      surface.kind !== kind || (surface.resource !== undefined && valid.has(surface.resource)),
  );
  const known = new Set(kept.map((surface) => surface.id));
  const added = resources
    .filter((resource) => !known.has(rightPanelSurfaceId(kind, resource)))
    .map((resource) => surfaceOf(kind, resource));
  if (added.length === 0 && kept.length === state.surfaces.length) return state;
  const surfaces = [...kept, ...added];
  const activeKept = surfaces.some((surface) => surface.id === state.activeId);
  const fallback = surfaces.find((surface) => surface.kind === kind) ?? surfaces[0];
  return {
    ...state,
    surfaces,
    activeId: activeKept || state.activeId === null ? state.activeId : (fallback?.id ?? null),
  };
}

/** Whether `state` is the empty state, so its place need not be kept. */
export function isEmpty(state: RightPanelState): boolean {
  return state.surfaces.length === 0 && !state.open && state.activeId === null;
}

/** What `jhin:right-panel:v1` keeps of each place. */
interface Stored {
  readonly surfaces: readonly { kind: string; resource?: string }[];
  readonly activeId?: string | null;
  readonly open?: true;
  readonly maximized?: true;
}

export const STORAGE_KEY = "jhin:right-panel:v1";

/** The places kept on this device; anything malformed is left out. */
export function readStored(raw: string | null): Map<string, RightPanelState> {
  const places = new Map<string, RightPanelState>();
  if (raw === null) return places;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return places;
  }
  if (parsed === null || typeof parsed !== "object") return places;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const stored = value as Partial<Stored>;
    if (!Array.isArray(stored.surfaces)) continue;
    const surfaces: RightPanelSurface[] = [];
    const seen = new Set<string>();
    for (const entry of stored.surfaces as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const { kind, resource } = entry as { kind?: unknown; resource?: unknown };
      if (typeof kind !== "string" || kind === "") continue;
      if (resource !== undefined && typeof resource !== "string") continue;
      const surface = surfaceOf(kind, resource);
      if (seen.has(surface.id)) continue;
      seen.add(surface.id);
      surfaces.push(surface);
    }
    const activeId =
      typeof stored.activeId === "string" && seen.has(stored.activeId) ? stored.activeId : null;
    const state: RightPanelState = {
      surfaces,
      activeId,
      open: stored.open === true,
      maximized: stored.maximized === true,
    };
    if (!isEmpty(state)) places.set(key, state);
  }
  return places;
}

export function writeStored(places: ReadonlyMap<string, RightPanelState>): string {
  const out: Record<string, Stored> = {};
  for (const [key, state] of places) {
    if (isEmpty(state)) continue;
    out[key] = {
      surfaces: state.surfaces.map((surface) =>
        surface.resource === undefined
          ? { kind: surface.kind }
          : { kind: surface.kind, resource: surface.resource },
      ),
      ...(state.activeId === null ? {} : { activeId: state.activeId }),
      ...(state.open ? { open: true as const } : {}),
      ...(state.maximized ? { maximized: true as const } : {}),
    };
  }
  return JSON.stringify(out);
}
