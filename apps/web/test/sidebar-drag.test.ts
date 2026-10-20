import { describe, expect, it } from "vite-plus/test";

import {
  dropVerb,
  markerId,
  planDrop,
  resolveDropTarget,
  sidebarListItems,
  createSidebarCollisionDetection,
  DRAG_BOUNDARY_LABEL_CLASS,
} from "../src/lib/sidebar-drag.ts";

const items = sidebarListItems({
  pinned: ["p1", "p2"],
  active: ["a1", "a2"],
  snoozed: ["z1"],
  settled: ["s1"],
});

describe("where a dragged thread lands (D78)", () => {
  it("reorders within a section and moves between them as an array move does", () => {
    expect(resolveDropTarget(items, "p2", "p1")).toEqual({
      section: "pinned",
      pinnedOrder: ["p2", "p1"],
      activeOrder: ["a1", "a2"],
    });
    // Dropped on the first active row: it is pinned no more.
    expect(resolveDropTarget(items, "p1", "a1")).toMatchObject({
      section: "active",
      pinnedOrder: ["p2"],
      activeOrder: ["a1", "p1", "a2"],
    });
    expect(resolveDropTarget(items, "a2", "p1")).toMatchObject({
      section: "pinned",
      pinnedOrder: ["a2", "p1", "p2"],
    });
    expect(resolveDropTarget(items, "a1", markerId("settled-header"))?.section).toBe("settled");
    expect(resolveDropTarget(items, "s1", "a2")?.section).toBe("active");
  });

  it("drops nothing into the Snoozed shelf: snoozing needs a time", () => {
    expect(resolveDropTarget(items, "a1", "z1")).toBeNull();
  });

  it("names what a drop does", () => {
    expect(dropVerb("active", "pinned")).toBe("pin");
    expect(dropVerb("pinned", "active")).toBe("unpin");
    expect(dropVerb("settled", "active")).toBe("unsettle");
    expect(dropVerb("snoozed", "active")).toBe("wake");
    expect(dropVerb("active", "settled")).toBe("settle");
    expect(dropVerb("active", "active")).toBeNull();
    expect(dropVerb("active", null)).toBeNull();
  });
});

describe("what a drop tells the nodes (D78)", () => {
  const keys = new Map<string, string | undefined>([
    ["p1", "c"],
    ["p2", "n"],
  ]);
  const base = {
    pinnedOrder: ["p1", "p2"],
    activeOrder: ["a1", "a2"],
    pinnedKeysById: keys,
    activeKeysById: new Map<string, string | undefined>(),
  };

  it("pins at a key between the pinned neighbours", () => {
    const plan = planDrop({
      ...base,
      key: "a1",
      from: "active",
      target: { section: "pinned", pinnedOrder: ["p1", "a1", "p2"], activeOrder: ["a2"] },
    });
    expect(plan).toMatchObject({ kind: "pin", assignments: [] });
    const orderKey = (plan as { orderKey: string }).orderKey;
    expect(orderKey > "c" && orderKey < "n").toBe(true);
  });

  it("reorders the pinned threads, and does nothing for a drop where it was", () => {
    expect(
      planDrop({
        ...base,
        key: "p2",
        from: "pinned",
        target: { section: "pinned", pinnedOrder: ["p2", "p1"], activeOrder: ["a1", "a2"] },
      }),
    ).toMatchObject({ kind: "reorder-pinned", assignments: [{ id: "p2" }] });
    expect(
      planDrop({
        ...base,
        key: "p1",
        from: "pinned",
        target: { section: "pinned", pinnedOrder: ["p1", "p2"], activeOrder: ["a1", "a2"] },
      }),
    ).toEqual({ kind: "none" });
  });

  it("un-settles, unpins or wakes a thread dropped among the active ones, and gives the list keys", () => {
    const plan = planDrop({
      ...base,
      key: "s1",
      from: "settled",
      target: { section: "active", pinnedOrder: ["p1", "p2"], activeOrder: ["a1", "s1", "a2"] },
    });
    expect(plan).toMatchObject({
      kind: "move-active",
      unsettle: true,
      unpin: false,
      unsnooze: false,
    });
    // The active threads had no keys: the three get some, in their new order.
    expect(
      (plan as unknown as { assignments: { id: string }[] }).assignments.map((item) => item.id),
    ).toEqual(["a1", "s1", "a2"]);
  });

  it("settles a thread dropped on the shelf", () => {
    expect(
      planDrop({
        ...base,
        key: "a1",
        from: "active",
        target: { section: "settled", pinnedOrder: ["p1", "p2"], activeOrder: ["a2"] },
      }),
    ).toEqual({ kind: "settle" });
  });
});

describe("collision detection around the pinned boundary (D448)", () => {
  // p1 pinned, then the divider (its label at y 40–56), then the active a1 and a2.
  const items = sidebarListItems({
    pinned: ["p1"],
    active: ["a1", "a2"],
    snoozed: undefined,
    settled: [],
  });
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 200,
    width: 200,
    height,
  });
  const rects = new Map<string, ReturnType<typeof rect>>([
    ["p1", rect(0, 40)],
    [markerId("pinned-divider"), rect(40, 0)],
    ["a1", rect(56, 40)],
    ["a2", rect(96, 40)],
    [markerId("settled-header"), rect(300, 32)],
  ]);
  const label = rect(44, 16);
  const containers = [...rects.keys()].map((id) => ({
    id,
    key: id,
    data: { current: undefined },
    disabled: false,
    rect: { current: null },
    node: {
      current: {
        getBoundingClientRect: () => rects.get(id),
        querySelector: (selector: string) =>
          id === markerId("pinned-divider") && selector === `.${DRAG_BOUNDARY_LABEL_CLASS}`
            ? { getBoundingClientRect: () => label }
            : null,
      },
    },
  }));
  /** The collisions for the dragged row centred at `y`, with the pointer there. */
  const at = (detect: ReturnType<typeof createSidebarCollisionDetection>, y: number) =>
    detect({
      active: { id: "a2" },
      collisionRect: { ...rect(y - 20, 40) },
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: 100, y },
    } as unknown as Parameters<typeof detect>[0]).map((collision) => String(collision.id));

  it("keeps the nearest target of the side the pointer last crossed to", () => {
    const detect = createSidebarCollisionDetection(() => true, { items, activationY: 116 });
    const side = (y: number) => resolveDropTarget(items, "a2", at(detect, y)[0]!)?.section;
    // Below the label: the active side, where the row started.
    expect(at(detect, 70)[0]).toBe("a1");
    // Moving up onto the label: the pinned side, though a1's centre is the nearest (closest
    // centre alone would keep the row among the active ones).
    expect(side(59)).toBe("pinned");
    // A still pointer stays on that side even as the rows move under it.
    expect(side(59)).toBe("pinned");
    // Moving down across the label again: the active side.
    expect(side(62)).toBe("active");
  });

  it("leaves the row in place when the nearest drop would do nothing", () => {
    const detect = createSidebarCollisionDetection((id) => id !== "a1", { items });
    expect(at(detect, 76)).toEqual(["a2"]);
  });
});
