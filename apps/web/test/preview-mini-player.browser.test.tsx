import type { PreviewTab } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MiniPlayer } from "../src/plugins/preview/mini-player.tsx";
import { createMiniPlayers, type MiniPlayers } from "../src/plugins/preview/mini-player-store.ts";

const THREAD = "node-1|thread-1";

/** A node that streams nothing and answers every call. */
const client = {
  subscribe: () => ({ dispose() {} }),
  call: async () => ({}),
} as unknown as RpcClient;

const tab = (tabId: string) =>
  ({
    tabId,
    size: { width: 1280, height: 800 },
    recording: false,
    controller: null,
  }) as unknown as PreviewTab;

// The layout classes the player's layers use; browser tests load no Tailwind build.
const style = document.createElement("style");
style.textContent = ".absolute{position:absolute}.inset-0{inset:0}";
document.head.append(style);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** The player of `tabId` in a 1000 × 700 chat whose composer is 150 high. */
async function mount(players: MiniPlayers, tabId = "tab-a") {
  const container = document.createElement("div");
  Object.assign(container.style, { position: "relative", width: "1000px", height: "700px" });
  document.body.append(container);
  const root = createRoot(container);
  const render = async () =>
    act(async () =>
      root.render(
        <MiniPlayer
          client={client}
          composerHeight={150}
          onError={() => undefined}
          onOpenInPanel={() => undefined}
          players={players}
          state={players.get(THREAD)!}
          tab={tab(tabId)}
          threadId="thread-1"
          threadKey={THREAD}
          viewer="v1"
        />,
      ),
    );
  await render();
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const section = () =>
    container.querySelector<HTMLElement>("[data-preview-mini-player]") ??
    (() => {
      throw new Error("no player");
    })();
  const handle = () => section().querySelector<HTMLElement>("[data-preview-mini-player-handle]")!;
  return { container, section, handle, render };
}

/** A pointer event of `type` on `target` at a client point. */
function pointer(
  target: HTMLElement,
  type: string,
  x: number,
  y: number,
  pointerType = "mouse",
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType,
      button: 0,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("the floating mini player (D1202)", () => {
  it("sits in the chat's bottom corner above the composer until it is moved", async () => {
    const players = createMiniPlayers();
    players.open(THREAD, "tab-a");
    const { section } = await mount(players);
    const box = section().getBoundingClientRect();
    const chat = section().parentElement!.getBoundingClientRect();
    // 320 × 200 for a 1280 × 800 page, 12 px clear of the right edge and the composer.
    expect([box.width, box.height]).toEqual([320, 200]);
    expect(chat.right - box.right).toBe(12);
    expect(chat.bottom - 150 - box.bottom).toBe(12);
  });

  it("moves with a drag of its handle, and a tap on touch opens its pill instead", async () => {
    const players = createMiniPlayers();
    players.open(THREAD, "tab-a");
    const { handle, render } = await mount(players);
    const grip = handle().getBoundingClientRect();
    await act(async () => {
      pointer(handle(), "pointerdown", grip.x, grip.y);
      pointer(handle(), "pointermove", grip.x - 100, grip.y - 50);
      pointer(handle(), "pointerup", grip.x - 100, grip.y - 50);
    });
    const moved = players.get(THREAD)!;
    expect(moved.lastInteraction).toBe("drag");
    expect(moved.position).not.toBeNull();
    await render();

    // A touch that does not move past the slop is a tap: it toggles the pill.
    const at = handle().getBoundingClientRect();
    await act(async () => {
      pointer(handle(), "pointerdown", at.x, at.y, "touch");
      pointer(handle(), "pointermove", at.x + 2, at.y + 2, "touch");
      pointer(handle(), "pointerup", at.x + 2, at.y + 2, "touch");
      handle().click();
    });
    expect(handle().hasAttribute("data-pill-open")).toBe(true);
    expect(players.get(THREAD)!.position).toEqual(moved.position);
  });

  it("drops a drag that outlives the tab it started on", async () => {
    const players = createMiniPlayers();
    players.open(THREAD, "tab-a");
    const { handle } = await mount(players);
    const grip = handle().getBoundingClientRect();
    await act(async () => {
      pointer(handle(), "pointerdown", grip.x, grip.y);
      // Another tab floats in the thread meanwhile; this player's moves are for tab-a.
      players.open(THREAD, "tab-b");
      pointer(handle(), "pointermove", grip.x - 100, grip.y - 50);
      pointer(handle(), "pointerup", grip.x - 100, grip.y - 50);
    });
    expect(players.get(THREAD)).toEqual({
      tabId: "tab-b",
      position: null,
      width: null,
      lastInteraction: "drag",
    });
  });
});
