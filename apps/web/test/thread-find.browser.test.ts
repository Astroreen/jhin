// The find in a thread (docs/plans/t3-parity.md, D801).
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  findOccurrences,
  findRanges,
  formatCount,
  stepIndex,
} from "../src/plugins/chat/thread-find.tsx";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

function render(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  containers.push(container);
  return container;
}

describe("findOccurrences", () => {
  it("ignores case, keeps offsets and does not overlap", () => {
    expect(findOccurrences("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
    expect(findOccurrences("aaaa", "aa")).toEqual([0, 2]);
    expect(findOccurrences("ΟΔΟΣ οδος", "οδοσ")).toEqual([0, 5]);
    expect(findOccurrences("text", "")).toEqual([]);
  });
});

describe("findRanges", () => {
  it("finds matches across inline elements, in document order", () => {
    const container = render("<p>Hello <strong>wor</strong>ld</p><p>world again</p>");
    const ranges = findRanges(container, "world");
    expect(ranges.map((range) => range.toString())).toEqual(["world", "world"]);
    expect(ranges[0]!.startContainer.textContent).toBe("wor");
    expect(ranges[0]!.endContainer.textContent).toBe("ld");
  });

  it("never joins two blocks into one match", () => {
    const container = render("<p>end of one</p><p>two starts</p>");
    expect(findRanges(container, "onetwo")).toHaveLength(0);
    expect(findRanges(container, "one two")).toHaveLength(0);
  });

  it("passes over controls, icons and what is marked to be skipped", () => {
    const container = render(
      '<p>match</p><button>match</button><span aria-hidden="true">match</span>' +
        '<div data-thread-find-ignore>match</div><div role="toolbar">match</div>',
    );
    expect(findRanges(container, "match")).toHaveLength(1);
  });
});

describe("the count and stepping", () => {
  it("wraps around and says where it is, as T3 does", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(formatCount(0, 3)).toBe("1/3");
    expect(formatCount(5, 3)).toBe("3/3");
    expect(formatCount(0, 0)).toBe("0/0");
  });
});
