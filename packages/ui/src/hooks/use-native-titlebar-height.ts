// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/windowControlsOverlay.ts.
import { useSyncExternalStore } from "react";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

function windowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") return null;
  return (
    (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
      .windowControlsOverlay ?? null
  );
}

function subscribe(listener: () => void): () => void {
  const overlay = windowControlsOverlay();
  overlay?.addEventListener("geometrychange", listener);
  return () => overlay?.removeEventListener("geometrychange", listener);
}

function height(): number {
  const overlay = windowControlsOverlay();
  return overlay?.visible === true ? overlay.getTitlebarAreaRect().bottom : 0;
}

/**
 * Height of the native caption strip drawn over the page (the desktop app's
 * window controls overlay, docs/plans/desktop.md D515), or 0 without one.
 */
export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribe, height, () => 0);
}
