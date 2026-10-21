// The find in a thread (docs/plans/t3-parity.md, D801).
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import {
  findOccurrences,
  findRanges,
  formatCount,
  stepIndex,
  ThreadFindBar,
  useThreadFind,
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

  it("counts a run of white space as one space, as the browser shows it, but not in <pre>", () => {
    const container = render("<p>two   spaced\n\twords</p><pre>keep  this</pre>");
    const ranges = findRanges(container, "spaced words");
    expect(ranges.map((range) => range.toString())).toEqual(["spaced\n\twords"]);
    expect(findRanges(container, "two spaced")).toHaveLength(1);
    expect(findRanges(container, "keep this")).toHaveLength(0);
    expect(findRanges(container, "keep  this")).toHaveLength(1);
  });

  it("finds a match across three text nodes", () => {
    const container = render("<p>ab<em>cd</em><strong>ef</strong></p>");
    expect(findRanges(container, "bcde").map((range) => range.toString())).toEqual(["bcde"]);
  });

  it("never joins the text on either side of a skipped element", () => {
    const container = render('<p>foo<span aria-hidden="true">x</span>bar</p>');
    expect(findRanges(container, "foobar")).toHaveLength(0);
    expect(findRanges(container, "foo")).toHaveLength(1);
    expect(findRanges(container, "bar")).toHaveLength(1);
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

describe("useThreadFind", () => {
  /** A thread's log and its find bar, opened at once. */
  function Find(props: { threadKey: string; text: string }) {
    const log = useRef<HTMLDivElement>(null);
    const find = useThreadFind(log, props.threadKey);
    useEffect(() => find.open(), [find.open]);
    return (
      <div>
        <ThreadFindBar {...find.bar} />
        <div data-testid="log" ref={log}>
          <p>{props.text}</p>
        </div>
      </div>
    );
  }

  it("finds again as the thread's text changes, and starts closed in another thread", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    containers.push(host);
    const root = createRoot(host);
    await act(async () => root.render(<Find text="one apple" threadKey="a" />));
    await userEvent.fill(page.getByRole("searchbox", { name: "Find in thread" }), "apple");
    const count = page.getByRole("search").getByText(/^\d+\/\d+$/);
    await expect.element(count).toHaveTextContent("1/1");

    // Text streams in: the matches are found again.
    const log = host.querySelector("[data-testid=log]")!;
    await act(async () => {
      log.append(Object.assign(document.createElement("p"), { textContent: "apple pie" }));
    });
    await expect.element(count).toHaveTextContent("1/2");

    await act(async () => root.render(<Find text="one apple" threadKey="b" />));
    await expect
      .element(page.getByRole("searchbox", { name: "Find in thread" }))
      .not.toBeInTheDocument();
    await act(async () => root.unmount());
  });
});
