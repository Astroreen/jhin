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
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DEFAULT_QUIT_CONFIRMATION_MODE,
  DESKTOP_CHANNELS,
  DesktopMenuContribution,
  DesktopNotificationBadge,
  DesktopUpdateChannel,
  QuitConfirmationMode,
} from "@jhin/desktop-api";
import { z } from "@jhin/sdk";

import { findRunningNode } from "@jhin/node-host/running";

import {
  attachRunningNode,
  cliEntry,
  freePortAbove,
  localNodeHome,
  startLocalNode,
  startOnFreePort,
  watchAttachedNode,
  type AttachedNode,
  type RunningLocalNode,
} from "./local-node.ts";
import { buildApplicationMenu, type ContentsCommand, type ZoomDirection } from "./menu.ts";
import { createSettingsStore } from "./settings.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updates/channels.ts";
import { UpdateController } from "./updates/controller.ts";
import { createElectronUpdater, hasPackagedFeed } from "./updates/electron-updater.ts";
import { NodeRestarter } from "./node-restart.ts";
import { makeQuitShortcutHandler } from "./quit-hold.ts";
import { createMainWindow, loadNode, syncWindowAppearance, zoomMainWindow } from "./window.ts";
import { createWebviewHost } from "./preview/webview-host.ts";

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
  cli: cliEntry(require.resolve("jhin-ai/package.json")),
  plugin: Path.dirname(require.resolve("@jhin/plugin-desktop/package.json")),
};

let mainWindow: BrowserWindow | undefined;
let node: RunningLocalNode | undefined;
/** The node being started, so quitting meanwhile can wait for it and stop it. */
let starting: Promise<RunningLocalNode> | undefined;
/** The node the window shows: the last started, kept while `node` is cleared to quit, or an attached one. */
let shownNode: { readonly url: string; readonly token: string } | undefined;
/** A node of the home that already ran when the app started; never the app's to stop (D1486). */
let attached: AttachedNode | undefined;
let nodeOrigin: string | undefined;
let quitting = false;
/** `startNode` runs, its Try Again dialog included: a restart leaves the node to it (D1201). */
let startingInDialog = false;
/** A quit stops the node; a second quit meanwhile waits for it. */
let stoppingNode = false;
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

