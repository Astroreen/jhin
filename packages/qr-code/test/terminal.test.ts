import { describe, expect, it } from "vite-plus/test";

import { QrCode, renderTerminalQrCode } from "../src/index.ts";

/** The modules a half-block rendering shows, back as rows of booleans. */
function modulesOf(rendered: string, margin: number): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of rendered.split("\n")) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const character of line) {
      top.push(character === "█" || character === "▀");
      bottom.push(character === "█" || character === "▄");
    }
    rows.push(top, bottom);
  }
  return rows.slice(margin).map((row) => row.slice(margin));
}

describe("renderTerminalQrCode", () => {
  it("draws every module of the code, two rows a line, inside a light margin", () => {
    const value = "http://192.168.1.20:7777/pair#token=ABCDEFGHJKMN";
    const code = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
    const rendered = renderTerminalQrCode(value);
    const lines = rendered.split("\n");

    expect(lines).toHaveLength(Math.ceil((code.size + 4) / 2));
    expect(lines.every((line) => [...line].length === code.size + 4)).toBe(true);
    expect(rendered).toMatch(/^[ █▀▄\n]+$/u);
    const modules = modulesOf(rendered, 2);
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        expect(modules[y]![x]).toBe(code.getModule(x, y));
      }
    }
    // The margin is light all around.
    expect(lines[0]!.trim()).toBe("");
    expect(lines.every((line) => line.startsWith("  ") && line.endsWith("  "))).toBe(true);
  });
});
