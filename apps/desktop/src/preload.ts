// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preload.ts.
// Built into one CommonJS file: a sandboxed preload can require nothing but `electron` (D511).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { DesktopBridge } from "@jhin/desktop-api";
import { DESKTOP_BRIDGE_VERSION, DESKTOP_CHANNELS } from "@jhin/desktop-api/channels";

/** Subscribes to a channel the main process sends on; returns the unsubscribe. */
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** Read once from the main process when the page starts. */
const info = ipcRenderer.sendSync(DESKTOP_CHANNELS.getAppInfo) as {
  platform: string;
  appVersion: string;
} | null;
// Anything but the app's window gets no bridge.
if (info === null) throw new Error("The desktop bridge is only for the app's window");
const { platform, appVersion } = info;

const bridge: DesktopBridge = {
  version: DESKTOP_BRIDGE_VERSION,
  platform,
  appVersion,
  getUpdateState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updateGetState),
  checkForUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updateDownload),
  installUpdate: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updateInstall),
  setUpdateChannel: (channel) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateSetChannel, channel),
  onUpdateState: (listener) => listen(DESKTOP_CHANNELS.updateState, listener),
  onMenuCommand: (listener) => listen(DESKTOP_CHANNELS.menuCommand, listener),
  setMenuContributions: (items) => ipcRenderer.send(DESKTOP_CHANNELS.setMenuContributions, items),
  setNotificationBadge: (badge) => ipcRenderer.send(DESKTOP_CHANNELS.setNotificationBadge, badge),
  getWindowFullscreen: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getWindowFullscreen),
  pasteAsText: () => ipcRenderer.invoke(DESKTOP_CHANNELS.pasteAsText),
  getQuitShortcut: () => ipcRenderer.invoke(DESKTOP_CHANNELS.quitShortcutGet),
  setQuitShortcut: (mode) => ipcRenderer.invoke(DESKTOP_CHANNELS.quitShortcutSet, mode),
  onQuitShortcut: (listener) => listen(DESKTOP_CHANNELS.quitShortcut, listener),
  onWindowFullscreen: (listener) => listen(DESKTOP_CHANNELS.windowFullscreen, listener),
  preview: {
    attachWebview: (webContentsId) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.previewAttach, webContentsId),
    onOpenLink: (listener) => listen(DESKTOP_CHANNELS.previewOpenLink, listener),
    clearPartition: (partition) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.previewClearPartition, partition),
  },
};

contextBridge.exposeInMainWorld("jhinDesktop", bridge);
