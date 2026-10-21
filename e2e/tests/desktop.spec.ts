import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Module from "node:module";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";

import { writeConfig } from "./support/node.ts";

// The desktop app (docs/plans/desktop.md, D523), built by `pnpm e2e`. On Linux,
// Electron needs a display: CI runs the suite under xvfb-run.
const APP = Path.resolve(import.meta.dirname, "../../apps/desktop");
const ELECTRON = Module.createRequire(Path.join(APP, "package.json"))("electron") as string;

// A local run without a display skips these (run them under `xvfb-run`); CI never does.
test.skip(
  process.platform === "linux" &&
    process.env["CI"] === undefined &&
    process.env["DISPLAY"] === undefined &&
    process.env["WAYLAND_DISPLAY"] === undefined,
  "Electron needs a display: run under xvfb-run -a",
);

interface Launched {
  readonly app: ElectronApplication;
  readonly window: Page;
  readonly home: string;
}

let launched: Launched | undefined;
let rpc: RpcClient | undefined;
let feed: Http.Server | undefined;
test.afterEach(async () => {
  rpc?.close();
  rpc = undefined;
  await launched?.app.close();
  launched = undefined;
  await new Promise((resolve) => (feed === undefined ? resolve(undefined) : feed.close(resolve)));
  feed = undefined;
});

const temporary = (name: string) => Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-desktop-${name}-`));

/** Starts the app in a fresh home (free port, fake agent) and data folder. */
async function launch(
  env: Record<string, string> = {},
  setup?: (home: string) => void,
): Promise<Launched> {
  const home = temporary("home");
  writeConfig(home, {});
  setup?.(home);
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [APP],
    env: {
      ...process.env,
      JHIN_HOME: home,
      JHIN_DESKTOP_USER_DATA: temporary("data"),
      // electron-updater keeps downloads under the cache folder.
      XDG_CACHE_HOME: temporary("cache"),
      ...env,
    },
  });
  const window = await app.firstWindow();
  launched = { app, window, home };
  // The client is up once the desktop plugin marked the page as the app's.
  await expect(window.locator("html.electron")).toHaveCount(1);
  return launched;
}

/** The node the app started, over RPC, with the token from its home. */
function nodeClient({ home, window }: Launched): RpcClient {
  const token = Fs.readFileSync(Path.join(home, "data", "jhin.auth-token", "token"), "utf8").trim();
  const url = `${new URL(window.url()).origin.replace(/^http/, "ws")}/rpc`;
  rpc = createRpcClient({ connect: () => connectWebSocket(url, token) });
  return rpc;
}

/** A generic update feed (T3's mock updates) offering `version` with a small payload. */
async function serveFeed(version: string): Promise<string> {
  const payload = Buffer.from(`Jhin ${version} for the update test\n`);
  const sha512 = Crypto.createHash("sha512").update(payload).digest("base64");
  const file = `Jhin-${version}.AppImage`;
  const yml = [
    `version: ${version}`,
    "files:",
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${payload.length}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-20T00:00:00.000Z'",
    "",
  ].join("\n");
  feed = Http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (/^\/latest-linux(-arm64)?\.yml$/.test(path)) response.end(yml);
    else if (path === `/${file}`) response.end(payload);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => feed!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
}

test("the app runs its node and shows the web client in T3's frameless window", async () => {
  const { app, window } = await launch();

  await expect(window.getByRole("button", { name: "Go to threads" })).toBeVisible();
  expect(await window.title()).toBe("Jhin");
  const shell = await app.evaluate(({ BrowserWindow }) => {
    const [main] = BrowserWindow.getAllWindows();
    return { title: main!.getTitle(), minimum: main!.getMinimumSize() };
  });
  expect(shell).toEqual({ title: "Jhin", minimum: [840, 620] });

  // The desktop plugin runs from the app's node; the window controls overlay is up (D515).
  const plugin = await window.evaluate(
    () =>
      (
        window as unknown as {
          jhin: { kernel: { inspect(): { plugins: { id: string; status: string }[] } } };
        }
      ).jhin.kernel
        .inspect()
        .plugins.find((candidate) => candidate.id === "jhin.desktop")?.status,
  );
  expect(plugin).toBe("active");
  await expect(window.locator("html.wco")).toHaveCount(1);
  // The sidebar's top bar drags the window; its buttons do not.
  const regions = await window.evaluate(() => {
    const region = (element: Element | null) =>
      element === null ? null : getComputedStyle(element).getPropertyValue("-webkit-app-region");
    const brand = document.querySelector('[aria-label="Go to threads"]');
    return { bar: region(brand?.closest(".drag-region") ?? null), button: region(brand) };
  });
  expect(regions).toEqual({ bar: "drag", button: "no-drag" });
  await test.info().attach("window", { body: await window.screenshot(), contentType: "image/png" });
});

/**
 * A user client plugin that adds an item to the View menu through
 * `desktop.shell@1`, as a plain ES module (D16).
 */
function writeMenuPlugin(home: string): void {
  const root = Path.join(home, "plugins", "acme-menu");
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: "acme-menu",
      type: "module",
      jhin: {
        id: "acme.menu",
        version: "1.0.0",
        apiVersion: 1,
        side: "client",
        requires: { "desktop.shell": "^1" },
        entry: "index.js",
      },
    }),
  );
  Fs.writeFileSync(
    Path.join(root, "index.js"),
    `import { definePlugin } from "@jhin/sdk";

