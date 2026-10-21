// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/electron/ElectronUpdater.ts
// and the updater configuration of apps/desktop/src/updates/DesktopUpdates.ts.
import * as Fs from "node:fs";
import * as Path from "node:path";

import updaterModule from "electron-updater";

import type { Updater } from "./controller.ts";

const { autoUpdater } = updaterModule;

/**
 * electron-updater as the controller's `Updater` (D519). A packaged app reads
 * its feed (this repository's GitHub releases) from `app-update.yml`;
 * `feedUrl` (`JHIN_DESKTOP_UPDATE_FEED`) points it at a generic feed instead,
 * also in a build that is not packaged, as T3's mock updates do.
 */
export function createElectronUpdater(options: {
  readonly feedUrl: string | undefined;
  /** Where the generic feed's config is written. */
  readonly userData: string;
}): Updater {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  if (options.feedUrl !== undefined) {
    const config = Path.join(options.userData, "feed-update.yml");
    Fs.writeFileSync(
      config,
      `provider: generic\nurl: ${JSON.stringify(options.feedUrl)}\nupdaterCacheDirName: jhin-desktop-updater\n`,
    );
    autoUpdater.updateConfigPath = config;
    autoUpdater.forceDevUpdateConfig = true;
    // Outside an AppImage there is no old file to patch: download whole files.
    autoUpdater.disableDifferentialDownload = true;
  }
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable === true ? { version: result.updateInfo.version } : null;
    },
    async download(onProgress) {
      const progress = (info: { percent: number }) => onProgress(info.percent);
      autoUpdater.on("download-progress", progress);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off("download-progress", progress);
      }
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall(true, true);
    },
    setChannel(channel) {
      // Setting the channel also allows downgrades; only a switch of track may go back (D519).
      const allowDowngrade = autoUpdater.allowDowngrade;
      autoUpdater.channel = channel;
      autoUpdater.allowDowngrade = allowDowngrade;
      autoUpdater.allowPrerelease = channel === "nightly";
    },
    setAllowDowngrade(allow) {
      autoUpdater.allowDowngrade = allow;
    },
    onError(listener) {
      autoUpdater.on("error", listener);
    },
  };
}

/** True when the app runs from a feed of its own: a packaged `app-update.yml`. */
export function hasPackagedFeed(resourcesPath: string): boolean {
  return Fs.existsSync(Path.join(resourcesPath, "app-update.yml"));
}
