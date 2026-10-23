import type { ChatCanvas, ChatCanvasPreview } from "@jhin/client-api";
import type { PreviewTab } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { MiniPlayer } from "../src/plugins/preview/mini-player.tsx";
import { createNativeSurfaces } from "../src/plugins/preview/native-surfaces.ts";
import { createMiniPlayers, type MiniPlayers } from "../src/plugins/preview/mini-player-store.ts";
import {
  createPictureInPicture,
  supportsPictureInPicture,
} from "../src/plugins/preview/picture-in-picture.ts";

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
async function mount(
  players: MiniPlayers,
  tabId = "tab-a",
  extra: Partial<Parameters<typeof MiniPlayer>[0]> = {},
) {
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
          surfaces={createNativeSurfaces()}
          tab={tab(tabId)}
          threadId="thread-1"
          threadKey={THREAD}
          viewer="v1"
          {...extra}
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

  it("goes where the chat's canvas lays it out, and tells the canvas about itself (D1326)", async () => {
    const players = createMiniPlayers();
    players.open(THREAD, "tab-a");
    const reported: ChatCanvasPreview[] = [];
    const canvas: ChatCanvas = {
      container: { width: 1000, height: 700 },
      previewKey: "tab-a",
      frame: { x: 100, y: 40, width: 240, height: 150 },
      report: (preview) => reported.push(preview),
      clear: () => undefined,
    };
    const { section } = await mount(players, "tab-a", { canvas });
    const box = section().getBoundingClientRect();
    const chat = section().parentElement!.getBoundingClientRect();
    expect([box.left - chat.left, box.top - chat.top, box.width, box.height]).toEqual([
      100, 40, 240, 150,
    ]);
    expect(reported.at(-1)).toEqual({
      key: "tab-a",
      width: null,
      position: null,
      lastInteraction: "drag",
      source: { width: 1280, height: 800 },
    });
  });

  it("pops its tab into the browser's picture-in-picture window and closes it again (D1327)", async () => {
    expect(supportsPictureInPicture()).toBe(true);
    const players = createMiniPlayers();
    players.open(THREAD, "tab-a");
    const pictureInPicture = createPictureInPicture();
    await mount(players, "tab-a", { pictureInPicture });
    await userEvent.click(page.getByRole("button", { name: "Pop preview into separate window" }));
    await expect
      .element(page.getByRole("button", { name: "Close popped-out preview" }))
      .toBeVisible();
    expect(pictureInPicture.key()).toBe(JSON.stringify(["thread-1", "tab-a"]));
    await userEvent.click(page.getByRole("button", { name: "Close popped-out preview" }));
    await expect
      .element(page.getByRole("button", { name: "Pop preview into separate window" }))
      .toBeVisible();
    expect(document.querySelector("video[data-preview-picture-in-picture]")).toBeNull();
  });
});
