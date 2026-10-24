import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode | undefined;
test.afterEach(async () => {
  await node?.stop();
  node = undefined;
});

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D1473–D1475: T3's scripts menu adds an action, runs it in a terminal, imports t3.json's and binds a key", async ({
  page,
}, info) => {
  // A plain POSIX shell: the same prompt everywhere, nothing of this machine's in it.
  node = await startNode({ config: { "jhin.terminal": { shell: "/bin/sh" } } });
  const dir = Path.join(node.home, "acme");
  Fs.mkdirSync(dir, { recursive: true });
  Fs.writeFileSync(
    Path.join(dir, "t3.json"),
    JSON.stringify({ scripts: [{ name: "Lint", command: "echo lint-$((2*3))", icon: "lint" }] }),
  );
  const project = await node
    .client()
    .call<{ id: string }>("projects.create", { path: dir, name: "acme" });
  const thread = await node
    .client()
    .call<{ id: string }>("threads.create", { projectId: project.id, title: "Scripts" });
  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: /^Scripts, / })
    .click();

  // No scripts of its own, but t3.json has one: T3's "Actions" menu.
  const header = page.locator("[data-panel-layout-controls]");
  await header.getByRole("button", { name: "Project actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Lint" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Add action" }).click();

  const dialog = page.getByRole("dialog", { name: "Add Action" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Greet");
  await dialog.getByRole("textbox", { name: "Command" }).fill("echo greet-$((6*7))");
  await dialog.getByRole("textbox", { name: "Keybinding" }).press("Control+Alt+g");
  await expect(dialog.getByRole("textbox", { name: "Keybinding" })).toHaveValue("mod+alt+g");
  await dialog
    .getByRole("textbox", { name: "Preview URL (optional)" })
    .fill("http://localhost:5173");
  await shot(page, info, "add-action-dialog");
  await dialog.getByRole("button", { name: "Save action" }).click();
  await expect(dialog).toBeHidden();
  expect(
    (await node.client().call<{ scripts?: unknown[] }[]>("projects.list", {})).find(
      (entry) => (entry as { id?: string }).id === project.id,
    ),
  ).toMatchObject({
    scripts: [
      {
        id: "greet",
        name: "Greet",
        command: "echo greet-$((6*7))",
        previewUrl: "http://localhost:5173",
        autoOpenPreview: false,
      },
    ],
  });

  // The header runs it: T3's primary button, its terminal shown in the drawer.
  await header.getByRole("button", { name: "Run Greet" }).click();
  const drawer = page.getByRole("complementary", { name: "Terminal" });
  await expect(drawer.locator(".xterm-rows").last()).toContainText("greet-42");

  // Import the file's script from the menu, then run it by its shortcut.
  await header.getByRole("button", { name: "Script actions" }).click();
  await expect(page.getByRole("group", { name: "From t3.json" })).toBeVisible();
  await shot(page, info, "scripts-menu");
  await page.getByRole("menuitem", { name: /^Lint/ }).click();
  // Imported: a script of the project now, no longer offered from the file.
  await header.getByRole("button", { name: "Script actions" }).click();
  await expect(page.getByRole("menuitem", { name: /^Lint/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "From t3.json" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const listed = await node
    .client()
    .call<{ id: string; scripts?: { id: string }[] }[]>("projects.list", {});
  expect(listed.find((entry) => entry.id === project.id)?.scripts?.map((s) => s.id)).toEqual([
    "greet",
    "lint",
  ]);

  // T3's script.<id>.run by the shortcut saved with it: a second run in the same terminal.
  await page.keyboard.press("Control+Alt+g");
  await expect(drawer.locator(".xterm-rows").last()).toContainText(/greet-42[\s\S]*greet-42/);
  expect(thread.id).toBeTruthy();
});
