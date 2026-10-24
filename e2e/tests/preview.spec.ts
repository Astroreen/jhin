import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { openSurface } from "./support/ui.ts";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Preview page</title>
    <style>body{margin:0;font:16px sans-serif} input{display:block;box-sizing:border-box;width:100%;height:120px;font-size:32px}</style>
    <input aria-label="Field" id="field" oninput="echo.textContent = 'typed: ' + this.value">
    <p id="echo"></p>
    <button onclick="document.title='Agent clicked'">Agent button</button>
    <a href="/second">Second</a>`,
  "/second": `<!doctype html><title>Second page</title><h1>Second</h1>`,
  "/pick": `<!doctype html><title>Pick page</title>
    <style>body{margin:0} input{display:block;box-sizing:border-box;width:100%;height:50vh;font-size:32px}</style>
    <input type="file" aria-label="File" onchange="document.title = 'got ' + [...this.files].map((f) => f.name).join(',')">
    <input aria-label="Field" oninput="document.title = 'typed ' + this.value">`,
  "/dialog": `<!doctype html><title>Dialog page</title><style>body{margin:0}</style>
    <button style="width:100%;height:100vh" onclick="document.title = confirm('Leave this page?') ? 'Confirmed' : 'Kept'">Ask</button>`,
};

const LARGE = Buffer.alloc(6 * 1024 * 1024);
for (let index = 0; index < LARGE.length; index += 1) LARGE[index] = index % 251;
let node: RunningNode;
let server: Http.Server;
let origin = "";
test.beforeAll(async () => {
  node = await startNode();
  server = Http.createServer((request, response) => {
    // Six MiB, every byte its index modulo 251: a file Save carries through base64 whole.
    if (request.url === "/large.bin") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="large.bin"',
      });
      response.end(LARGE);
      return;
    }
    if (request.url === "/report.txt") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="report.txt"',
      });
      response.end("the report");
      return;
    }
    // The cookies the browser sent, as the page's title.
    if (request.url === "/cookie") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<title>${request.headers.cookie ?? "no cookie"}</title>`);
      return;
    }
    const page = PAGES[request.url ?? "/"];
    response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html" });
    response.end(page ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await node.stop();
  await new Promise((resolve) => server.close(resolve));
});

