import { describe, expect, it } from "vite-plus/test";

import { terminalContextRecord } from "../src/lib/composer-context.ts";
import {
  addToChatCall,
  formatTerminalContext,
  terminalSelectionLines,
} from "../src/plugins/terminal/context.ts";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  resolvePathLinkTarget,
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

describe("Add to chat as T3's inline terminal chip (D1009)", () => {
  const selection = {
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    lineStart: 3,
    lineEnd: 4,
    text: "\r\n$ ls\r\nREADME.md\r\n\n",
  };

  it("is a terminal record: T3's label, its lines without blank ones around", () => {
    expect(terminalContextRecord({ id: "a", ...selection })).toEqual({
      version: 1,
      kind: "terminal",
      contextId: "terminal_a",
      label: "Terminal 1 lines 3-4",
      terminalId: "term-1",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "$ ls\nREADME.md",
    });
    expect(terminalContextRecord({ id: "b", ...selection, lineEnd: 3, text: "x" }).label).toBe(
      "Terminal 1 line 3",
    );
    // T3's bound: 64 000 characters, the cut marked.
    const long = terminalContextRecord({ id: "c", ...selection, text: "y".repeat(70_000) });
    expect(long.text).toHaveLength(64_000);
    expect(long.text.endsWith("\n… truncated …")).toBe(true);
  });

  it("goes as a record where the chat takes one, else as T3's legacy text", () => {
    expect(addToChatCall(selection, () => true, "a")).toEqual({
      command: "chat.composer.insert-context",
      input: { record: terminalContextRecord({ id: "a", ...selection }) },
    });
    const legacy = addToChatCall(selection, (name) => name === "chat.composer.insert", "a");
    expect(legacy.command).toBe("chat.composer.insert");
    expect(legacy.input["text"]).toMatch(/^@terminal-1:3-4\n\n<terminal_context>/);
  });
});

describe("a path link's target (D965, T3's resolvePathLinkTarget)", () => {
  it("joins a relative path to the terminal's folder and keeps its position", () => {
    expect(resolvePathLinkTarget("src/app.ts:12:4", "/home/me/repo")).toEqual({
      path: "/home/me/repo/src/app.ts",
      line: 12,
      column: 4,
    });
    expect(resolvePathLinkTarget("/etc/hosts", "/home/me/repo")).toEqual({ path: "/etc/hosts" });
  });

  it("takes ~/ from the home the folder shows, on macOS, Linux and Windows", () => {
    expect(resolvePathLinkTarget("~/notes.md:3", "/Users/me/repo")).toEqual({
      path: "/Users/me/notes.md",
      line: 3,
    });
    expect(resolvePathLinkTarget("~/notes.md", "/home/me/repo").path).toBe("/home/me/notes.md");
    expect(resolvePathLinkTarget("src\\a.ts", "C:\\Users\\me\\repo").path).toBe(
      "C:\\Users\\me\\repo\\src\\a.ts",
    );
  });
});
