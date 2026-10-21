// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/window/DesktopWindow.ts
// and apps/desktop/src/electron/ElectronShell.ts (parseSafeExternalUrl).
import {
  BrowserWindow,
  Menu,
  clipboard,
  nativeTheme,
  screen,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

import { DESKTOP_CHANNELS } from "@jhin/desktop-api";

import type { ZoomDirection } from "./menu.ts";
import {
  MIN_MAIN_WINDOW_SIZE,
  normalizeMainWindowBounds,
  resolveInitialMainWindowBounds,
  type SettingsStore,
} from "./settings.ts";

const TITLEBAR_HEIGHT = 40;
// The web client's --workspace-topbar-height. Native macOS buttons are 14
// points tall and do not scale with the renderer's zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;

/** http, https and mailto links open in the system browser; nothing else leaves the app. */
function parseSafeExternalUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function backgroundColor(dark: boolean): string {
  return dark ? "#0a0a0a" : "#ffffff";
}

function titleBarOptions(dark: boolean, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }
  return {
    titleBarStyle: "hidden" as const,
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: dark ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncMacosWindowButtons(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

export interface MainWindowOptions {
  readonly title: string;
  readonly platform: NodeJS.Platform;
  readonly preload: string;
  readonly icon: string | undefined;
  /**
   * The node's web client and its token (D513), as they are now: a node
   * restarted after it stopped may listen elsewhere.
   */
  node(): { readonly url: string; readonly token: string };
  readonly settings: SettingsStore;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The main window: T3's chrome, kept bounds, context menu, links and recovery. */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { platform, settings } = options;
  const dark = nativeTheme.shouldUseDarkColors;
  const saved = settings.get();
  let displays: Electron.Rectangle[] = [];
  try {
    displays = screen.getAllDisplays().map((display) => display.bounds);
  } catch (error) {
    options.log("failed to read connected displays; using defaults", { error: String(error) });
  }
  const initialBounds = resolveInitialMainWindowBounds(saved.mainWindowBounds, displays);
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_MAIN_WINDOW_SIZE.width,
    minHeight: MIN_MAIN_WINDOW_SIZE.height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColor(dark),
    ...(platform === "darwin" || options.icon === undefined ? {} : { icon: options.icon }),
    title: options.title,
    ...titleBarOptions(dark, platform),
    webPreferences: {
      preload: options.preload,
      // Chromium throttles hidden renderers, which stalls first paint; the
      // first reveal turns throttling back on.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // --- Bounds, written 500 ms after the last change and on close (D515). ---
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const persistBounds = () => {
    persistTimer = undefined;
    if (window.isDestroyed()) return;
    const bounds =
      window.isFullScreen() || window.isMaximized() || window.isMinimized()
        ? window.getNormalBounds()
        : window.getBounds();
    try {
      settings.update({
        mainWindowBounds: normalizeMainWindowBounds(bounds),
        mainWindowMaximized: window.isMaximized(),
      });
    } catch (error) {
      options.log("failed to persist main window bounds", { error: String(error) });
    }
  };
  const schedulePersist = () => {
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistBounds, BOUNDS_PERSIST_DEBOUNCE_MS);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"] as const) {
    window.on(event as "resize", schedulePersist);
  }
  window.on("close", () => {
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistBounds();
  });

  // --- The context menu (D517). ---
  const contents = window.webContents;
  contents.on("context-menu", (_event, params) => {
    if (window.isDestroyed()) return;
    const template: MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length === 0) {
        template.push({ label: "No suggestions", enabled: false });
      }
      template.push({ type: "separator" });
    }
    if (parseSafeExternalUrl(params.linkURL) !== undefined) {
      template.push(
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.mediaType === "image") {
      template.push(
        { label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) },
        { type: "separator" },
      );
    }
    template.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
    Menu.buildFromTemplate(template).popup({ window });
  });

  // --- Links: off-origin pages open in the system browser (D517). ---
  contents.setWindowOpenHandler(({ url }) => {
    if (parseSafeExternalUrl(url) !== undefined) void shell.openExternal(url);
    return { action: "deny" };
  });
  // A link or a server redirect: the page with the bridge never leaves the node.
  const keepOnNode = (event: Electron.Event, url: string) => {
    if (URL.canParse(url) && new URL(url).origin === new URL(options.node().url).origin) return;
    event.preventDefault();
    if (parseSafeExternalUrl(url) !== undefined) void shell.openExternal(url);
  };
  contents.on("will-navigate", keepOnNode);
  contents.on("will-redirect", keepOnNode);

  // Ctrl+wheel never reaches the menu accelerators: Chromium reports it here.
  contents.on("zoom-changed", (_event, direction) => zoomMainWindow(window, direction, platform));

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(options.title);
  });
  if (platform === "darwin") {
    window.on("enter-full-screen", () => contents.send(DESKTOP_CHANNELS.windowFullscreen, true));
    window.on("leave-full-screen", () => {
      syncMacosWindowButtons(window);
      contents.send(DESKTOP_CHANNELS.windowFullscreen, false);
    });
  }
  contents.on("did-finish-load", () => {
    window.setTitle(options.title);
    if (platform === "darwin") syncMacosWindowButtons(window);
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) => {
    if (isMainFrame)
      options.log("main window failed to load", { errorCode, errorDescription, url });
  });

  // --- A crashed renderer reloads, at most three times a minute (D522). ---
  let recoveries: number[] = [];
  contents.on("render-process-gone", (_event, details) => {
    const recoverable = ["crashed", "oom", "killed", "abnormal-exit"].includes(details.reason);
    const now = Date.now();
    recoveries = recoveries.filter((time) => now - time < RENDERER_RECOVERY_WINDOW_MS);
    const recover =
      recoverable && !window.isDestroyed() && recoveries.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
    options.log("main window render process gone", { reason: details.reason, recovering: recover });
    if (!recover) return;
    recoveries.push(now);
    setTimeout(() => {
      if (!window.isDestroyed()) loadNode(window, options.node());
    }, RENDERER_RECOVERY_RELOAD_DELAY_MS);
  });

  // --- Shown once painted; Linux may never send ready-to-show (T3). ---
  let revealed = false;
  const reveal = () => {
    if (revealed || window.isDestroyed()) return;
    revealed = true;
    contents.setBackgroundThrottling(true);
    if (saved.mainWindowMaximized) window.maximize();
    window.show();
  };
  window.once("ready-to-show", reveal);
  if (platform === "linux") contents.once("did-finish-load", reveal);

  loadNode(window, options.node());
  return window;
}

