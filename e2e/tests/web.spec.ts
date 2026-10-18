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
  // The new thread is listed and selected in the sidebar, titled after its first message.
  const threads = page.getByRole("list", { name: "Threads of No project" });
  await expect(threads.locator("[aria-current=page]")).toContainText("hello there");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("hello there");

  const shot = info.outputPath("chat.png");
  await page.screenshot({ path: shot });
  await info.attach("chat", { path: shot, contentType: "image/png" });
});

test("stops a running turn", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/hold please");
  await message.press("Enter");

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Holding");
  await page.getByRole("button", { name: "Stop generation" }).click();

  await expect(page.getByText("Run interrupted")).toBeVisible();
  await expect(page.getByText(/^You stopped after /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
});

test("asks for approval in the composer and runs the tool once approved", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/approve rm -rf build");
  await message.press("Enter");

  await expect(page.getByRole("group", { name: "Command approval" })).toContainText("rm -rf build");
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(
    "Approved and ran rm -rf build",
  );
  // The settled turn folds its work behind a summary.
  await expect(page.getByRole("button", { name: /^Worked for / })).toBeVisible();
});

test("answers the agent's question from the composer", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/ask");
  await message.press("Enter");

  await expect(page.getByText("Which color should I use?")).toBeVisible();
  await page.getByRole("button", { name: /^Blue/ }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("You chose Blue");
});

test("finds a thread from the command palette", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("palette target");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: palette target");

  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search commands" }).fill("palette target");
  await palette.getByRole("option", { name: /palette target/ }).click();

  await expect(palette).toBeHidden();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("palette target");
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

test("serves only browser files of client plugins", async ({ request }) => {
  // No plugin with this id: 404, and dotfiles or node_modules are never served.
  for (const path of [
    "acme.none/1/index.js",
    "acme.none/1/.env",
    "acme.none/1/node_modules/x.js",
  ]) {
    expect((await request.get(`${node.ui}client/plugins/${path}`)).status()).toBe(404);
  }
});