async function startThread(page: Page, text: string, on: RunningNode = node): Promise<string> {
  await page.goto(`${on.ui}#token=${on.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
  const threadId = /[#&]t=([^&]+)/.exec(page.url())?.[1];
  if (threadId === undefined) throw new Error(`no thread in ${page.url()}`);
  return decodeURIComponent(threadId);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D403: the agent's tab shows in the right panel, and the user takes it over", async ({
  page,
}, info) => {
  const threadId = await startThread(page, "preview please");

  // The agent opens a page to show the user: the thread's right panel comes up with it.
  const opened = await node
    .client()
    .call<{ tabId: string }>("preview.open", { threadId, url: `${origin}/` });
  const panel = page.getByRole("complementary", { name: "Right panel" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Preview page" })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText("Agent has control");
  await expect(panel.getByRole("textbox", { name: "Address" })).toHaveValue(`${origin}/`);
  await expect(panel.getByRole("textbox", { name: "Address" })).toBeDisabled();

  // The agent acts; its result reaches the panel.
  await node.client().call("preview.click", {
    threadId,
    locator: "role=button[name='Agent button']",
  });
  await expect(panel.getByRole("tab", { name: "Agent clicked" })).toBeVisible();
  await expect(panel.locator("[data-preview-canvas]")).toBeVisible();
  await shot(page, info, "preview-agent");

  // While another viewer holds the tab, this one only watches.
  await node.client().call("preview.tab.control", {
    threadId,
    tabId: opened.tabId,
    viewer: "another-viewer",
    take: true,
  });
  await expect(panel.getByRole("status")).toHaveText("Another viewer has control");
  await expect(panel.getByRole("button", { name: "Take control" })).toBeDisabled();
  await shot(page, info, "preview-another-viewer");
  await node.client().call("preview.tab.control", {
    threadId,
    tabId: opened.tabId,
    viewer: "another-viewer",
    take: false,
  });
  await expect(panel.getByRole("status")).toHaveText("Agent has control");

  // The user takes control: the agent may no longer act.
  await panel.getByRole("button", { name: "Take control" }).click();
  await expect(panel.getByRole("status")).toHaveText("You have control");
  await expect(node.client().call("preview.press", { threadId, key: "Tab" })).rejects.toMatchObject(
    { code: "PREVIEW_CONTROL" },
  );

  // A click on the page and typing reach it, through the canvas and the hidden input.
  const canvas = panel.locator("[data-preview-canvas]");
  // A click lands once the page is on the canvas.
  await expect(canvas).toHaveAttribute("data-painted", "true");
  const box = (await canvas.boundingBox())!;
  // The canvas's middle is on the page however the frame is letterboxed.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel.getByRole("textbox", { name: "Browser page" })).toBeFocused();
  // Tab reaches the page's first field, then the typing goes into it.
  await page.keyboard.press("Tab");
  await page.keyboard.type("hello");
  // The agent may read a tab the user drives: it waits until the page shows the text.
  await node.client().call("preview.wait.for", {
    threadId,
    tabId: opened.tabId,
    text: "typed: hello",
  });
  await panel.getByRole("button", { name: "Release control" }).click();
  await expect(panel.getByRole("status")).toHaveText("Agent has control");
  await node.client().call("preview.press", { threadId, key: "Tab" });

  // Closing the tab the agent drives asks first, as T3's does (t3-parity.md D1422).
  await panel
    .locator('[data-active-tab="true"]')
    .getByRole("button", { name: /^Close / })
    .click();
  const question = page.getByRole("alertdialog");
  await expect(question).toContainText("Close browser while the agent is using it?");
  await shot(page, info, "right-panel-close-agent-browser");
  await question.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("status")).toHaveText("Agent has control");
});

test("D950: a server a terminal started shows under Local servers and opens", async ({
  page,
}, info) => {
  const threadId = await startThread(page, "serve please");
  const terminal = { threadId, terminalId: "dev-server" };
  await node.client().call("terminals.open", { ...terminal, cwd: node.home });
  // The dev server goes with its terminal, also when an assertion fails.
  try {
    // A dev server: an HTML page on a free port of this machine.
    const script =
      "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');" +
      "s.end('<title>Dev server</title><h1>dev</h1>')}).listen(0,'127.0.0.1')";
    await node.client().call("terminals.write", {
      ...terminal,
      data: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}\r`,
    });

    // The card's indicator shows once the terminal's process table has the server's
    // process: from then on the panel's first scan finds it.
    await expect(
      page.getByRole("button", { name: "1 terminal process running. Open terminal" }),
    ).toBeVisible();
    const panel = await openSurface(page, "Browser");
    const servers = panel.getByRole("region", { name: "Local servers" });
    // The process name is the OS's: `node`, or `MainThread` for Node 24 on Linux.
    const row = servers.getByRole("button", { name: /^\S+ localhost:\d+$/ });
    await expect(row).toBeVisible();
    await expect(servers).toContainText(
      "Select a live local server to open it in this browser tab.",
    );
    await shot(page, info, "local-servers");

    await row.click();
    await expect(panel.getByRole("tab", { name: "Dev server" })).toBeVisible();
  } finally {
    await node.client().call("terminals.close", terminal);
  }
});