/** Messages held while the page loads, sent in order by one `did-finish-load` listener. */
const held: { window: BrowserWindow; channel: string; value: unknown }[] = [];
function sendToPage(channel: string, value: unknown): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  if (!window.webContents.isLoadingMainFrame()) {
    window.webContents.send(channel, value);
    return;
  }
  if (!held.some((message) => message.window === window)) {
    window.webContents.once("did-finish-load", () => {
      for (const message of held.splice(0)) {
        if (!message.window.isDestroyed())
          message.window.webContents.send(message.channel, message.value);
      }
    });
  }
  held.push({ window, channel, value });
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
  const quitShortcutMode = () => settings.get().quitShortcut ?? DEFAULT_QUIT_CONFIRMATION_MODE;
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
      restarter.resume();
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
  // Synchronous and read before the page has an origin, so only the window is checked (D521).
  ipcMain.on(DESKTOP_CHANNELS.getAppInfo, (event) => {
    event.returnValue =
      mainWindow !== undefined && event.sender === mainWindow.webContents
        ? { platform: process.platform, appVersion: app.getVersion() }
        : null;
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
  handle(DESKTOP_CHANNELS.quitShortcutGet, none, () => quitShortcutMode());
  handle(DESKTOP_CHANNELS.quitShortcutSet, QuitConfirmationMode, (quitShortcut) => {
    settings.update({ quitShortcut });
    return quitShortcutMode();
  });
  // T3's pasteAsText: the page armed its composer first, then asks for the paste (D946).
  handle(DESKTOP_CHANNELS.pasteAsText, none, () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return;
    // The focused page of the window, else its own page (no focus, or the
    // developer tools have it); `handle` answers the main window's page only.
    const focused = webContents.getFocusedWebContents();
    const target =
      focused !== null && BrowserWindow.fromWebContents(focused) === mainWindow
        ? focused
        : mainWindow.webContents;
    target.paste();
  });
  on(DESKTOP_CHANNELS.setMenuContributions, z.array(DesktopMenuContribution).max(200), (items) => {
    const previous = menuContributions;
    menuContributions = items;
    try {
      setMenu();
    } catch (error) {
      // An accelerator Electron does not accept: keep the menu that worked.
      menuContributions = previous;
      setMenu();
      log("menu items refused", { error: String(error) });
    }
  });
  on(DESKTOP_CHANNELS.setNotificationBadge, DesktopNotificationBadge, applyBadge);
  // The preview's webviews, driven by the node (D1322).
  const webviews = createWebviewHost({
    openLink: (link) => sendToPage(DESKTOP_CHANNELS.previewOpenLink, link),
    devToolsClosed: (webContentsId) =>
      sendToPage(DESKTOP_CHANNELS.previewDevToolsClosed, webContentsId),
    log,
  });
  handle(DESKTOP_CHANNELS.previewAttach, z.number().int().positive(), (webContentsId) => {
    // `handle` answers the main window only; a window closed meanwhile has no webviews.
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      throw new Error("The app's window is closed.");
    }
    return webviews.attach(mainWindow.webContents, webContentsId);
  });
  handle(DESKTOP_CHANNELS.previewOpenDevTools, z.number().int().positive(), (webContentsId) => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      throw new Error("The app's window is closed.");
    }
    webviews.openDevTools(mainWindow.webContents, webContentsId);
  });
  handle(DESKTOP_CHANNELS.previewClearPartition, z.string().max(400), (partition) =>
    webviews.clearPartition(partition),
  );
  app.on("will-quit", () => webviews.dispose());
  const clearBadge = () => applyBadge({ count: 0, image: null });
  app.on("browser-window-focus", clearBadge);

  nativeTheme.on("updated", () => {
    for (const window of BrowserWindow.getAllWindows())
      syncWindowAppearance(window, process.platform);
  });

  // --- The local node and the window (D512, D513). ---
  const home = localNodeHome();
  /** The node on its port, or another when that is taken by something else (D1487). */
  const startOnFreePortNow = () =>
    startOnFreePort({
      kept: settings.get().nodePort,
      start: (port) => startLocalNode(nodePaths, home, undefined, port),
      running: () => findRunningNode(home),
      freePortAbove,
      keep: (nodePort) => settings.update({ nodePort }),
      quitting: () => quitting,
      log,
    });
  /** Starts the node once and makes it the app's; rejects when it did not come up. */
  async function launchNode(): Promise<RunningLocalNode> {
    try {
      starting = startOnFreePortNow();
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
      started.onExit((output) => nodeStopped(output));
      log("local node running", { url: started.url, home: started.home });
      return started;
    } catch (error) {
      starting = undefined;
      if (quitting) app.quit();
      throw error;
    }
  }
  /** Starts the node, asking to try again or quit while it fails (D512). */
  async function startNode(): Promise<RunningLocalNode> {
    startingInDialog = true;
    try {
      return await startNodeAsking();
    } finally {
      startingInDialog = false;
    }
  }
  /** The node of the home that already runs, asking to try again or quit while it cannot be shown (D1486). */
  async function attachAsking(): Promise<AttachedNode | undefined> {
    for (;;) {
      try {
        return await attachRunningNode(home);
      } catch (error) {
        const choice = await dialog.showMessageBox({
          type: "error",
          title: "The node of this home cannot be shown",
          message: `${APP_NAME} could not show the node of its home.`,
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
  async function startNodeAsking(): Promise<RunningLocalNode> {
    for (;;) {
      try {
        return await launchNode();
      } catch (error) {
        if (quitting) throw error;
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
  // A node that exits by itself comes back with T3's backoff, no dialog (D1201).
  const restarter = new NodeRestarter({
    start: async () => {
      // Quitting, or another path (a failed update's restart, with its Try Again dialog)
      // brought the node back or is starting it: one node per home and port.
      if (quitting || node !== undefined || starting !== undefined || startingInDialog)
        return false;
      const restarted = await launchNode();
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) loadNode(mainWindow, restarted);
      return true;
    },
    log,
  });
  function nodeStopped(output: string): void {
    if (quitting) return;
    node = undefined;
    // What D512's dialog showed goes to the app's log, so a node that keeps dying says why.
    const tail = output.trim().split("\n").slice(-20);
    log("local node exited", { output: tail.join("\n") });
    restarter.exited(tail.at(-1) || "exited");
  }
  /** Starts the node again and points the window at it: it may listen elsewhere now. */
  async function restartNodeInWindow(): Promise<void> {
    const restarted = await startNode();
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) loadNode(mainWindow, restarted);
  }
  const openWindow = () => {
    // A node being restarted still has a window: it loads the new node once it is up (D1201).
    if (shownNode === undefined) return;
    mainWindow = createMainWindow({
      title: APP_NAME,
      platform: process.platform,
      preload: Path.join(import.meta.dirname, "preload.cjs"),
      icon: undefined,
      node: () => shownNode!,
      // An attached node serves no jhin.desktop, whose insets T3's chrome needs (D1486).
      chrome: attached === undefined ? "t3" : "system",
      settings,
      log,
      webviews,
    });
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
    // T3's quit hold (D947): ⌘/Ctrl+Q quits as the setting says, with T3's hint.
    const window = mainWindow;
    const quitShortcut = makeQuitShortcutHandler({
      platform: process.platform,
      getMode: () => Promise.resolve(quitShortcutMode()),
      notify: (hint) => {
        if (!window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.quitShortcut, hint);
      },
      // Hidden until the keys are released, so their repeats cannot reach the next app.
      concealWindow: () => {
        if (window.isDestroyed()) return;
        if (window.isFullScreen()) window.setFullScreen(false);
        window.setOpacity(0);
      },
      quit: () => app.quit(),
    });
    window.webContents.on("before-input-event", (event, input) => quitShortcut(event, input));
  };

  // Quitting stops the node first and waits for it (D522).
  app.on("before-quit", (event) => {
    // Whatever runs (a restart dialog, a start in flight) stops from here on.
    quitting = true;
    clearBadge();
    updates.stop();
    restarter.stop();
    if (node === undefined) {
      // Still starting (startNode stops it once up, then quits), or a stop runs
      // that quits when it is done: either way the node is not left behind (D522).
      if (starting !== undefined || stoppingNode) event.preventDefault();
      return;
    }
    event.preventDefault();
    const stopping = node;
    node = undefined;
    stoppingNode = true;
    void stopping.stop().finally(() => {
      stoppingNode = false;
      app.quit();
    });
  });
  try {
    attached = await attachAsking();
    if (attached === undefined) await startNode();
  } catch {
    return;
  }
  if (attached !== undefined) {
    shownNode = attached;
    nodeOrigin = new URL(attached.url).origin;
    log("showing the node of this home that already runs", {
      url: attached.url,
      pid: attached.pid,
    });
    // Once it stops, the app starts again with a node of its own (D1486).
    const stopWatching = watchAttachedNode(attached, () => {
      if (quitting) return;
      log("the attached node stopped; relaunching with the app's own node", { pid: attached!.pid });
      app.relaunch();
      app.quit();
    });
    app.on("before-quit", stopWatching);
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
