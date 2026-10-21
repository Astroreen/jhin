import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { PierreEntryIcon } from "../src/lib/pierre-entry-icon.tsx";

function render(
  pathValue: string,
  kind: "file" | "directory",
  theme: "light" | "dark",
): SVGSVGElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<PierreEntryIcon pathValue={pathValue} kind={kind} theme={theme} />));
  const svg = container.querySelector("svg")!;
  act(() => root.unmount());
  container.remove();
  return svg;
}

describe("T3's icon of one file (D923)", () => {
  it("draws a file from the sprite in the theme's colour of its type", () => {
    const light = render("src/a.ts", "file", "light");
    expect(light.getAttribute("data-icon-token")).toBe("typescript");
    expect(light.querySelector("use")?.getAttribute("href")).toBe("#file-tree-builtin-typescript");
    expect(light.style.color).toBe("rgb(26, 133, 212)");
    expect(render("src/a.ts", "file", "dark").style.color).toBe("rgb(105, 177, 255)");
    // The sprite the icons draw from is on the page once.
    expect(document.querySelectorAll("#jhin-pierre-file-icon-sprite")).toHaveLength(1);
  });

  it("draws a folder with Lucide's icon, as T3 does", () => {
    const svg = render("packages/client", "directory", "light");
    expect(svg.getAttribute("data-pierre-icon")).toBeNull();
    expect(svg.getAttribute("class")).toContain("lucide-folder");
  });
});
