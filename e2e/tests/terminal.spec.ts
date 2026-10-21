import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

let node: RunningNode;
test.beforeAll(async () => {
  // A plain POSIX shell: the same prompt everywhere, nothing of this machine's in it.
  node = await startNode({ config: { "jhin.terminal": { shell: "/bin/sh" } } });
});
test.afterAll(async () => {
  await node.stop();
});

async function startThread(page: Page, text: string): Promise<void> {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
}

test("D140–D146: the terminal drawer opens under the chat, runs a command and splits", async ({
  page,
}, info) => {
  await startThread(page, "terminal please");

  // T3's shortcut opens the drawer with a first terminal, focused.
  await page.keyboard.press("ControlOrMeta+j");
  const drawer = page.getByRole("complementary", { name: "Terminal" });
  await expect(drawer).toBeVisible();
  const first = drawer.getByRole("group", { name: "Terminal 1" });
  await expect(first.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await expect(first.locator(".xterm-rows")).toContainText("$");

  // The arithmetic tells the output from the shell echoing what was typed.
  await page.keyboard.type("echo jhin-$((6*7)) && pwd");
  await page.keyboard.press("Enter");
  await expect(first.locator(".xterm-rows")).toContainText("jhin-42");
  await expect(first.locator(".xterm-rows")).toContainText("scratch");
  const light = info.outputPath("terminal-light.png");
  await page.screenshot({ path: light });
  await info.attach("terminal-light", { path: light, contentType: "image/png" });

  // A program running in it shows on the thread's card (T3's terminal indicator).
  await page.keyboard.type("sleep 60");
  await page.keyboard.press("Enter");
  const card = threadRow(page, "terminal please");
  // In the card's row of indicators (sidebar.thread.indicators), with the branch and the PR.
  const indicator = card.locator("[data-thread-indicators]").getByRole("button", {
    name: "1 terminal process running. Open terminal",
  });
  await expect(indicator).toBeVisible();
  // The tab is named after the program, as T3 names it.
  await expect(drawer.getByRole("group", { name: "sleep" })).toBeVisible();

  // mod+d splits while the terminal has focus (terminalFocus, D61).
  await page.keyboard.press("ControlOrMeta+d");
  const second = drawer.getByRole("group", { name: "Terminal 2" });
  await expect(second.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await expect(drawer.getByRole("complementary", { name: "Terminals" })).toContainText(
    "Side by side",
  );
  await page.keyboard.type("echo second-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(second.locator(".xterm-rows")).toContainText("second-2");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const dark = info.outputPath("terminal-split-dark.png");
  await page.screenshot({ path: dark });
  await info.attach("terminal-split-dark", { path: dark, contentType: "image/png" });
  await page.emulateMedia({ colorScheme: "light" });

  // Hidden, the terminals keep running; the card's indicator brings the drawer back.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(drawer).toBeHidden();
  await expect(indicator).toBeVisible();
  await indicator.click();
  await expect(drawer.getByRole("group", { name: "sleep" })).toBeVisible();
  // What it printed while hidden is still there: the node kept it.
  await expect(drawer.getByRole("group", { name: "sleep" }).locator(".xterm-rows")).toContainText(
    "jhin-42",
  );
  const indicatorShot = info.outputPath("terminal-indicator.png");
  await page.screenshot({ path: indicatorShot });
  await info.attach("terminal-indicator", { path: indicatorShot, contentType: "image/png" });

  // Closing asks first, as T3 does, and stops the process.
  await drawer.getByRole("button", { name: "Close sleep" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText('Close terminal "sleep"?');
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(drawer.getByRole("group", { name: "sleep" })).toBeHidden();
  await expect(indicator).toBeHidden();
  await expect(drawer.getByRole("group", { name: "Terminal 2" })).toBeVisible();

  const { terminals } = await node
    .client()
    .call<{ terminals: { terminalId: string }[] }>("terminals.list", {});
  expect(terminals.map((terminal) => terminal.terminalId)).toEqual(["term-2"]);
});

test("an exited shell closes its tab, as in T3", async ({ page }) => {
  await startThread(page, "exit please");
  await page.keyboard.press("ControlOrMeta+j");
  const drawer = page.getByRole("complementary", { name: "Terminal" });
  await expect(drawer.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(drawer).toBeHidden();
});

test("D472–D474: the selection menu adds to the chat, and the terminals move to the right panel", async ({
  page,
}, info) => {
  await startThread(page, "terminal menus");
  await page.keyboard.press("ControlOrMeta+j");
  const drawer = page.getByRole("complementary", { name: "Terminal" });
  const terminal = drawer.getByRole("group", { name: "Terminal 1" });
  await expect(terminal.locator(".xterm-rows")).toContainText("$");
  await page.keyboard.type("echo menu-$((2*21))");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText("menu-42");

  // T3's context menu: select everything, then add it to the chat.
  await terminal.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select all" }).click();
  await terminal.click({ button: "right" });
  const menuShot = info.outputPath("terminal-context-menu.png");
  await expect(page.getByRole("menuitem", { name: "Add to chat" })).toBeEnabled();
  await page.screenshot({ path: menuShot });
  await info.attach("terminal-context-menu", { path: menuShot, contentType: "image/png" });
  await page.getByRole("menuitem", { name: "Add to chat" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  // T3's inline terminal chip (D1009): its record holds the lines; pressed, it shows them.
  const chip = message.getByRole("button", { name: /^Terminal excerpt, Terminal 1 lines? 1/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByLabel("Captured terminal output")).toContainText("menu-42");
  const chipShot = info.outputPath("terminal-chip.png");
  await page.screenshot({ path: chipShot });
  await info.attach("terminal-chip", { path: chipShot, contentType: "image/png" });
  await page.keyboard.press("Escape");

  // The header's toggle shows the thread's terminals right of the chat.
  await page.getByRole("button", { name: "Toggle terminal panel" }).click();
  const panel = page.locator('[data-terminal-owner="right-panel"]');
  await expect(
    panel.getByRole("group", { name: "Terminal 1" }).locator(".xterm-rows"),
  ).toContainText("menu-42");
  const panelShot = info.outputPath("terminal-right-panel.png");
  await page.screenshot({ path: panelShot });
  await info.attach("terminal-right-panel", { path: panelShot, contentType: "image/png" });

  await page.getByRole("button", { name: "Toggle terminal panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(drawer.getByRole("group", { name: "Terminal 1" })).toBeVisible();
});

test("D965: a path in the output opens in the editor, or says why not", async ({ page }) => {
  await startThread(page, "terminal paths");
  await page.keyboard.press("ControlOrMeta+j");
  const terminal = page
    .getByRole("complementary", { name: "Terminal" })
    .getByRole("group", { name: "Terminal 1" });
  const rows = terminal.locator(".xterm-rows");
  await expect(rows).toContainText("$");
  // The arithmetic tells the output from the shell echoing what was typed.
  await page.keyboard.type("echo /tmp/jhin-$((40+2)).txt:3");
  await page.keyboard.press("Enter");
  const output = rows.locator("div").filter({ hasText: /^\/tmp\/jhin-42\.txt:3\s*$/ });
  await expect(output).toHaveCount(1);

  // Ctrl-click (⌘ on macOS): outside the thread's project, the terminal says so, as T3's.
  // The row redraws as the cursor blinks: it never counts as "stable", so the pointer goes by hand.
  const row = await output.boundingBox();
  if (row === null) throw new Error("The output row has no box");
  await page.mouse.move(row.x + 20, row.y + row.height / 2);
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(row.x + 20, row.y + row.height / 2);
  await page.keyboard.up("ControlOrMeta");
  await expect(rows).toContainText(
    "[terminal] /tmp/jhin-42.txt is not a file of the thread's project",
  );
});
