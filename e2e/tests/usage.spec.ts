import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

test("opens T3's Usage page from the sidebar with every agent's limits", async ({ page }, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: "Usage" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  // The fake agent reports a session and a weekly window (providers.md D1144).
  const agent = page.getByRole("region", { name: "Fake agent" });
  await expect(agent.getByRole("heading", { name: "Fake agent" })).toBeVisible();
  await expect(agent.getByRole("group", { name: "Session: 75% left" })).toBeVisible();
  await expect(agent.getByRole("group", { name: "Weekly: 40% left" })).toBeVisible();
  await expect(agent.getByRole("button", { name: /: 75% left, resets in/ })).toBeVisible();
  const shot = info.outputPath("usage-page.png");
  await page.screenshot({ path: shot });
  await info.attach("usage page", { path: shot, contentType: "image/png" });

  await page.getByRole("button", { name: "Refresh limits" }).click();
  await expect(agent.getByRole("group", { name: "Session: 75% left" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toHaveCount(0);
});
