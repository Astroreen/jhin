// The cases follow T3 Code's previewMiniPlayerStore tests (MIT, see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vite-plus/test";

import { createMiniPlayers } from "../src/plugins/preview/mini-player-store.ts";

const threadA = "node-1|thread-A";
const threadB = "node-1|thread-B";

describe("the floating tab of each thread (D1202)", () => {
  it("keeps floating previews scoped to their thread", () => {
    const players = createMiniPlayers();
    players.open(threadA, "tab-a");
    players.open(threadB, "tab-b");
    expect(players.get(threadA)).toMatchObject({ tabId: "tab-a" });
    expect(players.get(threadB)).toMatchObject({ tabId: "tab-b" });
  });

  it("preserves position when switching the floating tab within one thread", () => {
    const players = createMiniPlayers();
    players.open(threadA, "tab-a");
    players.move(threadA, "tab-a", { x: 24, y: 48 });
    players.open(threadA, "tab-b");
    expect(players.get(threadA)).toEqual({
      tabId: "tab-b",
      position: { x: 24, y: 48 },
      width: null,
      lastInteraction: "drag",
    });
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    const players = createMiniPlayers();
    players.open(threadA, "tab-a");
    players.open(threadA, "tab-b");
    players.move(threadA, "tab-a", { x: 100, y: 100 });
    expect(players.get(threadA)).toEqual({
      tabId: "tab-b",
      position: null,
      width: null,
      lastInteraction: "drag",
    });
  });

  it("preserves a thread-bound width while switching tabs", () => {
    const players = createMiniPlayers();
    players.open(threadA, "tab-a");
    players.resize(threadA, "tab-a", 480);
    players.open(threadA, "tab-b");
    expect(players.get(threadA)).toMatchObject({ tabId: "tab-b", width: 480 });
  });

  it("keeps a resize placement after release and clears it when dragging", () => {
    const players = createMiniPlayers();
    players.open(threadA, "tab-a");
    players.resize(threadA, "tab-a", 460, { x: 1112, y: 275 });
    expect(players.get(threadA)).toMatchObject({
      width: 460,
      position: { x: 1112, y: 275 },
      lastInteraction: "resize",
    });
    players.move(threadA, "tab-a", { x: 1112, y: 275 });
    expect(players.get(threadA)).toMatchObject({
      width: 460,
      position: { x: 1112, y: 275 },
      lastInteraction: "drag",
    });
  });

  it("tells its listeners about a change and nothing else", () => {
    const players = createMiniPlayers();
    let changes = 0;
    const subscription = players.subscribe(() => (changes += 1));
    players.open(threadA, "tab-a");
    players.open(threadA, "tab-a");
    players.close(threadB);
    players.close(threadA);
    subscription.dispose();
    players.open(threadA, "tab-a");
    expect(changes).toBe(2);
  });
});