/** Loads a node's web client with its token in the fragment, as `jhin serve --ui` users open it (D513). */
export function loadNode(
  window: BrowserWindow,
  node: { readonly url: string; readonly token: string },
): void {
  void window.loadURL(`${node.url}#token=${encodeURIComponent(node.token)}`);
}

/** Half a zoom level a step, on the main window's page only (D516). */
export function zoomMainWindow(
  window: BrowserWindow,
  direction: ZoomDirection,
  platform: NodeJS.Platform,
): void {
  if (window.isDestroyed()) return;
  const contents = window.webContents;
  contents.setZoomLevel(
    direction === "reset" ? 0 : contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
  );
  if (platform === "darwin") syncMacosWindowButtons(window);
}

/** Follows the system theme: background and the native controls' colours. */
export function syncWindowAppearance(window: BrowserWindow, platform: NodeJS.Platform): void {
  if (window.isDestroyed()) return;
  const dark = nativeTheme.shouldUseDarkColors;
  window.setBackgroundColor(backgroundColor(dark));
  const { titleBarOverlay } = titleBarOptions(dark, platform) as {
    titleBarOverlay?: Electron.TitleBarOverlayOptions;
  };
  if (titleBarOverlay !== undefined) window.setTitleBarOverlay(titleBarOverlay);
}
