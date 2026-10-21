// The client's modes and the Civilization shell (docs/plans/agents.md#a8, D742–D750).
import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

const switcher = (page: Page) => page.getByRole("group", { name: "Modes" });

test("D746: a client with one mode shows no switcher and offers no switching", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByRole("button", { name: "Start a thread" })).toBeVisible();
  await expect(switcher(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("mode");
  await expect(palette.getByRole("option", { name: /Switch mode/ })).toHaveCount(0);
  await expect(palette.getByRole("option", { name: /next mode/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("threads-mode.png") });
});

test("D742–D750: switches to Civilization mode and back, each at its last place", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "jhin.settings",
      JSON.stringify({ "jhin.civilization": { enabled: "on" } }),
    ),
  );
  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByRole("button", { name: "Start a thread" })).toBeVisible();
  await expect(switcher(page).getByRole("button", { name: "Threads" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await switcher(page).getByRole("button", { name: "Civilization" }).click();
  await expect(page).toHaveURL(/[#&]m=civilization/);
  await expect(page.getByText("No lead yet")).toBeVisible();
  for (const section of ["Projects", "Inbox", "Missions", "Teams", "Agents", "Health"]) {
    await expect(page.getByRole("region", { name: section })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Start a thread" })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("civilization-mode.png") });

  // Settings is the app's page, in every mode (D748).
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await expect(page).toHaveURL(/[#&]m=civilization/);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByText("No lead yet")).toBeVisible();

  // The palette and the shortcut run the same command as the switcher.
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: /Switch mode/ }).click();
  await palette.getByRole("option", { name: /^Threads/ }).click();
  await expect(page.getByRole("button", { name: "Start a thread" })).toBeVisible();
  await expect(page).not.toHaveURL(/[#&]m=/);

  await page.keyboard.press("ControlOrMeta+Alt+m");
  await expect(page.getByText("No lead yet")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+m");
  await expect(page.getByRole("button", { name: "Start a thread" })).toBeVisible();
});
