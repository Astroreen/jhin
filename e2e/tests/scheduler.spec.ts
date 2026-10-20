import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode | undefined;
test.afterEach(async () => {
  await node?.stop();
  node = undefined;
});

/** A screenshot in the report, also copied to `JHIN_SHOTS` when set (for a PR). */
async function shoot(target: Page | Locator, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await target.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
  const shots = process.env["JHIN_SHOTS"];
  if (shots) {
    Fs.mkdirSync(shots, { recursive: true });
    Fs.copyFileSync(path, Path.join(shots, `${name}.png`));
  }
}

/** A task's row on the page, found by its title. */
const taskRow = (section: Locator, title: string) =>
  section
    .locator("[data-slot=settings-row]")
    .filter({ has: section.page().getByRole("heading", { name: title, exact: true }) });

test("D389: creates, pauses, runs and deletes a scheduled task from settings", async ({
  page,
}, info) => {
  node = await startNode();
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Scheduled tasks" })
    .click();
  const section = page.getByRole("region", { name: "Scheduled tasks" });
  await expect(section.getByRole("heading", { name: "No scheduled tasks" })).toBeVisible();

  await section.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Check the build");
  await dialog.getByRole("textbox", { name: "Prompt" }).fill("Check the build on main");
  await shoot(dialog, info, "scheduler-editor");
  await dialog.getByRole("button", { name: "Every interval" }).click();
  await dialog.getByRole("spinbutton", { name: "Run every" }).fill("5");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();

  const row = taskRow(section, "Check the build");
  await expect(row).toContainText("Every 5 min · Next run in 5m");

  // A second task, a webhook, made over RPC: the page follows the node's stream.
  await node.client().call("scheduler.tasks.create", {
    title: "Release notes",
    prompt: "Write notes for {{body.release.tag_name}}",
    schedule: { type: "webhook" },
  });
  await expect(taskRow(section, "Release notes")).toContainText("On webhook · Listening");
  await shoot(page, info, "scheduler-page");

  await row.getByRole("switch", { name: "Enable Check the build" }).click();
  await expect(row).toContainText("Every 5 min · Paused");

  await row.getByRole("button", { name: "Actions for Check the build" }).click();
  await page.getByRole("menuitem", { name: "Run now" }).click();
  await expect(row.getByText("succeeded", { exact: true })).toBeVisible();

  // The run's thread finished and its toast may cover the row: the keyboard reaches it anyway.
  await row.getByRole("button", { name: "Actions for Check the build" }).press("Enter");
  await page.getByRole("menuitem", { name: "Delete" }).press("Enter");
  await expect(row).toHaveCount(0);
  expect(
    (
      await node.client().call<{ tasks: { title: string }[] }>("scheduler.tasks.list", {})
    ).tasks.map((task) => task.title),
  ).toEqual(["Release notes"]);
});
