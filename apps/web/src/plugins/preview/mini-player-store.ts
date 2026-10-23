// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/previewMiniPlayerStore.ts
// (one floating tab per thread, its position and width kept while the floating tab changes, and
// gestures that outlive their tab ignored), for browser tabs only (docs/plans/preview.md, D1202).
import type { Disposable } from "@jhin/sdk";

import type { PreviewMiniPlayerPosition } from "../../lib/mini-player-layout.ts";

export interface MiniPlayerState {
  /** The browser tab that floats. */
  readonly tabId: string;
  /** Where the user put it; unset until they move it. */
  readonly position: PreviewMiniPlayerPosition | null;
  /** The width the user gave it; unset until they resize it. */
  readonly width: number | null;
  readonly lastInteraction: "drag" | "resize";
}

/** The floating tab of each thread, keyed as the panel keys a thread (`<target>|<thread>`). */
export interface MiniPlayers {
  get(threadKey: string): MiniPlayerState | undefined;
  open(threadKey: string, tabId: string): void;
  close(threadKey: string): void;
  /** `tabId` guards against a drag that outlives the tab it started on. */
  move(threadKey: string, tabId: string, position: PreviewMiniPlayerPosition): void;
  resize(
    threadKey: string,
    tabId: string,
    width: number,
    position?: PreviewMiniPlayerPosition,
  ): void;
  subscribe(listener: () => void): Disposable;
}

export function createMiniPlayers(byThread: Map<string, MiniPlayerState> = new Map()): MiniPlayers {
  const listeners = new Set<() => void>();
  const set = (threadKey: string, next: MiniPlayerState | undefined) => {
    if (next === undefined) {
      if (!byThread.delete(threadKey)) return;
    } else byThread.set(threadKey, next);
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    get: (threadKey) => byThread.get(threadKey),
    open(threadKey, tabId) {
      const current = byThread.get(threadKey);
      if (current?.tabId === tabId) return;
      set(threadKey, {
        tabId,
        position: current?.position ?? null,
        width: current?.width ?? null,
        lastInteraction: current?.lastInteraction ?? "drag",
      });
    },
    close: (threadKey) => set(threadKey, undefined),
    move(threadKey, tabId, position) {
      const current = byThread.get(threadKey);
      if (current === undefined || current.tabId !== tabId) return;
      if (
        current.position?.x === position.x &&
        current.position.y === position.y &&
        current.lastInteraction === "drag"
      ) {
        return;
      }
      set(threadKey, { ...current, position, lastInteraction: "drag" });
    },
    resize(threadKey, tabId, width, position) {
      const current = byThread.get(threadKey);
      if (
        current === undefined ||
        current.tabId !== tabId ||
        (current.width === width &&
          current.lastInteraction === "resize" &&
          (position === undefined ||
            (current.position?.x === position.x && current.position.y === position.y)))
      ) {
        return;
      }
      set(threadKey, {
        ...current,
        width,
        position: position ?? current.position,
        lastInteraction: "resize",
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
}
