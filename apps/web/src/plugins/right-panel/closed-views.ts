// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/closedViewStore.ts
// (the closed views kept, newest first, 20 at most, one per target; `defer` and `remove`) and
// apps/web/src/reopenClosedView.ts (`planNextReopen`: what is dropped, what reopens).
//
// What "Reopen Closed Tab" keeps (t3-parity.md D1641), apart from the plugin so it is tested alone.
import { rightPanelPlaceKey, type RightPanelPlace, type RightPanelSurface } from "@jhin/client-api";

export const CLOSED_VIEWS_KEY = "jhin:closed-views:v1";

/** T3's cap on the closed views kept. */
export const MAX_CLOSED_VIEWS = 20;

export interface ClosedView {
  readonly id: string;
  readonly place: RightPanelPlace;
  readonly surface: RightPanelSurface;
  /** What the surface's kind kept of it (a browser tab's page). */
  readonly kept?: string;
}

const sameTarget = (a: ClosedView, b: Omit<ClosedView, "id">) =>
  a.surface.id === b.surface.id && rightPanelPlaceKey(a.place) === rightPanelPlaceKey(b.place);

/** T3's `remember`: newest first, in place of an entry of the same surface. */
export function remember(
  entries: readonly ClosedView[],
  view: Omit<ClosedView, "id">,
  id: string,
): readonly ClosedView[] {
  return [{ ...view, id }, ...entries.filter((entry) => !sameTarget(entry, view))].slice(
    0,
    MAX_CLOSED_VIEWS,
  );
}

/** T3's `defer`: an entry that cannot reopen now goes last. */
export function defer(entries: readonly ClosedView[], id: string): readonly ClosedView[] {
  const entry = entries.find((candidate) => candidate.id === id);
  return entry === undefined
    ? entries
    : [...entries.filter((candidate) => candidate.id !== id), entry];
}

export type Owner = "gone" | "unknown" | "present";

/**
 * T3's `planNextReopen`: entries whose place is gone or whose surface is open already are
 * dropped; the first other one reopens. A place not known yet (its node's threads still
 * loading) is tried all the same: opening it shows whether it is there.
 */
export function planNextReopen(
  entries: readonly ClosedView[],
  owner: (entry: ClosedView) => Owner,
  isOpen: (entry: ClosedView) => boolean,
): { drop: readonly string[]; restore: ClosedView | undefined } {
  const drop: string[] = [];
  for (const entry of entries) {
    if (owner(entry) === "gone" || isOpen(entry)) {
      drop.push(entry.id);
      continue;
    }
    return { drop, restore: entry };
  }
  return { drop, restore: undefined };
}

export function readClosedViews(raw: string | null): readonly ClosedView[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClosedView[] = [];
  for (const value of parsed as unknown[]) {
    if (value === null || typeof value !== "object") continue;
    const { id, place, surface, kept } = value as Record<string, unknown>;
    if (typeof id !== "string" || place === null || typeof place !== "object") continue;
    if (surface === null || typeof surface !== "object") continue;
    const { target, threadId, projectId } = place as Record<string, unknown>;
    if (target === null || typeof target !== "object") continue;
    const { node, remote } = target as Record<string, unknown>;
    if (typeof node !== "string" || (remote !== undefined && typeof remote !== "string")) continue;
    if (threadId !== undefined && typeof threadId !== "string") continue;
    if (projectId !== undefined && typeof projectId !== "string") continue;
    if (threadId === undefined && projectId === undefined) continue;
    const { id: surfaceId, kind, resource } = surface as Record<string, unknown>;
    if (typeof surfaceId !== "string" || typeof kind !== "string" || kind === "") continue;
    if (resource !== undefined && typeof resource !== "string") continue;
    if (kept !== undefined && typeof kept !== "string") continue;
    out.push({
      id,
      place: {
        target: { node, ...(remote === undefined ? {} : { remote }) },
        ...(threadId === undefined ? {} : { threadId }),
        ...(projectId === undefined ? {} : { projectId }),
      },
      surface: { id: surfaceId, kind, ...(resource === undefined ? {} : { resource }) },
      ...(kept === undefined ? {} : { kept }),
    });
    if (out.length === MAX_CLOSED_VIEWS) break;
  }
  return out;
}

export const writeClosedViews = (entries: readonly ClosedView[]): string => JSON.stringify(entries);
