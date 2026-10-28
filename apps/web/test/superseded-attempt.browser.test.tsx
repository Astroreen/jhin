// T3's "Superseded attempt" (t3-parity.md D1653, D1654): a restart's stopped turn folds its
// output, keeping what the user sent and an answer that had finished.
import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { reduceTimeline } from "../src/lib/timeline.ts";
import { TimelineView } from "../src/plugins/chat/timeline.tsx";

function stream(...entries: [type: string, payload: unknown][]): StoredEvent[] {
  return entries.map(([type, payload], index) => ({
    stream: "thread/t1",
    sequence: index + 1,
    type,
    payload: payload as StoredEvent["payload"],
    at: new Date(Date.UTC(2026, 9, 28, 12, 0, index)).toISOString(),
  }));
}

const events = stream(
  [ThreadEvents.turnStarted, { turnId: "u1", agentId: "acme.plain", input: { text: "Build it" } }],
  [ThreadEvents.itemCompleted, { turnId: "u1", itemId: "a", kind: "message", text: "Plan first." }],
  [ThreadEvents.itemDelta, { turnId: "u1", itemId: "b", kind: "message", text: "Starting the bu" }],
  [ThreadEvents.turnInterrupted, { turnId: "u1", superseded: true }],
  [
    ThreadEvents.turnStarted,
    {
      turnId: "u2",
      agentId: "acme.plain",
      input: { text: "Use Rust instead" },
      restartOf: "u1",
    },
  ],
  [ThreadEvents.itemCompleted, { turnId: "u2", itemId: "c", kind: "message", text: "In Rust." }],
  [ThreadEvents.turnCompleted, { turnId: "u2" }],
);

describe("a superseded attempt", () => {
  it("is read from the stopped turn's end", () => {
    const { turns } = reduceTimeline(events);
    expect(turns.map((turn) => [turn.turnId, turn.state, turn.superseded])).toEqual([
      ["u1", "interrupted", true],
      ["u2", "completed", undefined],
    ]);
  });

  it("folds the cut-off output under T3's row, keeping the messages and a finished answer", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TimelineView format="locale" timeline={reduceTimeline(events)} />);
    });
    const fold = page.getByRole("button", { name: /Superseded attempt/ });
    await expect.element(fold).toHaveTextContent("Superseded attemptCut off by a steer");
    await expect.element(fold).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).not.toContain("You stopped");
    expect(document.body.textContent).toContain("Build it");
    expect(document.body.textContent).toContain("Plan first.");
    expect(document.body.textContent).toContain("Use Rust instead");
    expect(document.body.textContent).not.toContain("Starting the bu");
    await fold.click();
    await expect.element(fold).toHaveAttribute("aria-expanded", "true");
    expect(document.body.textContent).toContain("Starting the bu");
    await act(async () => root.unmount());
    host.remove();
  });
});
