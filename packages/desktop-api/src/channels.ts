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
  pasteAsText: "jhin-desktop:paste-as-text",
  quitShortcutGet: "jhin-desktop:quit-shortcut-get",
  quitShortcutSet: "jhin-desktop:quit-shortcut-set",
  /** Main to page: the quit shortcut is pressed or released (T3's QuitHold hint). */
  quitShortcut: "jhin-desktop:quit-shortcut",
  /** Attaches the node to a webview of the page (D1322). */
  previewAttach: "jhin-desktop:preview-attach",
  /** Main to page: a webview's page opened a window (D1323). */
  previewOpenLink: "jhin-desktop:preview-open-link",
  previewClearPartition: "jhin-desktop:preview-clear-partition",
  /** Opens a webview's DevTools in a window of their own (D1489). */
  previewOpenDevTools: "jhin-desktop:preview-open-devtools",
  /** Main to page: a webview's DevTools closed, its guest may be attached again (D1489). */
  previewDevToolsClosed: "jhin-desktop:preview-devtools-closed",
} as const;
