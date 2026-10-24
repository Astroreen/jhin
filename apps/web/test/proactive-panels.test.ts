// T3's proactive turn diff threshold (source-control.md D1426), as resolveProactiveTurnDiffAction.
import type { TurnCheckpoint } from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import { turnDiffWorthOpening } from "../src/plugins/source-control/proactive.tsx";

const checkpoint = (change: Partial<TurnCheckpoint>): TurnCheckpoint => ({
  threadId: "t",
  turnId: "u",
  turn: 1,
  ref: "refs/jhin/checkpoints/t/1",
  status: "ready",
  files: [],
  fileCount: 1,
  insertions: 1,
  deletions: 0,
  capturedAt: "2026-10-24T00:00:00.000Z",
  ...change,
});

describe("proactive panels", () => {
  it("opens the diff for edits to at least 3 files or 50 lines of a ready checkpoint", () => {
    expect(turnDiffWorthOpening(checkpoint({ fileCount: 3 }))).toBe(true);
    expect(turnDiffWorthOpening(checkpoint({ insertions: 30, deletions: 20 }))).toBe(true);
    expect(turnDiffWorthOpening(checkpoint({ fileCount: 2, insertions: 30, deletions: 19 }))).toBe(
      false,
    );
    expect(turnDiffWorthOpening(checkpoint({ fileCount: 0, insertions: 0 }))).toBe(false);
    expect(turnDiffWorthOpening(checkpoint({ fileCount: 9, status: "error" }))).toBe(false);
  });
});
