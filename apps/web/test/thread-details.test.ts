import { describe, expect, it } from "vite-plus/test";

import {
  createDetailsVisibility,
  inlineDetailsPlacement,
  laneInsetBesideCard,
} from "../src/plugins/chat/thread-details.tsx";

describe("the thread details card beside the chat (D1350)", () => {
  it("goes inline only where the chat keeps T3's 40rem lane beside it", () => {
    // 280 card + 12 gap + 32 clearance + 48 lane padding + 640 lane = 1012.
    expect(inlineDetailsPlacement(1012, 700, 0, 48)).toEqual({
      right: 12,
      top: 12,
      width: 280,
      height: 676,
    });
    expect(inlineDetailsPlacement(1011, 700, 0, 48)).toBeNull();
    // Below the find bar, and never shorter than 160px.
    expect(inlineDetailsPlacement(1200, 700, 52, 48)).toMatchObject({ top: 64, height: 624 });
    expect(inlineDetailsPlacement(1200, 183, 0, 48)).toBeNull();
    expect(inlineDetailsPlacement(1200, 184, 0, 48)).toMatchObject({ height: 160 });
  });

  it("moves the lane left of the card only as far as it must, as T3's canvas does", () => {
    // 1600 wide: the centred 736px lane ends at 1168, before the card's 1244 less 32.
    expect(laneInsetBesideCard(1600, 736, 48)).toBe(0);
    // 1024 wide: the lane ends at 700 (the card's 732 less 32), 652 wide, from 48.
    expect(laneInsetBesideCard(1024, 736, 48)).toBe(1024 - 48 * 2 - 652);
    // A lane as wide as the chat (the "full" chat width) ends 324px before the edge: 276 + 48.
    expect(laneInsetBesideCard(1300, Number.POSITIVE_INFINITY, 48)).toBe(276);
  });

  it("keeps each thread's visibility per presentation, as T3's store does", () => {
    const visibility = createDetailsVisibility();
    expect(visibility.presentation("a")).toBeUndefined();
    // The inline card is open until it is closed; the popover closed until it is opened.
    expect(visibility.open("a", "inline")).toBe(true);
    expect(visibility.open("a", "popover")).toBe(false);
    visibility.toggle("a");
    expect(visibility.open("a", "popover")).toBe(true);
    // Room for the card, but nothing in it yet: the toggle still works the popover.
    visibility.setPresentation("a", "inline");
    expect(visibility.effective("a")).toBe("popover");
    expect(visibility.shown("a")).toBe(false);
    // With a section the card shows, and the popover closes.
    visibility.setFilled("a", true);
    expect(visibility.effective("a")).toBe("inline");
    expect(visibility.open("a", "popover")).toBe(false);
    expect(visibility.shown("a")).toBe(true);
    visibility.toggle("a");
    expect(visibility.open("a", "inline")).toBe(false);
    expect(visibility.shown("a")).toBe(false);
    expect(visibility.open("b", "inline")).toBe(true);
    visibility.setPresentation("a", undefined);
    expect(visibility.presentation("a")).toBeUndefined();
    expect(visibility.effective("a")).toBe("popover");
  });

  it("closes the popover once the card shows, whichever the view reports first", () => {
    const visibility = createDetailsVisibility();
    visibility.toggle("c");
    expect(visibility.open("c", "popover")).toBe(true);
    // Its section before its room: still the popover until both are known.
    visibility.setFilled("c", true);
    expect(visibility.effective("c")).toBe("popover");
    expect(visibility.open("c", "popover")).toBe(true);
    visibility.setPresentation("c", "inline");
    expect(visibility.effective("c")).toBe("inline");
    expect(visibility.open("c", "popover")).toBe(false);
  });
});
