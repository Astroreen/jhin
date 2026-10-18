import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

test("connects with the token from the URL, sends a message and streams the reply", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);

  // The token never stays in the address bar.
  await expect(page).not.toHaveURL(/token=/);
  await expect(page.getByLabel("Connection open")).toBeVisible();

  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("hello there");
  await message.press("Enter");

  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" })).toHaveText("hello there");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText("Echo: hello there");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveAttribute("aria-busy", "false");
  // The new thread is listed and selected in the sidebar.
  await expect(page.getByRole("button", { name: "New thread", exact: true }).first()).toBeVisible();
  await expect(page.locator("[aria-current=page]")).toHaveText("New thread");

  await info.attach("chat", { body: await page.screenshot(), contentType: "image/png" });
});

test("stops a running turn", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/hold please");
  await message.press("Enter");

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Holding");
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByText("Interrupted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("shows the node's live state in the inspector", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByLabel("Connection open")).toBeVisible();

  await page.getByRole("button", { name: "Inspector" }).click();

  const panel = page.getByRole("region", { name: "Inspector" });
  await expect(panel).toContainText('"id": "jhin.threads"');
  await expect(panel).toContainText('"status": "active"');
  await panel.getByRole("button", { name: "Close inspector" }).click();
  await expect(panel).toBeHidden();
});

test("serves the client strictly: 404 for missing files, 400 for bad escapes, HEAD works", async ({
  request,
}) => {
  expect((await request.get(`${node.ui}assets/missing-1234.js`)).status()).toBe(404);
  expect((await request.get(`${node.ui}%E0%A4%A`)).status()).toBe(400);
  const head = await request.head(`${node.ui}some/app/route`);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-type"]).toContain("text/html");
});

test("ignores malformed saved nodes instead of failing to load", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "jhin.nodes",
      JSON.stringify([{ url: 5 }, { url: "not a url", token: "x", label: "y" }]),
    ),
  );
  await page.goto(`${node.ui}#token=${node.token}`);

  await expect(page.getByLabel("Connection open")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Node / })).toHaveCount(1);
});