test("D953: a profile made in the settings opens a tab of its own, marked with its name", async ({
  page,
}, info) => {
  await startThread(page, "profiles please");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Browser" }).click();
  const section = page.getByRole("region", { name: "Browser" });
  await section.getByRole("button", { name: "Add profile" }).click();
  await page.getByRole("menuitem", { name: "Blank profile" }).click();
  const name = section.getByRole("textbox", { name: "Rename New profile" });
  await name.fill("Work");
  await name.press("Enter");
  const list = section.getByRole("list", { name: "Browser profiles" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("Default");
  await shot(page, info, "browser-profiles");
  await page.getByRole("button", { name: "Back" }).click();

  // "Open a surface" offers the browser in each profile, as T3's does.
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  const panel = page.getByRole("complementary", { name: "Right panel" });
  await panel.getByRole("button", { name: "Open browser in a profile" }).click();
  await page.getByRole("menuitem", { name: "Work" }).click();
  await expect(panel.getByRole("tab", { name: "Browser" })).toBeVisible();
  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill(`${origin}/second`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  // A tab of another profile than the default says which.
  await expect(panel.getByText("Work", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Preview menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Profile: Work" })).toBeVisible();
  await shot(page, info, "profile-tab");
  await page.keyboard.press("Escape");

  // Work as the default: "+" opens in it, and its tabs carry no badge any more.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Browser" }).click();
  await section.getByRole("button", { name: "Work options" }).click();
  await page.getByRole("menuitem", { name: "Set as default" }).click();
  await expect(list.getByRole("listitem").nth(1)).toContainText("Default");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(panel.getByText("Work", { exact: true })).toHaveCount(0);
});

/** A machine whose only browser is a Firefox profile with a login for the test's pages. */
function machineWithFirefox(): string {
  const machine = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-e2e-machine-"));
  const root = Path.join(machine, ".mozilla", "firefox");
  Fs.mkdirSync(Path.join(root, "abcd.default-release"), { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "profiles.ini"),
    "[Profile0]\nName=Personal\nIsRelative=1\nPath=abcd.default-release\n",
  );
  const database = new DatabaseSync(Path.join(root, "abcd.default-release", "cookies.sqlite"));
  // Firefox 129+ (schema 16) keeps expiries in milliseconds.
  database.exec(`pragma user_version = 16;
    create table moz_cookies (id integer primary key, host text, name text, value text,
      path text, expiry integer, isSecure integer, isHttpOnly integer, sameSite integer,
      originAttributes text not null default '')`);
  database
    .prepare(
      "insert into moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite) values (?, ?, ?, ?, ?, 0, 1, 1)",
    )
    .run("127.0.0.1", "login", "alice", "/", Date.now() + 86_400_000);
  database.close();
  return machine;
}

test("D1205: the node machine's Firefox cookies go into a new profile from Add profile", async ({
  page,
}, info) => {
  const machine = machineWithFirefox();
  // The node reads the browsers of its own machine: here a HOME of the test's.
  const importing = await startNode({
    env: {
      HOME: machine,
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? Path.join(Os.homedir(), ".cache", "ms-playwright"),
    },
  });
  try {
    await startThread(page, "import please", importing);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Browser" }).click();
    const section = page.getByRole("region", { name: "Browser" });
    await section.getByRole("button", { name: "Add profile" }).click();
    await expect(page.getByRole("menuitem", { name: "Blank profile" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Firefox" })).toBeVisible();
    await shot(page, info, "import-menu");
    await page.getByRole("menuitem", { name: "Firefox" }).click();

    const wizard = page.getByRole("dialog", { name: "Import from Firefox" });
    await expect(wizard.getByRole("button", { name: /Personal/ })).toContainText("1 cookie");
    await expect(wizard.getByRole("button", { name: /New profile/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await shot(page, info, "import-configure");
    await wizard.getByRole("button", { name: "Import" }).click();
    const done = page.getByRole("dialog", { name: "Imported 1 cookie" });
    await expect(done).toContainText("Added to Firefox for");
    await shot(page, info, "import-done");
    await done.getByRole("button", { name: "Done" }).click();
    const list = section.getByRole("list", { name: "Browser profiles" });
    await expect(list.getByRole("textbox", { name: "Rename Firefox" })).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();

    // A tab of the new profile is signed in.
    await page.getByRole("button", { name: "Toggle right panel" }).click();
    const panel = page.getByRole("complementary", { name: "Right panel" });
    await panel.getByRole("button", { name: "Open browser in a profile" }).click();
    await page.getByRole("menuitem", { name: "Firefox" }).click();
    const address = panel.getByRole("textbox", { name: "Address" });
    await address.fill(`${origin}/cookie`);
    await address.press("Enter");
    await expect(panel.getByRole("tab", { name: "login=alice" })).toBeVisible();
  } finally {
    await importing.stop();
    Fs.rmSync(machine, { recursive: true, force: true });
  }
});

test("D403: the user opens a page from the address bar and sizes it like a device", async ({
  page,
}, info) => {
  await startThread(page, "browse please");
  // T3's right panel (t3-parity.md D1424): "Browser" opens a new tab.
  const panel = await openSurface(page, "Browser");
  await expect(panel.getByText("No preview yet")).toBeVisible();

  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill(`${origin}/second`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  // A tab the user opened is theirs to drive at once.
  await expect(panel.getByRole("status")).toHaveText("You have control");

  await panel.getByRole("button", { name: "Preview menu" }).click();
  await page.getByRole("menuitem", { name: "Show device toolbar" }).click();
  const toolbar = panel.getByRole("toolbar", { name: "Browser device toolbar" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("combobox", { name: "Browser device preset" }).click();
  await page.getByRole("option", { name: /iPhone 12 Pro/ }).click();
  await expect(toolbar.getByRole("textbox", { name: "Viewport width" })).toHaveValue("390");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, info, "preview-device-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await toolbar.getByRole("button", { name: "Close device toolbar" }).click();
  await expect(toolbar).toBeHidden();

  // A page's dialog shows over it; the user answers it.
  await address.fill(`${origin}/dialog`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Dialog page" })).toBeVisible();
  const canvas = panel.locator("[data-preview-canvas]");
  await expect(canvas).toHaveAttribute("data-painted", "true");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const dialog = panel.getByRole("alertdialog");
  await expect(dialog).toContainText("Leave this page?");
  await shot(page, info, "preview-dialog");
  await dialog.getByRole("button", { name: "Accept" }).click();
  await expect(panel.getByRole("tab", { name: "Confirmed" })).toBeVisible();
  await expect(dialog).toBeHidden();

  // The tab closes from its strip, and with the last surface the panel (D1422).
  await panel.getByRole("button", { name: "Close Confirmed" }).click();
  await expect(panel).toBeHidden();
  // T3's "Open a surface"; a new tab offers the page just visited.
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  const launcher = panel.getByLabel("Open a surface");
  await expect(launcher).toBeVisible();
  await shot(page, info, "right-panel-open-a-surface");
  await launcher.getByRole("button", { name: /^Browser/ }).click();
  await expect(panel.getByRole("region", { name: "Recently used" })).toContainText("Second page");
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expect(panel).toBeHidden();
});

test("D1202: a tab floats over the chat, moves, and goes back to the right panel", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const threadId = await startThread(page, "float please");
  const panel = await openSurface(page, "Browser");
  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill(`${origin}/second`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();

  // T3's "Float preview over chat": the panel closes and the tab floats over the chat.
  await panel.getByRole("button", { name: "Float preview over chat" }).click();
  await expect(panel).toBeHidden();
  const player = page.getByRole("region", { name: "Floating browser preview" });
  await expect(player).toBeVisible();
  await expect(player.locator("[data-preview-canvas]")).toHaveAttribute("data-painted", "true");
  // At 1400 × 900 it sits in the chat's bottom-right corner, T3's 12 px from its edges, beside
  // the composer's lane (T3's chat canvas, D1326).
  const composer = (await page.getByRole("textbox", { name: "Message" }).boundingBox())!;
  const before = (await player.boundingBox())!;
  // T3's 12 px from the window's right and bottom edges, whatever the fonts make of the rest.
  expect(before.x + before.width).toBe(1400 - 12);
  expect(before.y + before.height).toBe(900 - 12);
  expect(before.x).toBeGreaterThanOrEqual(composer.x + composer.width);
  await shot(page, info, "mini-player");

  // Hovering its handle shows T3's pill, whose background drags it.
  const handle = player.locator("[data-preview-mini-player-handle]");
  await handle.hover();
  const pill = (await handle.locator("> div").nth(1).boundingBox())!;
  const grip = { x: pill.x + 1.5, y: pill.y + pill.height / 2 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 200, grip.y - 100, { steps: 4 });
  await page.mouse.up();
  const moved = (await player.boundingBox())!;
  // Up by the whole drag; left only as far as the chat's lane, at its least width, allows
  // (T3's chat canvas, D1326): at this size it stops short of the whole 200 px, T3's 12 px
  // beside the lane.
  expect(moved.y).toBe(before.y - 100);
  expect({ width: moved.width, height: moved.height }).toEqual({
    width: before.width,
    height: before.height,
  });
  const lane = (await page.getByRole("textbox", { name: "Message" }).boundingBox())!;
  expect(moved.x).toBeLessThan(before.x);
  expect(moved.x).toBeGreaterThan(before.x - 200);
  expect(moved.x).toBeGreaterThanOrEqual(lane.x + lane.width + 12);

  // Back in the right panel, the tab no longer floats.
  await handle.hover();
  await expect(player.getByRole("button", { name: "Open preview in right panel" })).toBeVisible();
  await shot(page, info, "mini-player-moved");
  await player.getByRole("button", { name: "Open preview in right panel" }).click();
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  await expect(player).toBeHidden();
  await expect(panel.getByRole("button", { name: "Close floating preview" })).toBeHidden();

  // Closing the panel floats the tab it showed, as T3's does; the pill closes it.
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expect(panel).toBeHidden();
  await expect(player).toBeVisible();
  await handle.hover();
  await player.getByRole("button", { name: "Close floating preview" }).click();
  await expect(player).toBeHidden();

  // The palette's commands do the same: preview.float floats the tab the panel shows.
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const runCommand = async (title: string) => {
    await page.getByRole("button", { name: "Command palette", exact: true }).click();
    await palette.getByRole("combobox", { name: "Search commands" }).fill(title);
    await palette.getByRole("option", { name: title }).first().click();
    await expect(palette).toBeHidden();
  };
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  await runCommand("Float preview over chat");
  await expect(panel).toBeHidden();
  await expect(player).toBeVisible();
  await runCommand("Close floating preview");
  await expect(player).toBeHidden();

  // A floating tab that closes takes its player with it.
  await runCommand("Float preview over chat");
  await expect(player).toBeVisible();
  const { tabs } = await node
    .client()
    .call<{ tabs: { tabId: string }[] }>("preview.list", { threadId });
  await node.client().call("preview.tab.close", { threadId, tabId: tabs[0]!.tabId });
  await expect(player).toBeHidden();
});

test("D1331: a page's download is offered to the user, who saves it to this device", async ({
  page,
}, info) => {
  await startThread(page, "download please");
  const panel = await openSurface(page, "Browser");
  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill(`${origin}/second`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText("You have control");

  // The page's file downloads on the node; T3's toast offers it here.
  await address.fill(`${origin}/report.txt`);
  await address.press("Enter");
  const toast = page.getByText("Downloaded report.txt");
  await expect(toast).toBeVisible();
  // A navigation that became a download is no failure.
  await expect(page.getByText("Download is starting")).toHaveCount(0);
  await shot(page, info, "download-toast");
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save" }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe("report.txt");
  expect(Fs.readFileSync(await download.path(), "utf8")).toBe("the report");
  // Saved: the offer is done.
  await expect(toast).toHaveCount(0);

  // A file of several MiB comes through base64 and the page's decoding whole.
  await address.fill(`${origin}/large.bin`);
  await address.press("Enter");
  const large = page.getByText("Downloaded large.bin");
  await expect(large).toBeVisible();
  const savedLarge = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save" }).click();
  const largeDownload = await savedLarge;
  expect(Fs.readFileSync(await largeDownload.path()).equals(LARGE)).toBe(true);
  await expect(large).toHaveCount(0);
});

/**
 * The element in the browser's picture-in-picture window, once it is there: the player shows
 * its state as the window starts opening, and the browser enters it a moment later.
 */
const floated = (page: Page) =>
  page.evaluate(
    () =>
      document.pictureInPictureElement?.tagName ??
      new Promise<string>((resolve) =>
        document
          .querySelector("video[data-preview-picture-in-picture]")!
          .addEventListener("enterpictureinpicture", () => resolve("VIDEO"), { once: true }),
      ),
  );

test("D1326–D1327: the chat makes room beside a floating tab, which pops into its own window", async ({
  page,
}, info) => {
  // Wide enough for a readable chat lane beside the player, too narrow for the lane to stay centred.
  await page.setViewportSize({ width: 1400, height: 900 });
  await startThread(page, "canvas please");
  const panel = await openSurface(page, "Browser");
  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill(`${origin}/second`);
  await address.press("Enter");
  await expect(panel.getByRole("tab", { name: "Second page" })).toBeVisible();
  await panel.getByRole("button", { name: "Float preview over chat" }).click();
  const player = page.getByRole("region", { name: "Floating browser preview" });
  await expect(player).toBeVisible();

  // The player sits in the bottom corner beside the composer, and the lane moved aside for it.
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(page.locator("[data-chat-canvas]")).toHaveAttribute(
    "style",
    /--chat-lane-inset-end: [1-9]/,
  );
  const lane = (await composer.boundingBox())!;
  const box = (await player.boundingBox())!;
  expect(lane.x + lane.width).toBeLessThanOrEqual(box.x - 12);
  expect(box.y + box.height).toBeGreaterThan(lane.y);
  await shot(page, info, "chat-canvas");

  // T3's "Pop into separate window": the browser's picture-in-picture window shows the tab.
  await player.locator("[data-preview-mini-player-handle]").hover();
  await player.getByRole("button", { name: "Pop preview into separate window" }).click();
  await expect(player.getByRole("button", { name: "Close popped-out preview" })).toBeVisible();
  await shot(page, info, "chat-canvas-popped-out");
  expect(await floated(page)).toBe("VIDEO");
  await player.getByRole("button", { name: "Close popped-out preview" }).click();
  await expect(page.locator("video[data-preview-picture-in-picture]")).toHaveCount(0);

  // The same as commands, from the palette (a user's gesture, as the browser asks):
  // `preview.pop-out` ("Pop into separate window") and `preview.pop-out.close`.
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const runCommand = async (title: string) => {
    await page.getByRole("button", { name: "Command palette", exact: true }).click();
    await palette.getByRole("combobox", { name: "Search commands" }).fill(title);
    await palette.getByRole("option", { name: title }).first().click();
    await expect(palette).toBeHidden();
  };
  await runCommand("Pop into separate window");
  await expect(player.getByRole("button", { name: "Close popped-out preview" })).toBeAttached();
  expect(await floated(page)).toBe("VIDEO");
  await runCommand("Close separate window");
  await expect(page.locator("video[data-preview-picture-in-picture]")).toHaveCount(0);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("D1203: the page's file picker takes the user's files, and a tap on text raises the keyboard", async ({
    page,
  }, info) => {
    await startThread(page, "pick please");
    const panel = await openSurface(page, "Browser");
    const address = panel.getByRole("textbox", { name: "Address" });
    await address.fill(`${origin}/pick`);
    await address.press("Enter");
    await expect(panel.getByRole("tab", { name: "Pick page" })).toBeVisible();
    const canvas = panel.locator("[data-preview-canvas]");
    await expect(canvas).toHaveAttribute("data-painted", "true");
    const box = (await canvas.boundingBox())!;

    // A tap on the file input clicks it: the page asks for a file, as T3 shows.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 4);
    const chooser = panel.getByRole("dialog", { name: "Choose files for the page" });
    await expect(chooser).toContainText("The page asks for a file.");
    await shot(page, info, "file-chooser");
    await chooser.locator("[data-preview-file-input]").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(panel.getByRole("tab", { name: "got notes.txt" })).toBeVisible();
    await expect(chooser).toBeHidden();

    // A tap on the text field focuses the page's input, so typing reaches the field.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + (box.height * 3) / 4);
    await expect(panel.getByRole("textbox", { name: "Browser page" })).toBeFocused();
    await page.keyboard.type("hi");
    await expect(panel.getByRole("tab", { name: "typed hi" })).toBeVisible();
  });
});