export default definePlugin({
  activate(context) {
    const shell = context.services.get("desktop.shell");
    context.subscriptions.add(
      shell.menu.contribute({
        id: "acme.palette",
        menu: "view",
        label: "Command Palette",
        command: "palette.toggle",
      }),
    );
  },
});
`,
  );
}

test("the native menus are T3's, and Settings... opens the settings with the About section", async () => {
  const { app, window } = await launch({}, writeMenuPlugin);

  const menus = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.items.map((item) => ({
      label: item.label,
      // T3's items: hidden keypad duplicates, separators and the user plugin's item left out.
      items: item.submenu?.items
        .filter((sub) => sub.visible && sub.type !== "separator" && sub.id !== "acme.palette")
        .map((sub) => sub.label),
    })),
  );
  expect(menus.map((menu) => menu.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
  expect(menus.find((menu) => menu.label === "File")?.items).toEqual(["Settings...", "Quit"]);
  expect(menus.find((menu) => menu.label === "View")?.items).toEqual([
    "Reload",
    "Force Reload",
    "Toggle Developer Tools",
    "Actual Size",
    "Zoom In",
    "Zoom Out",
    "Toggle Full Screen",
  ]);
  expect(menus.find((menu) => menu.label === "Help")?.items).toEqual(["Check for Updates..."]);

  // The menu item runs the web client's settings.open command (D516).
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById("jhin.settings")!.click(),
  );
  const breadcrumb = window.getByRole("navigation", { name: "Settings breadcrumb" });
  await expect(breadcrumb).toBeVisible();
  await window.getByRole("button", { name: "About" }).click();
  const about = window.getByRole("region", { name: "About" });
  await expect(about.getByText("Version", { exact: true })).toBeVisible();
  await expect(about.getByText("0.1.0")).toBeVisible();
  await expect(about.getByRole("combobox", { name: "Update track" })).toHaveText("Stable");
  // Not packaged and no feed: T3's reason, and the button cannot check.
  await expect(about.getByRole("button", { name: "Check for Updates" })).toBeDisabled();
  await test.info().attach("about", { body: await window.screenshot(), contentType: "image/png" });

  // The user plugin's menu item, with its stable id, runs its command (D516).
  // The item is there once the app rebuilt its menu from the page's message.
  const label = await app.evaluate(
    ({ Menu, ipcMain }) =>
      new Promise<string>((resolve) => {
        const check = () => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("acme.palette");
          if (item !== null && item !== undefined) resolve(item.label);
          else ipcMain.once("jhin-desktop:set-menu-contributions", () => setImmediate(check));
        };
        check();
      }),
  );
  expect(label).toBe("Command Palette");
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById("acme.palette")!.click(),
  );
  await expect(window.getByRole("dialog")).toBeVisible();
});

test("Paste as Text in the Edit menu keeps a large paste inline (D946)", async () => {
  const { app, window } = await launch();
  await window.getByRole("button", { name: "Start a thread" }).click();
  const message = window.getByRole("textbox", { name: "Message" });
  await message.focus();
  const large = "x".repeat(40 * 1024);
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), large);
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById("jhin.paste-as-text")!.click(),
  );
  // A plain paste would attach it as pasted-text.txt (D295); Paste as Text keeps it as text.
  await expect(message).toHaveText(large);
  await expect(window.getByText("Large paste attached as pasted-text.txt")).toHaveCount(0);
  await test
    .info()
    .attach("paste as text", { body: await window.screenshot(), contentType: "image/png" });
});

test("Ctrl+Q shows T3's hold hint, and the setting chooses the quit shortcut (D947)", async () => {
  const { app, window } = await launch();
  const press = (type: "keyDown" | "keyUp") =>
    app.evaluate(({ BrowserWindow }, inputType) => {
      BrowserWindow.getAllWindows()[0]!.webContents.sendInputEvent({
        type: inputType,
        keyCode: "Q",
        modifiers: ["control"],
      });
    }, type);

  // Hold (T3's default): a short press only shows the hint, and the app stays.
  await press("keyDown");
  const hint = window.getByRole("status").filter({ hasText: "Hold Ctrl+Q or press twice to quit" });
  await expect(hint).toBeVisible();
  const hintShot = test.info().outputPath("quit-hold-hint.png");
  await window.screenshot({ path: hintShot });
  await test.info().attach("quit hold hint", { path: hintShot, contentType: "image/png" });
  await press("keyUp");
  await expect(hint).toHaveCount(0);

  // The row in General → Behavior, T3's wording.
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById("jhin.settings")!.click(),
  );
  const shortcut = window.getByRole("combobox", { name: "Quit shortcut behavior" });
  await expect(shortcut).toHaveText("Hold");
  await shortcut.click();
  await window.getByRole("option", { name: "Double press" }).click();
  await expect(shortcut).toHaveText("Double press");
  const rowShot = test.info().outputPath("quit-shortcut-setting.png");
  await window.screenshot({ path: rowShot });
  await test.info().attach("quit shortcut setting", { path: rowShot, contentType: "image/png" });

  await press("keyDown");
  await expect(
    window.getByRole("status").filter({ hasText: "Press Ctrl+Q again to quit" }),
  ).toBeVisible();
  await press("keyUp");
});

test("a thread that completes in the background badges the app until a window gains focus", async () => {
  const launchedApp = await launch();
  const { app, window } = launchedApp;
  // xvfb has no window manager to move focus, and Linux shows a badge only in
  // some launchers: the test plays the window system. No window has focus, and
  // the badge counts are recorded; `badgeSeen` resolves once one matches.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const counts: number[] = [];
    const waiters: (() => void)[] = [];
    BrowserWindow.getFocusedWindow = () => null;
    electronApp.setBadgeCount = (count?: number) => {
      counts.push(count ?? 0);
      for (const waiter of waiters.splice(0)) waiter();
      return true;
    };
    Object.assign(globalThis, {
      badgeSeen: (accept: (counts: number[]) => boolean) =>
        new Promise<void>((resolve) => {
          const check = () => (accept(counts) ? resolve() : waiters.push(check));
          check();
        }),
    });
  });
  type BadgeGlobal = { badgeSeen(accept: (counts: number[]) => boolean): Promise<void> };
  await window.evaluate(() =>
    localStorage.setItem(
      "jhin.settings",
      JSON.stringify({ "jhin.notifications": { mode: "notifications" } }),
    ),
  );
  await window.reload();
  await expect(window.locator("html.electron")).toHaveCount(1);
  const client = nodeClient(launchedApp);
  const thread = await client.call<{ id: string; title: string }>("threads.create", {});
  await expect(window.getByText(thread.title).first()).toBeVisible();

  // The page is in the background: Playwright keeps pages focused, so say it is not.
  await window.evaluate(() => {
    document.hasFocus = () => false;
  });
  await client.call("threads.send", { threadId: thread.id, text: "Badge me" });
  await app.evaluate(() =>
    (globalThis as unknown as BadgeGlobal).badgeSeen((counts) => counts.includes(1)),
  );

  // A window of the app gains focus: the badge goes (D518).
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit("browser-window-focus");
  });
  await app.evaluate(() =>
    (globalThis as unknown as BadgeGlobal).badgeSeen(
      (counts) => counts.lastIndexOf(0) > counts.indexOf(1),
    ),
  );
});

test("updates come from the feed: check, download, then the install asks first", async () => {
  const url = await serveFeed("99.0.0");
  const appImage = Path.join(temporary("appimage"), "Jhin.AppImage");
  Fs.writeFileSync(appImage, "the running AppImage\n");
  const { window } = await launch({ JHIN_DESKTOP_UPDATE_FEED: url, APPIMAGE: appImage });

  await window.getByRole("button", { name: "Check for updates" }).click();
  const download = window.getByRole("button", { name: "Update 99.0.0 ready to download" });
  await expect(download).toBeVisible();
  await test
    .info()
    .attach("available", { body: await window.screenshot(), contentType: "image/png" });

  await download.click();
  await expect(window.getByText("Update downloaded")).toBeVisible();
  const install = window.getByRole("button", {
    name: "Update 99.0.0 downloaded. Click to restart and install.",
  });
  await expect(install).toBeVisible();
  await test
    .info()
    .attach("downloaded", { body: await window.screenshot(), contentType: "image/png" });

  await install.click();
  const confirm = window.getByRole("alertdialog", {
    name: "Install update 99.0.0 and restart Jhin?",
  });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Any running tasks will be interrupted.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(install).toBeVisible();

  // The same state through the command every surface of the client reaches (D520).
  const state = await window.evaluate(() =>
    (
      window as unknown as {
        jhin: { kernel: { commands: { execute(name: string, input: unknown): Promise<unknown> } } };
      }
    ).jhin.kernel.commands.execute("desktop.update.state", {}),
  );
  expect(state).toMatchObject({
    status: "downloaded",
    downloadedVersion: "99.0.0",
    channel: "latest",
  });
});

test("Check for Updates... in the menu answers in T3's native dialog", async () => {
  const url = await serveFeed("0.1.0");
  const { app } = await launch({ JHIN_DESKTOP_UPDATE_FEED: url });
  const shown = await app.evaluate(
    ({ Menu, dialog }) =>
      new Promise<{ title: string | undefined; message: string }>((resolve) => {
        dialog.showMessageBox = ((options: { title?: string; message: string }) => {
          resolve({ title: options.title, message: options.message });
          return Promise.resolve({ response: 0, checkboxChecked: false });
        }) as typeof dialog.showMessageBox;
        Menu.getApplicationMenu()!.getMenuItemById("jhin.check-for-updates")!.click();
      }),
  );
  expect(shown).toEqual({
    title: "You're up to date!",
    message: "Jhin 0.1.0 is currently the newest version available.",
  });
});

test("a crashed page and a stopped node come back with the node's token", async () => {
  const { app, home } = await launch();
  // Answers the "local node stopped" dialog with Restart, and records it.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = ((options: { title?: string }) => {
      Object.assign(globalThis, { stoppedDialog: options.title });
      return Promise.resolve({ response: 0, checkboxChecked: false });
    }) as typeof dialog.showMessageBox;
  });
  // Playwright gives up on a page that crashed, so the main process watches the
  // window: `reloaded` resolves once its page loaded again and connected to the
  // node, which it can only do with the node's token.
  const armReload = () =>
    app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      Object.assign(globalThis, {
        reloaded: new Promise<boolean>((resolve) =>
          contents.once("did-finish-load", () => {
            const connected = () =>
              contents
                .executeJavaScript(
                  `new Promise((resolve) => { const ready = () => document.querySelector('[aria-label="Go to threads"]') !== null && !document.body.innerText.includes("No node connected."); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); resolve(true); } }); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); })`,
                )
                .then(resolve);
            void connected();
          }),
        ),
      });
    });
  const reloaded = () =>
    app.evaluate(() => (globalThis as unknown as { reloaded: Promise<boolean> }).reloaded);

  // The renderer crashes: the app reloads the node's page, token included (D522).
  await armReload();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
  );
  expect(await reloaded()).toBe(true);

  // The node exits by itself: Restart starts it again and the page follows it (D512).
  await armReload();
  const pids = ChildProcess.execFileSync("pgrep", ["-f", "--", `--home ${home}`], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map(Number);
  for (const pid of pids) process.kill(pid, "SIGKILL");
  expect(await reloaded()).toBe(true);
  expect(await app.evaluate(() => (globalThis as { stoppedDialog?: string }).stoppedDialog)).toBe(
    "The local node stopped",
  );
});
