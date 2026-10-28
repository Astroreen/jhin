// T3's findTaskListMarkerOffset and setMarkdownTaskChecked (t3-parity.md D1648).
import { describe, expect, it } from "vite-plus/test";

import { findTaskListMarkerOffset, setMarkdownTaskChecked } from "../src/lib/markdown-tasks.ts";

describe("ticking a markdown task box", () => {
  const text = "# Plan\n\n- [ ] ship\n- [x] test\n  1. [ ] nested\n- plain [ ] item\n";

  it("finds the box of an item's first line from where the item starts", () => {
    const ship = text.indexOf("- [ ] ship");
    expect(findTaskListMarkerOffset(text, ship)).toBe(ship + 2);
    const nested = text.indexOf("  1. [ ] nested");
    expect(findTaskListMarkerOffset(text, nested)).toBe(nested + 5);
    // Brackets later in the line are not a box.
    expect(findTaskListMarkerOffset(text, text.indexOf("- plain"))).toBeNull();
  });

  it("swaps only the character between the brackets", () => {
    const ship = findTaskListMarkerOffset(text, text.indexOf("- [ ] ship"))!;
    expect(setMarkdownTaskChecked(text, ship, true)).toBe(text.replace("- [ ] ship", "- [x] ship"));
    const done = findTaskListMarkerOffset(text, text.indexOf("- [x] test"))!;
    expect(setMarkdownTaskChecked(text, done, false)).toBe(
      text.replace("- [x] test", "- [ ] test"),
    );
    expect(setMarkdownTaskChecked("- [X] a", 2, false)).toBe("- [ ] a");
  });

  it("leaves the text as it is where no box is", () => {
    expect(setMarkdownTaskChecked(text, 0, true)).toBe(text);
    expect(setMarkdownTaskChecked(text, -1, true)).toBe(text);
    expect(setMarkdownTaskChecked("- [y] a", 2, true)).toBe("- [y] a");
    expect(setMarkdownTaskChecked("- [ ", 2, true)).toBe("- [ ");
  });
});
