// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/windowControlsOverlay.ts
// and the macOS traffic-light inset of components/AppSidebarLayout.tsx.
import type { DesktopBridge } from "@jhin/desktop-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

const ELECTRON = "electron";
const ELECTRON_WINDOWS = "electron-windows";
const WCO = "wco";
/** Where the page's top-left controls start on macOS: past the traffic lights. */
const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

/**
 * The window chrome of D515 on the page: T3's `electron` classes, `wco` while
 * the native window controls are drawn over the page, and on macOS the
 * controls inset past the traffic lights unless the window is full screen.
 */
export function syncWindowChrome(bridge: DesktopBridge): Disposable {
  const root = document.documentElement;
  const classes = bridge.platform === "win32" ? [ELECTRON, ELECTRON_WINDOWS] : [ELECTRON];
  root.classList.add(...classes);

  const overlay =
    (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
      .windowControlsOverlay ?? null;
  const syncOverlay = () => root.classList.toggle(WCO, overlay?.visible === true);
  syncOverlay();
  overlay?.addEventListener("geometrychange", syncOverlay);

  let disposed = false;
  let stopFullscreen: (() => void) | undefined;
  if (bridge.platform === "darwin") {
    const inset = (fullscreen: boolean) => {
      if (fullscreen) root.style.removeProperty("--workspace-controls-left");
      else root.style.setProperty("--workspace-controls-left", MACOS_TRAFFIC_LIGHTS_LEFT_INSET);
    };
    inset(false);
    stopFullscreen = bridge.onWindowFullscreen(inset);
    void bridge.getWindowFullscreen().then((fullscreen) => {
      if (!disposed) inset(fullscreen);
    });
  }

  return toDisposable(() => {
    disposed = true;
    stopFullscreen?.();
    overlay?.removeEventListener("geometrychange", syncOverlay);
    root.classList.remove(...classes, WCO);
    root.style.removeProperty("--workspace-controls-left");
  });
}
