// Dragging threads between and within the sidebar's sections follows T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/Sidebar.logic.ts (resolveSidebarDropTarget,
// resolveSidebarDropVerb, planSidebarThreadDrop) and Sidebar.drag.ts
// (createSidebarCollisionDetection).
import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import type { ThreadSection } from "@jhin/client-api";

import { planReorder, type OrderAssignment } from "./thread-order.ts";

/**
 * The sections a dragged thread can land in. Snoozed rows can leave their
 * shelf, but nothing drops into it: snoozing needs a wake time.
 */
export type DropSection = "pinned" | "active" | "settled";

export type SidebarListMarker =
  | "pinned-header"
  | "pinned-divider"
  | "active-placeholder"
  | "working-header"
  | "snoozed-header"
  | "settled-header"
  | "settled-placeholder";

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: ThreadSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

const MARKER_PREFIX = "sidebar-marker-";
export const markerId = (marker: SidebarListMarker) => `${MARKER_PREFIX}${marker}`;
export const itemId = (item: SidebarListItem) =>
  item.kind === "thread" ? item.key : markerId(item.marker);

/** The rows of the list as dragging sees them: threads between the markers of their sections. */
export function sidebarListItems(sections: {
  readonly pinned: readonly string[];
  readonly active: readonly string[];
  /** Shown rows only, as for the shelves; `undefined` while the section has none. */
  readonly working?: readonly string[] | undefined;
  /** Shown rows only: a collapsed shelf has none, or the open thread. */
  readonly snoozed: readonly string[] | undefined;
  readonly settled: readonly string[];
}): SidebarListItem[] {
  const rows = (keys: readonly string[], section: ThreadSection): SidebarListItem[] =>
    keys.map((key) => ({ kind: "thread", key, section }));
  const items: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    ...rows(sections.pinned, "pinned"),
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "active-placeholder" },
    ...rows(sections.active, "active"),
  ];
  if (sections.working !== undefined) {
    items.push({ kind: "marker", marker: "working-header" }, ...rows(sections.working, "working"));
  }
  if (sections.snoozed !== undefined) {
    items.push({ kind: "marker", marker: "snoozed-header" }, ...rows(sections.snoozed, "snoozed"));
  }
  items.push(
    { kind: "marker", marker: "settled-header" },
    { kind: "marker", marker: "settled-placeholder" },
    ...rows(sections.settled, "settled"),
  );
  return items;
}

function sectionAt(items: readonly SidebarListItem[], index: number): ThreadSection {
  let section: ThreadSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

export interface DropTarget {
  readonly section: DropSection;
  /** The pinned and the active threads in the order the drop leaves them. */
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
}

/** Where a row dropped over another row or marker lands; null over the Snoozed shelf. */
export function resolveDropTarget(
  items: readonly SidebarListItem[],
  activeId: string,
  overId: string,
): DropTarget | null {
  const from = items.findIndex((item) => itemId(item) === activeId);
  const over = items.findIndex((item) => itemId(item) === overId);
  if (from === -1 || over === -1 || items[from]?.kind !== "thread") return null;
  const moved = items.filter((_, index) => index !== from);
  moved.splice(over, 0, items[from]);
  const section = sectionAt(moved, over);
  // Nothing drops into the Working section (T3): only a running turn puts a thread there.
  if (section === "snoozed" || section === "working") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let current: ThreadSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") current = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
    } else if (current === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

export type DropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

/** What a drop does to the thread, as the dragged row's badge says it. */
export function dropVerb(from: ThreadSection, to: DropSection | null): DropVerb | null {
  if (to === null || to === from) return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export type DropPlan =
  | { readonly kind: "none" }
  | { readonly kind: "reorder-pinned"; readonly assignments: readonly OrderAssignment[] }
  | {
      readonly kind: "pin";
      readonly orderKey: string | undefined;
      /** Keys other pinned threads need for the moved one to fit. */
      readonly assignments: readonly OrderAssignment[];
    }
  | {
      readonly kind: "move-active";
      readonly assignments: readonly OrderAssignment[];
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

/**
 * What to tell the nodes for a drop (T3's planSidebarThreadDrop): pin, unpin,
 * settle, un-settle or wake the thread, and the order keys that put it, and
 * if need be its new neighbours, where it was dropped. `*KeysById` hold every
 * thread's key, shown or not: hidden ones keep theirs and are kept clear of.
 */
export function planDrop(input: {
  readonly key: string;
  readonly from: ThreadSection;
  readonly target: DropTarget;
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | undefined>;
  readonly activeKeysById: ReadonlyMap<string, string | undefined>;
}): DropPlan {
  const { key, from, target } = input;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((item, index) => item === b[index]);
  switch (target.section) {
    case "settled":
      return from === "settled" ? { kind: "none" } : { kind: "settle" };
    case "active": {
      if (from === "active" && same(target.activeOrder, input.activeOrder)) return { kind: "none" };
      return {
        kind: "move-active",
        assignments: planReorder({
          orderedIds: target.activeOrder,
          keysById: input.activeKeysById,
          movedId: key,
        }),
        unpin: from === "pinned",
        unsettle: from === "settled",
        unsnooze: from === "snoozed",
      };
    }
    case "pinned": {
      if (from === "pinned" && same(target.pinnedOrder, input.pinnedOrder)) return { kind: "none" };
      const assignments = planReorder({
        orderedIds: target.pinnedOrder,
        keysById: input.pinnedKeysById,
        movedId: key,
      });
      if (from === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", assignments };
      }
      return {
        kind: "pin",
        orderKey: assignments.find((assignment) => assignment.id === key)?.orderKey,
        assignments: assignments.filter((assignment) => assignment.id !== key),
      };
    }
  }
}

/** The class of the pinned divider's label, which the collision detection measures. */
export const DRAG_BOUNDARY_LABEL_CLASS = "sidebar-drag-boundary-label";

/**
 * dnd-kit's closest centre, made sticky around the pinned boundary (T3's
 * createSidebarCollisionDetection): over the divider's label, the side the
 * row is on changes only when the pointer moves across the label, up into
 * the pinned threads or down into the active ones, so opening the
 * destination (which moves the divider) never flips a still pointer back.
 * A nearest target where a drop would do nothing (`isValidTarget`) leaves
 * the row where it is.
 */
export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: { items?: readonly SidebarListItem[]; activationY?: number | null } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, DropSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === markerId("pinned-divider"))
      ?.node.current?.querySelector(`.${DRAG_BOUNDARY_LABEL_CLASS}`)
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // The visible divider row, sortable translation included. Only pointer
      // movement changes sections: opening the destination moves this row.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (["working-header", "snoozed-header", "settled-header"] as const)
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === markerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) return collisions;
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}
