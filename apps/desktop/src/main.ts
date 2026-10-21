// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/main.ts, app/DesktopApp.ts,
// app/DesktopLifecycle.ts, window/DesktopApplicationMenu.ts (the update dialogs) and
// ipc/methods/notificationBadge.ts.
import * as Module from "node:module";
import * as Path from "node:path";

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DESKTOP_CHANNELS,
  DesktopMenuContribution,
  DesktopNotificationBadge,
  DesktopUpdateChannel,
} from "@jhin/desktop-api";
import { z } from "@jhin/sdk";

import { startLocalNode, type RunningLocalNode } from "./local-node.ts";
import { buildApplicationMenu, type ContentsCommand, type ZoomDirection } from "./menu.ts";
import { createSettingsStore } from "./settings.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updates/channels.ts";
import { UpdateController } from "./updates/controller.ts";
import { createElectronUpdater, hasPackagedFeed } from "./updates/electron-updater.ts";
import { createMainWindow, loadNode, syncWindowAppearance, zoomMainWindow } from "./window.ts";

const APP_NAME = "Jhin";
const require = Module.createRequire(import.meta.url);

function log(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(
    `[jhin-desktop] ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}\n`,
  );
}

// Tests and portable installs keep the app's data elsewhere.
const userDataOverride = process.env["JHIN_DESKTOP_USER_DATA"];
if (userDataOverride !== undefined) app.setPath("userData", userDataOverride);
app.setName(APP_NAME);

/** The CLI and the client plugin the app's node runs with (D512, D514). */
const nodePaths = {
  cli: Path.join(Path.dirname(require.resolve("jhin-ai/package.json")), "bin", "jhin.js"),
  plugin: Path.dirname(require.resolve("@jhin/plugin-desktop/package.json")),
};

let mainWindow: BrowserWindow | undefined;
let node: RunningLocalNode | undefined;
/** The node being started, so quitting meanwhile can wait for it and stop it. */
let starting: Promise<RunningLocalNode> | undefined;
/** The node last started, which the window shows; kept while `node` is cleared to quit. */
let shownNode: RunningLocalNode | undefined;
let nodeOrigin: string | undefined;
let quitting = false;
let menuContributions: DesktopMenuContribution[] = [];

/** One app at a time: a second launch shows the running one's window (D522). */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => reveal(mainWindow));
  void app.whenReady().then(main);
}

function reveal(window: BrowserWindow | undefined): void {
  if (window === undefined || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Only the main window's top frame, on the node's origin, may use the bridge (D521). */
function fromMainWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === mainWindow.webContents.mainFrame &&
    URL.canParse(frame.url) &&
    new URL(frame.url).origin === nodeOrigin
  );
}

function handle<T>(channel: string, input: z.ZodType<T>, handler: (value: T) => unknown): void {
  ipcMain.handle(channel, (event, raw: unknown) => {
    if (!fromMainWindow(event)) throw new Error(`${channel} is only answered to the app's window`);
    return handler(input.parse(raw));
  });
}

function on<T>(channel: string, input: z.ZodType<T>, handler: (value: T) => void): void {
  ipcMain.on(channel, (event, raw: unknown) => {
    if (!fromMainWindow(event)) return;
    const parsed = input.safeParse(raw);
    if (parsed.success) handler(parsed.data);
    else log("bridge message refused", { channel, error: parsed.error.message });
  });
}

/** Sends to the page once it loaded; `menuCommand` also brings the window up (T3). */
function sendToPage(channel: string, value: unknown): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
  else send();
}

/** The badge (D518): a count on macOS and Linux, T3's drawn overlay on Windows; none while focused. */
function applyBadge({ count, image }: DesktopNotificationBadge): void {
  if (BrowserWindow.getFocusedWindow() !== null) count = 0;
  try {
    if (process.platform === "win32") {
      const overlay = count > 0 && image !== null ? nativeImage.createFromDataURL(image) : null;
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.setOverlayIcon(
          overlay === null || overlay.isEmpty() ? null : overlay,
          count > 0 ? `${count} threads with new notifications` : "",
        );
      }
    } else {
      app.setBadgeCount(count);
    }
  } catch (error) {
    log("could not update the notification badge", { error: String(error) });
  }
}

