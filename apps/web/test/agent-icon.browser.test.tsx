import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { AgentIcon } from "../src/lib/agent-icon.tsx";

function render(agentId: string): SVGSVGElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<AgentIcon agentId={agentId} className="size-3.5" />));
  const svg = container.querySelector("svg")!;
  act(() => root.unmount());
  container.remove();
  return svg;
}

describe("a thread card's agent icon (D71)", () => {
  it("is Claude's for the Claude Code runtime, as T3 draws its claudeAgent provider", () => {
    const svg = render("jhin.agent-claude");
    expect(svg.getAttribute("viewBox")).toBe("0 0 256 257");
    expect(svg.getAttribute("class")).toContain("fill-[#d97757]");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("is a generic one for any other runtime", () => {
    for (const agentId of ["jhin.agent-fake", "acme.agent"]) {
      const svg = render(agentId);
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("class")).toContain("lucide-bot");
    }
  });
});
