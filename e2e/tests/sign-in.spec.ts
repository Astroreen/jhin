import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

test("D1152: signs an agent in with a device code from the node's settings, and cancels it", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  const agents = page.getByRole("list", { name: "Agents" });
  const fake = agents.getByRole("listitem").filter({ hasText: "Fake agent" });
  await fake.getByRole("button", { name: "Sign in" }).click();
  await expect(fake).toContainText("Enter code FAKE-1234 in your browser.");
  await expect(fake.getByRole("link", { name: "your browser" })).toHaveAttribute(
    "href",
    "https://auth.example.invalid/device",
  );
  const shot = info.outputPath("sign-in.png");
  await page.screenshot({ path: shot });
  await info.attach("device code sign-in", { path: shot, contentType: "image/png" });
  await fake.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(fake.getByRole("button", { name: "Retry sign-in" })).toBeVisible();
  await expect(fake).not.toContainText("FAKE-1234");
});
