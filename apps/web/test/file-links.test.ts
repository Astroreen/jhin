// Which links and inline code of an agent's message name a file, and at which line (t3-parity.md
// D1430, D1431), as T3's markdownLinks.test.ts and fileLinks.test.ts check them.
import { describe, expect, it } from "vite-plus/test";

import {
  inlineCodeFilePathCandidate,
  resolveMarkdownFileLinkTarget,
  resolvePathLinkTarget,
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
});
