import { describe, expect, it } from "vite-plus/test";

import { formatTerminalContext, terminalSelectionLines } from "../src/plugins/terminal/context.ts";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  resolveWrappedTerminalLinkRange,
} from "../src/plugins/terminal/links.ts";

describe("links in terminal output (D472)", () => {
  it("finds URLs and paths, without the punctuation around them", () => {
    expect(
      extractTerminalLinks("see https://example.com/a(b). and src/app.ts:12:3, done").map(
        (link) => [link.kind, link.text],
      ),
    ).toEqual([
      ["url", "https://example.com/a(b)"],
      ["path", "src/app.ts:12:3"],
    ]);
  });

  it("joins a URL wrapped over two lines and maps it back to both", () => {
    const lines = [
      { isWrapped: false, translateToString: () => "go to https://exa" },
      { isWrapped: true, translateToString: () => "mple.com/x now" },
    ];
    const wrapped = collectWrappedTerminalLinkLine(2, (index) => lines[index])!;
    expect(wrapped.text).toBe("go to https://example.com/x now");
    const [link] = extractTerminalLinks(wrapped.text);
    expect(resolveWrappedTerminalLinkRange(wrapped, link!)).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 10, y: 2 },
    });
  });
});

describe("Add to chat (D473)", () => {
  it("counts the selection's rows, wrapped ones included", () => {
    // One long line wrapped over three rows: no newline in the selected text.
    expect(terminalSelectionLines({ start: { y: 4 }, end: { y: 6 } })).toEqual({
      lineStart: 5,
      lineEnd: 7,
    });
  });

  it("writes T3's inline label and its terminal_context block", () => {
    const text = "$ ls\nREADME.md\n";
    expect(
      formatTerminalContext({
        terminalId: "term-1",
        terminalLabel: "Terminal 1",
        ...terminalSelectionLines({ start: { y: 2 }, end: { y: 3 } }),
        text,
      }),
    ).toBe(
      "@terminal-1:3-4\n\n<terminal_context>\n- Terminal 1 lines 3-4:\n  3 | $ ls\n  4 | README.md\n</terminal_context>",
    );
  });
});