async function main(): Promise<void> {
  const settings = createSettingsStore(app.getPath("userData"));
  // The test feed is for builds that are not packaged: a packaged app updates from its own feed only.
  const feedUrl = app.isPackaged ? undefined : process.env["JHIN_DESKTOP_UPDATE_FEED"];
  const environment = {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env["APPIMAGE"],
    // Telling a .deb install apart is Deferred with packaging (docs/plans/desktop.md).
    isDebPackage: false,
    disabledByEnv: (process.env["JHIN_DISABLE_AUTO_UPDATE"] ?? "") !== "",
    hasFeed: feedUrl !== undefined || hasPackagedFeed(process.resourcesPath),
    feedOverride: feedUrl !== undefined,
  };
  const updates = new UpdateController({
    updater: createElectronUpdater({ feedUrl, userData: app.getPath("userData") }),
    environment,
    channel:
      settings.get().updateChannel ?? resolveDefaultDesktopUpdateChannel(environment.appVersion),
    persistChannel: (updateChannel) => settings.update({ updateChannel }),
    beforeInstall: async () => {
      quitting = true;
      const stopping = node;
      node = undefined;
      await stopping?.stop();
    },
    afterFailedInstall: async () => {
      quitting = false;
      await restartNodeInWindow();
    },
    log,
  });
  updates.onState((state) => sendToPage(DESKTOP_CHANNELS.updateState, state));

  // --- The application menu (D516). ---
  const checkForUpdatesFromMenu = async () => {
    const reason = updates.disabledReason;
    if (reason !== null) {
      await dialog.showMessageBox({
        type: "info",
        title: "Updates unavailable",
        message: "Automatic updates are not available right now.",
        detail: reason,
        buttons: ["OK"],
      });
      return;
    }
    reveal(mainWindow);
    const { state } = await updates.check("menu");
    if (state.status === "up-to-date") {
      await dialog.showMessageBox({
        type: "info",
        title: "You're up to date!",
        message: `${APP_NAME} ${state.currentVersion} is currently the newest version available.`,
        buttons: ["OK"],
      });
    } else if (state.status === "error") {
      await dialog.showMessageBox({
        type: "warning",
        title: "Update check failed",
        message: "Could not check for updates.",
        detail: state.message ?? "An unknown error occurred. Please try again later.",
        buttons: ["OK"],
      });
    }
  };
  const setMenu = () =>
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenu({
          platform: process.platform,
          appName: APP_NAME,
          contributions: menuContributions,
          handlers: {
            checkForUpdates: () =>
              void checkForUpdatesFromMenu().catch((error: unknown) =>
                log("menu update check failed", { error: String(error) }),
              ),
            runCommand: (command) => {
              sendToPage(DESKTOP_CHANNELS.menuCommand, command);
              reveal(mainWindow);
            },
            zoom: (direction: ZoomDirection) => {
              if (mainWindow !== undefined) zoomMainWindow(mainWindow, direction, process.platform);
            },
            contents: (command: ContentsCommand) => {
              const contents = mainWindow?.webContents;
              if (contents === undefined || contents.isDestroyed()) return;
              if (command === "reload") contents.reload();
              else if (command === "forceReload") contents.reloadIgnoringCache();
              else contents.toggleDevTools();
            },
          },
        }),
      ),
    );
  setMenu();

  // --- The bridge (D521). ---
  ipcMain.on(DESKTOP_CHANNELS.getAppInfo, (event) => {
    event.returnValue = { platform: process.platform, appVersion: app.getVersion() };
  });
  const none = z.undefined();
  handle(DESKTOP_CHANNELS.updateGetState, none, () => updates.state);
  handle(DESKTOP_CHANNELS.updateCheck, none, () => updates.check("renderer"));
  handle(DESKTOP_CHANNELS.updateDownload, none, () => updates.download());
  handle(DESKTOP_CHANNELS.updateInstall, none, () => updates.install());
  handle(DESKTOP_CHANNELS.updateSetChannel, DesktopUpdateChannel, (channel) =>
    updates.setChannel(channel),
  );
  handle(DESKTOP_CHANNELS.getWindowFullscreen, none, () => mainWindow?.isFullScreen() ?? false);
  on(DESKTOP_CHANNELS.setMenuContributions, z.array(DesktopMenuContribution).max(200), (items) => {
    menuContributions = items;
    setMenu();
  });
  on(DESKTOP_CHANNELS.setNotificationBadge, DesktopNotificationBadge, applyBadge);
  const clearBadge = () => applyBadge({ count: 0, image: null });
  app.on("browser-window-focus", clearBadge);

  nativeTheme.on("updated", () => {
    for (const window of BrowserWindow.getAllWindows())
      syncWindowAppearance(window, process.platform);
  });

  // --- The local node and the window (D512, D513). ---
  async function startNode(): Promise<RunningLocalNode> {
    for (;;) {
      try {
        starting = startLocalNode(nodePaths);
        const started = await starting;
        starting = undefined;
        if (quitting) {
          // The app quit while the node started: stop it rather than leave it running.
          await started.stop();
          app.quit();
          throw new Error("The app quit while its local node started.");
        }
        node = started;
        shownNode = started;
        nodeOrigin = new URL(started.url).origin;
        started.onExit(
          (output) =>
            void nodeStopped(output).catch((error: unknown) =>
              // The user chose Quit after a restart failed: the app is quitting.
              log("local node not restarted", { error: String(error) }),
            ),
        );
        log("local node running", { url: started.url, home: started.home });
        return started;
      } catch (error) {
        starting = undefined;
        if (quitting) {
          app.quit();
          throw error;
        }
        const choice = await dialog.showMessageBox({
          type: "error",
          title: "The local node did not start",
          message: `${APP_NAME} could not start its local node.`,
          detail: error instanceof Error ? error.message : String(error),
          buttons: ["Try Again", "Quit"],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice.response !== 0) {
          quitting = true;
          app.quit();
          throw error;
        }
      }
    }
  }
  async function nodeStopped(output: string): Promise<void> {
    if (quitting) return;
    node = undefined;
    const choice = await dialog.showMessageBox({
      type: "error",
      title: "The local node stopped",
      message: `${APP_NAME}'s local node stopped unexpectedly.`,
      detail: output.trim().split("\n").slice(-20).join("\n"),
      buttons: ["Restart", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      quitting = true;
      app.quit();
      return;
    }
    await restartNodeInWindow();
  }
  /** Starts the node again and points the window at it: it may listen elsewhere now. */
  async function restartNodeInWindow(): Promise<void> {
    const restarted = await startNode();
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) loadNode(mainWindow, restarted);
  }
  const openWindow = () => {
    if (node === undefined) return;
    mainWindow = createMainWindow({
      title: APP_NAME,
      platform: process.platform,
      preload: Path.join(import.meta.dirname, "preload.cjs"),
      icon: undefined,
      node: () => shownNode!,
      settings,
      log,
    });
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  };

  // Quitting stops the node first and waits for it (D522).
  app.on("before-quit", (event) => {
    clearBadge();
    updates.stop();
    if (node === undefined) {
      // Still starting: startNode stops the node once it is up, then quits (D522).
      if (starting !== undefined) {
        event.preventDefault();
        quitting = true;
      }
      return;
    }
    event.preventDefault();
    quitting = true;
    const stopping = node;
    node = undefined;
    void stopping.stop().finally(() => app.quit());
  });
  try {
    await startNode();
  } catch {
    return;
  }
  openWindow();
  updates.start();

  app.on("activate", () => {
    if (mainWindow === undefined) openWindow();
    else reveal(mainWindow);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
