import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

/** A new thread in plan mode whose first turn proposes a plan titled `title` (the fake agent's plan mode). */
async function proposePlan(page: Page, title: string) {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  await page.getByRole("button", { name: "Build mode" }).click();
  await expect(page.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(title);
  await message.press("Enter");
  const card = page.getByRole("log", { name: "Messages" }).getByRole("article", { name: title });
  await expect(card).toBeVisible();
  return card;
}

test("shows a proposed plan as T3's card and saves it into the project", async ({ page }, info) => {
  const card = await proposePlan(page, "Add a cache");
  await expect(card.getByText("Plan", { exact: true })).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveText(["Read the code", "Change it", "Test it"]);
  await expect(page.getByRole("region", { name: "Plan ready" })).toContainText("Add a cache");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();

  const shot = info.outputPath("plan-card.png");
  await page.screenshot({ path: shot });
  await info.attach("plan card", { path: shot, contentType: "image/png" });

  await card.getByRole("button", { name: "Plan actions" }).click();
  await page.getByRole("menuitem", { name: "Save to workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Save plan to workspace" });
  const root = (await dialog.locator("code").textContent()) ?? "";
  const field = dialog.getByRole("textbox", { name: "Workspace path" });
  await expect(field).toHaveValue("add-a-cache.md");
  await field.fill("plans/cache.md");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Plan saved to workspace")).toBeVisible();
  expect(Fs.readFileSync(Path.join(root, "plans", "cache.md"), "utf8")).toBe(
    "# Add a cache\n\n1. Read the code\n2. Change it\n3. Test it\n",
  );
});

test("implements the plan in build mode, or refines it with what was typed", async ({ page }) => {
  await proposePlan(page, "Add a cache");
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("also tests");
  await expect(page.getByRole("button", { name: "Refine" })).toBeVisible();
  await message.fill("");

  await page.getByRole("button", { name: "Implement", exact: true }).click();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" }).last()).toContainText(
    "PLEASE IMPLEMENT THIS PLAN:",
  );
  await expect(log.getByRole("article", { name: "Agent" }).last()).toContainText(
    "Echo: PLEASE IMPLEMENT THIS PLAN:",
  );
  await expect(page.getByRole("button", { name: "Build mode" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Plan ready" })).toBeHidden();
});

test("implements the plan in a new thread titled after it", async ({ page }) => {
  await proposePlan(page, "Rename the API");
  await page.getByRole("button", { name: "Implementation actions" }).click();
  await page.getByRole("menuitem", { name: "Implement in a new thread" }).click();

  await expect(threadRow(page, "Implement Rename the API")).toHaveAttribute("aria-current", "page");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" })).toContainText(
    "PLEASE IMPLEMENT THIS PLAN:",
  );
  await expect(log.getByRole("article", { name: "Agent" }).last()).toContainText("Echo:");
  // The thread the plan came from keeps its plan, still offered.
  await threadRow(page, "Rename the API").click();
  await expect(page.getByRole("region", { name: "Plan ready" })).toBeVisible();
});
