// Which links and inline code of an agent's message name a file, and at which line (t3-parity.md
// D1430, D1431), as T3's markdownLinks.test.ts and fileLinks.test.ts check them.
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileLinkParentSuffixByPath,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  fileLinkLabel,
  formatWorkspaceRelativePath,
  inlineCodeFilePathCandidate,
  messageFileLinkParentSuffixes,
  resolveMarkdownFileLinkTarget,
  resolvePathLinkTarget,
  shouldOpenFileLinkInEditor,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "../src/lib/file-links.ts";

describe("file links", () => {
  it("reads a path's line and column, from a suffix or a hash", () => {
    expect(splitFilePathPosition("src/a.ts:12:3")).toEqual({
      path: "src/a.ts",
      line: 12,
      column: 3,
    });
    expect(splitFilePathPosition("src/a.ts", "#L7")).toEqual({ path: "src/a.ts", line: 7 });
    expect(splitFilePathPosition("src/a.ts")).toEqual({ path: "src/a.ts" });
  });

  it("resolves a link against the thread's folder, and leaves the web alone", () => {
    expect(resolveMarkdownFileLinkTarget("src/a.ts:12", "/w/acme")).toBe("/w/acme/src/a.ts:12");
    expect(resolveMarkdownFileLinkTarget("src/a.ts#L4", "/w/acme")).toBe("/w/acme/src/a.ts:4");
    expect(resolveMarkdownFileLinkTarget("file:///w/acme/b.md", "/w/acme")).toBe("/w/acme/b.md");
    expect(resolveMarkdownFileLinkTarget("https://example.com/a.ts", "/w/acme")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("#install", "/w/acme")).toBeNull();
  });

  it("takes inline code for a path only when it looks like one", () => {
    expect(inlineCodeFilePathCandidate("src/a.ts")).toBe("src/a.ts");
    expect(inlineCodeFilePathCandidate("a.ts:3")).toBe("a.ts:3");
    expect(inlineCodeFilePathCandidate("npm install")).toBeNull();
    expect(inlineCodeFilePathCandidate("example.com/path")).toBeNull();
    expect(inlineCodeFilePathCandidate("v1.2.3")).toBeNull();
    expect(resolvePathLinkTarget("src/a.ts:3", "/w/acme")).toBe("/w/acme/src/a.ts:3");
  });

  it("knows a file inside the thread's folder from one outside", () => {
    expect(workspaceRelativeFilePath("/w/acme/src/a.ts", "/w/acme")).toBe("src/a.ts");
    expect(workspaceRelativeFilePath("/w/other/a.ts", "/w/acme")).toBeNull();
    expect(workspaceRelativeFilePath("/w/acme", "/w/acme/")).toBe(".");
  });

  it("tells files that share a name apart by their folders, two deep at least (D1643)", () => {
    const suffixes = buildFileLinkParentSuffixByPath([
      "/w/acme/src/lib/a.ts",
      "/w/acme/src/ui/a.ts",
      "/w/acme/README.md",
    ]);
    expect(suffixes.get("/w/acme/src/lib/a.ts")).toBe("src/lib");
    expect(suffixes.get("/w/acme/src/ui/a.ts")).toBe("src/ui");
    // A name only one file has needs no suffix.
    expect(suffixes.has("/w/acme/README.md")).toBe(false);
    // Deeper where the last two folders are the same.
    const deep = buildFileLinkParentSuffixByPath(["/w/x/src/lib/a.ts", "/w/y/src/lib/a.ts"]);
    expect(deep.get("/w/x/src/lib/a.ts")).toBe("x/src/lib");
    expect(deep.get("/w/y/src/lib/a.ts")).toBe("y/src/lib");
    // The same file twice is one file.
    expect(buildFileLinkParentSuffixByPath(["/w/a.ts", "/w/a.ts"]).size).toBe(0);
    // Windows separators are read as slashes.
    const windows = buildFileLinkParentSuffixByPath(["C:\\w\\a\\b.ts", "C:\\w\\c\\b.ts"]);
    expect(windows.get("C:/w/a/b.ts")).toBe("w/a");
  });

  it("labels a chip with its name, its folders and its line and column (D1643)", () => {
    const suffixes = new Map([["/w/acme/src/lib/a.ts", "src/lib"]]);
    expect(fileLinkLabel({ path: "/w/acme/src/lib/a.ts" }, suffixes)).toBe("a.ts · src/lib");
    expect(fileLinkLabel({ path: "/w/acme/src/lib/a.ts", line: 12, column: 3 }, suffixes)).toBe(
      "a.ts · src/lib · L12:C3",
    );
    expect(fileLinkLabel({ path: "/w/acme/b.ts", line: 7 }, suffixes)).toBe("b.ts · L7");
  });

  it("finds a message's file links in its links and inline code, not in its code blocks", () => {
    const text = [
      "See [a.ts](src/lib/a.ts:3) and `src/ui/a.ts`, or [the docs](https://example.com/a.ts).",
      "```",
      "`src/other/a.ts`",
      "```",
      'And [title](<src/b c.ts> "Title").',
    ].join("\n");
    expect(extractMarkdownLinkHrefs(text)).toEqual([
      "src/lib/a.ts:3",
      "https://example.com/a.ts",
      "src/b c.ts",
    ]);
    expect(extractInlineCodeSpans(text)).toEqual(["src/ui/a.ts"]);
    const suffixes = messageFileLinkParentSuffixes(text, "/w/acme");
    expect(suffixes.get("/w/acme/src/lib/a.ts")).toBe("src/lib");
    expect(suffixes.get("/w/acme/src/ui/a.ts")).toBe("src/ui");
    expect(suffixes.size).toBe(2);
  });

  it("copies a relative path from the workspace's folder, with its position (T3's)", () => {
    expect(formatWorkspaceRelativePath("/w/acme/src/a.ts:12:3", "/w/acme")).toBe(
      "acme/src/a.ts:12:3",
    );
    expect(formatWorkspaceRelativePath("/w/acme/src/a.ts", "/w/acme/")).toBe("acme/src/a.ts");
    expect(formatWorkspaceRelativePath("/w/acme", "/w/acme")).toBe("acme");
    expect(formatWorkspaceRelativePath("src/a.ts", "/w/acme")).toBe("acme/src/a.ts");
    expect(formatWorkspaceRelativePath("/other/a.ts", "/w/acme")).toBe("/other/a.ts");
  });

  it("opens a link in the editor on ⌘-click on macOS, Ctrl-click elsewhere", () => {
    expect(shouldOpenFileLinkInEditor({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(shouldOpenFileLinkInEditor({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(shouldOpenFileLinkInEditor({ metaKey: false, ctrlKey: true }, "Linux x86_64")).toBe(
      true,
    );
    expect(shouldOpenFileLinkInEditor({ metaKey: true, ctrlKey: false }, "Win32")).toBe(false);
    expect(shouldOpenFileLinkInEditor({ metaKey: false, ctrlKey: false }, "Win32")).toBe(false);
  });
});
