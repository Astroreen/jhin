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
