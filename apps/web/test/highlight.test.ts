import { describe, expect, it } from "vite-plus/test";

import { codeLanguageEntry } from "../src/lib/code-languages.ts";
import { highlightTokens, languageOf } from "../src/lib/highlight.ts";

describe("highlightTokens (D841)", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["a lone CR", "\r"],
  ])("puts each token on its own characters across %s line breaks", async (_name, newline) => {
    const code = ["const a = 1;", "let b = 2;"].join(newline);
    const tokens = await highlightTokens(code, "typescript");
    const words = tokens.map((token) => code.slice(token.from, token.to).trim());
    expect(words).toContain("const");
    expect(words).toContain("let");
    for (const token of tokens) expect(token.style).toMatch(/--shiki-light:.*--shiki-dark:/);
  });

  it("finds no language in Object's own names", () => {
    expect(languageOf("constructor")).toBeUndefined();
    expect(languageOf("__proto__")).toBeUndefined();
    expect(codeLanguageEntry("toString")).toBeNull();
    expect(languageOf("ts")).toBe("typescript");
    expect(codeLanguageEntry("py")?.label).toBe("Python");
  });
});
