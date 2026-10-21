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

/** T3 Code's update state, without its release notes and CPU architectures (Deferred). */
export const DesktopUpdateState = z.object({
  enabled: z.boolean(),
  status: DesktopUpdateStatus,
  channel: DesktopUpdateChannel,
  currentVersion: z.string(),
  availableVersion: z.string().nullable(),
  downloadedVersion: z.string().nullable(),
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

type Unsubscribe = () => void;

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
}
