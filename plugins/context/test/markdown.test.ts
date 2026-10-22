import { describe, expect, it } from "vite-plus/test";

import { decisionRange, findHeading, markedMaturity, parsePage, slug } from "../src/markdown.ts";

describe("slug", () => {
  it("makes GitHub's anchors", () => {
    expect(slug("Find your way")).toBe("find-your-way");
    expect(slug("Packages (`packages/`)")).toBe("packages-packages");
    expect(slug("A4. Context library and lore (D661–D680)")).toBe(
      "a4-context-library-and-lore-d661d680",
    );
    expect(slug("See [the map](map.md)")).toBe("see-the-map");
  });
});

describe("parsePage", () => {
  const text = [
    "---",
    "maturity: canon",
    "maturity.deferred: note",
    "---",
    "# Plan",
    "",
    "Start at [the map](map.md) and `docs/lore/`, see [below](#decisions).",
    "",
    "## Decisions",
    "",
    "- **D1. One.** First",
    "  continued.",
    "- **D2. Two.** Second.",
    "",
    "```md",
    "# Not a heading [nor a link](nowhere.md)",
    "```",
    "",
    "## Decisions",
    "",
    "### Deep",
    "",
    "## Deferred",
    "",
    "- [`plans/x.md`](plans/x.md) is one route, not two; `README.md` is a mention.",
  ].join("\n");
  const page = parsePage(text);

  it("reads front matter, headings with unique anchors and their sections", () => {
    expect(page.frontMatter).toEqual({ maturity: "canon", "maturity.deferred": "note" });
    expect(page.headings.map((heading) => [heading.anchor, heading.depth])).toEqual([
      ["plan", 1],
      ["decisions", 2],
      ["decisions-1", 2],
      ["deep", 3],
      ["deferred", 2],
    ]);
    const second = findHeading(page, "decisions-1")!;
    expect(page.lines.slice(second.line, second.end).join("\n")).toBe("## Decisions\n\n### Deep\n");
    expect(findHeading(page, "Deferred")?.anchor).toBe("deferred");
  });

  it("finds decisions and their extent", () => {
    expect(page.decisions).toEqual(["D1", "D2"]);
    const range = decisionRange(page, "D1")!;
    expect(page.lines.slice(range.line, range.end)).toEqual([
      "- **D1. One.** First",
      "  continued.",
    ]);
  });

  it("collects links and path mentions outside code, with file lines", () => {
    expect(page.routes).toEqual([
      { kind: "link", target: "map.md", fragment: undefined, line: 7 },
      { kind: "link", target: "", fragment: "decisions", line: 7 },
      { kind: "mention", target: "docs/lore/", fragment: undefined, line: 7 },
      { kind: "link", target: "plans/x.md", fragment: undefined, line: 25 },
      { kind: "mention", target: "README.md", fragment: undefined, line: 25 },
    ]);
  });

  it("marks maturity per section, inherited from the page", () => {
    expect(markedMaturity(page, findHeading(page, "deferred"))).toBe("note");
    expect(markedMaturity(page, findHeading(page, "deep"))).toBe("canon");
    expect(markedMaturity(parsePage("# No front matter"), undefined)).toBeUndefined();
  });

  it("closes a fence only on one at least as long, and keeps a # that ends a word", () => {
    const nested = parsePage(
      ["````md", "```", "## Inside", "```", "````", "", "## Learning C#", "## Closed ##"].join(
        "\n",
      ),
    );
    expect(nested.headings.map((heading) => heading.text)).toEqual(["Learning C#", "Closed"]);
  });

  it("keeps a code block inside a decision, # lines and blank lines included", () => {
    const page = parsePage(
      [
        "- **D1. With code.**",
        "  ```sh",
        "  # comment",
        "",
        "  **D2. not one",
        "  ```",
        "  after.",
        "- **D3. Next.**",
      ].join("\n"),
    );
    const range = decisionRange(page, "D1")!;
    expect(page.lines.slice(range.line, range.end).at(-1)).toBe("  after.");
  });

  it("reads a link target in angle brackets, spaces included", () => {
    const page = parsePage("See [it](<my page.md#part>).");
    expect(page.routes).toEqual([
      { kind: "link", target: "my page.md", fragment: "part", line: 1 },
    ]);
  });
});
