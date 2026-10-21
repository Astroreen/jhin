// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/ipc/channels.ts.

/** The bridge's version; the plugin refuses a bridge it does not know (D521). */
export const DESKTOP_BRIDGE_VERSION = 1;

/** IPC channels between the preload and the main process (D521). */
export const DESKTOP_CHANNELS = {
  /** Synchronous: the platform and version the preload puts on the bridge. */
  getAppInfo: "jhin-desktop:get-app-info",
  updateGetState: "jhin-desktop:update-get-state",
  updateState: "jhin-desktop:update-state",
  updateCheck: "jhin-desktop:update-check",
  updateDownload: "jhin-desktop:update-download",
  updateInstall: "jhin-desktop:update-install",
  updateSetChannel: "jhin-desktop:update-set-channel",
  menuCommand: "jhin-desktop:menu-command",
  setMenuContributions: "jhin-desktop:set-menu-contributions",
  setNotificationBadge: "jhin-desktop:set-notification-badge",
  getWindowFullscreen: "jhin-desktop:get-window-fullscreen",
  windowFullscreen: "jhin-desktop:window-fullscreen",
} as const;
