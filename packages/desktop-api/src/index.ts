// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/desktop.ts
// (DesktopUpdateState, DesktopBridge) and apps/desktop/src/ipc/channels.ts.
import { z, type Disposable } from "@jhin/sdk";

/** What the `jhin.desktop` client plugin provides to other client plugins (D514). */
export const DESKTOP_SHELL_CAPABILITY = "desktop.shell";

// The channels and the bridge's version, without zod: the preload imports them (D511).
export { DESKTOP_BRIDGE_VERSION, DESKTOP_CHANNELS } from "./channels.ts";

/** The release track: stable releases or nightly prereleases (D519). */
export const DesktopUpdateChannel = z.enum(["latest", "nightly"]);
export type DesktopUpdateChannel = z.output<typeof DesktopUpdateChannel>;

export const DesktopUpdateStatus = z.enum([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export type DesktopUpdateStatus = z.output<typeof DesktopUpdateStatus>;

/** One release's notes for the update control (T3's `DesktopUpdateReleaseNote`, D948). */
export const DesktopUpdateReleaseNote = z.object({
  version: z.string(),
  /** The newest items, at most eight. */
  items: z.array(z.string()),
  /** How many items the release has in all. */
  totalItems: z.number().int(),
});
export type DesktopUpdateReleaseNote = z.output<typeof DesktopUpdateReleaseNote>;

/** T3 Code's update state, without its CPU architectures (Deferred). */
export const DesktopUpdateState = z.object({
  enabled: z.boolean(),
  status: DesktopUpdateStatus,
  channel: DesktopUpdateChannel,
  currentVersion: z.string(),
  availableVersion: z.string().nullable(),
  downloadedVersion: z.string().nullable(),
  /** Nightly's notes of the releases since this version, newest first (D948). */
  releaseNotes: z.array(DesktopUpdateReleaseNote).default([]),
  /** Releases with notes beyond the six shown. */
  omittedReleaseCount: z.number().int().default(0),
  downloadPercent: z.number().nullable(),
  /** ISO time of the last check. */
  checkedAt: z.string().nullable(),
  message: z.string().nullable(),
  /** Which action failed, for `status: "error"` and a failed install. */
  errorContext: z.enum(["check", "download", "install"]).nullable(),
  canRetry: z.boolean(),
});
export type DesktopUpdateState = z.output<typeof DesktopUpdateState>;

export const DesktopUpdateCheckResult = z.object({
  /** False when no check ran: updates are disabled or another action runs. */
  checked: z.boolean(),
  state: DesktopUpdateState,
});
export type DesktopUpdateCheckResult = z.output<typeof DesktopUpdateCheckResult>;

export const DesktopUpdateActionResult = z.object({
  /** False when the action was refused (nothing to download or install, another action runs). */
  accepted: z.boolean(),
  /** True when the download finished; an install that runs quits the app instead. */
  completed: z.boolean(),
  state: DesktopUpdateState,
});
export type DesktopUpdateActionResult = z.output<typeof DesktopUpdateActionResult>;

/** The menus plugins add items to (D516). */
export const DesktopMenuName = z.enum(["file", "view", "help"]);
export type DesktopMenuName = z.output<typeof DesktopMenuName>;

/** An item of the application menu that runs a command in the web client. */
export const DesktopMenuContribution = z.object({
  /** Stable and dotted, like every contribution id: `acme.reports.open`. */
  id: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/),
  menu: DesktopMenuName,
  label: z.string().min(1).max(100),
  /** The client command the item runs, with an empty input. */
  command: z.string().min(1).max(200),
  /** An Electron accelerator, e.g. `CmdOrCtrl+Shift+R`. */
  accelerator: z.string().min(1).max(60).optional(),
});
export type DesktopMenuContribution = z.output<typeof DesktopMenuContribution>;

/** The app's badge: a count, and on Windows the overlay image drawn by the page (D518). */
export const DesktopNotificationBadge = z.object({
  count: z.number().int().min(0).max(2_147_483_647),
  image: z
    .string()
    .max(16_384)
    .regex(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i)
    .nullable(),
});
export type DesktopNotificationBadge = z.output<typeof DesktopNotificationBadge>;

/** T3's quit shortcut behaviour (D947): quit at once, hold ⌘/Ctrl+Q, or press it twice. */
export const QuitConfirmationMode = z.enum(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = z.output<typeof QuitConfirmationMode>;
export const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

/** The hint the app shows while the quit shortcut is down (T3's `QuitShortcutHintEvent`). */
export const QuitShortcutHintEvent = z.discriminatedUnion("state", [
  z.object({ state: z.literal("down"), mode: z.enum(["hold", "double-click"]) }),
  z.object({ state: z.literal("up") }),
]);
export type QuitShortcutHintEvent = z.output<typeof QuitShortcutHintEvent>;

type Unsubscribe = () => void;

/** A webview's page opened a window at an http(s) URL (D1323). */
export const DesktopPreviewOpenLink = z.object({
  webContentsId: z.number().int().positive(),
  url: z.string().max(2048),
});
export type DesktopPreviewOpenLink = z.output<typeof DesktopPreviewOpenLink>;

/** The preview's webviews in the app (docs/plans/desktop.md, D1322). */
export interface DesktopPreviewBridge {
  /**
   * Attaches the webview (its `getWebContentsId()`) and returns the loopback
   * CDP endpoint the node connects to.
   */
  attachWebview(webContentsId: number): Promise<{ endpoint: string }>;
  onOpenLink(listener: (link: DesktopPreviewOpenLink) => void): Unsubscribe;
  /** Forgets the cookies and storage of a preview partition. */
  clearPartition(partition: string): Promise<void>;
  /**
   * Opens the webview's DevTools detached, or focuses them; its guest's relay
   * ends meanwhile (D1489). Optional: an older app's bridge lacks it.
   */
  openDevTools?(webContentsId: number): Promise<void>;
  /** A webview's DevTools closed: its guest can be attached again (D1489). */
  onDevToolsClosed?(listener: (webContentsId: number) => void): Unsubscribe;
}

/** `window.jhinDesktop`, put there by the app's preload (D521). */
export interface DesktopBridge {
  readonly version: number;
  /** Node's `process.platform` of the app: `darwin`, `win32`, `linux`. */
  readonly platform: string;
  readonly appVersion: string;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdate(): Promise<DesktopUpdateCheckResult>;
  downloadUpdate(): Promise<DesktopUpdateActionResult>;
  installUpdate(): Promise<DesktopUpdateActionResult>;
  setUpdateChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): Unsubscribe;
  /** A menu item asks the page to run a command. */
  onMenuCommand(listener: (command: string) => void): Unsubscribe;
  /** Replaces every item plugins add to the application menu. */
  setMenuContributions(items: readonly DesktopMenuContribution[]): void;
  setNotificationBadge(badge: DesktopNotificationBadge): void;
  getWindowFullscreen(): Promise<boolean>;
  onWindowFullscreen(listener: (fullscreen: boolean) => void): Unsubscribe;
  /**
   * Pastes the clipboard into the focused element of the window (T3's Paste as
   * Text, D946). Optional: an older app's bridge lacks it.
   */
  pasteAsText?(): Promise<void>;
  /** The quit shortcut's behaviour, kept in the app's data folder (D947). */
  getQuitShortcut?(): Promise<QuitConfirmationMode>;
  setQuitShortcut?(mode: QuitConfirmationMode): Promise<QuitConfirmationMode>;
  /** The quit shortcut is pressed or released, for T3's hint. */
  onQuitShortcut?(listener: (hint: QuitShortcutHintEvent) => void): Unsubscribe;
  /** The preview's webviews (D1322). Optional: an older app's bridge lacks it. */
  readonly preview?: DesktopPreviewBridge;
}

/** `desktop.shell@1`: the app, for client plugins. */
export interface DesktopShell {
  readonly platform: string;
  readonly appVersion: string;
  readonly updates: {
    /** The last state the app reported. */
    state(): DesktopUpdateState;
    subscribe(listener: () => void): Disposable;
  };
  readonly menu: {
    /** Adds an item to the application menu until disposed. */
    contribute(item: DesktopMenuContribution): Disposable;
  };
  /**
   * Since 1.1: the preview's webviews, when the app has them (D1322). The
   * `<webview>` tag works in the app's page only.
   */
  readonly preview?: {
    attachWebview(webContentsId: number): Promise<{ endpoint: string }>;
    onOpenLink(listener: (link: DesktopPreviewOpenLink) => void): Disposable;
    clearPartition(partition: string): Promise<void>;
    /** Since 1.2: a webview's DevTools, detached (D1489). */
    openDevTools?(webContentsId: number): Promise<void>;
    /** Since 1.2: a webview's DevTools closed (D1489). */
    onDevToolsClosed?(listener: (webContentsId: number) => void): Disposable;
  };
}
