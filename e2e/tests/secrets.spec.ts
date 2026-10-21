import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

// A recognisable value, looked for where it must not be (security.md D1033).
const SECRET = "whsec-e2e-5c0ffee1-NEVER-SHOWN";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

/** A thread whose turn keeps running (the fake agent's "/hold"), so it can ask. */
async function holdingThread(page: Page): Promise<string> {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/hold");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Holding");
  const threadId = /[#&]t=([^&]+)/.exec(page.url())?.[1];
  if (threadId === undefined) throw new Error(`no thread in ${page.url()}`);
  return decodeURIComponent(threadId);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D1028–D1032: a secret is answered in a private card, and only its status reaches the thread", async ({
  page,
}, info) => {
  const threadId = await holdingThread(page);
  const asked = node.client().call<{ status: string; secretRef?: string }>("secrets.request", {
    threadId,
    label: "GitHub webhook secret",
    reason: "Signs the requests GitHub sends to the task's webhook.",
    placeholder: "Paste your GitHub secret",
  });

  const card = page.getByRole("form", { name: "GitHub webhook secret" });
  await expect(card.getByText("Stored securely, never shown to the agent")).toBeVisible();
  const field = card.getByRole("textbox", { name: "GitHub webhook secret" });
  await expect(field).toHaveAttribute("placeholder", "Paste your GitHub secret");
  // A masked text field, not a password field browsers offer to save.
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveCSS("-webkit-text-security", "disc");
  await expect(card.getByRole("button", { name: "Save securely" })).toBeDisabled();
  await field.fill(SECRET);
  await shot(page, info, "secret-request-pending");
  await card.getByRole("button", { name: "Save securely" }).click();

  await expect(
    page.getByText("GitHub webhook secret · Saved securely and kept private"),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
  await shot(page, info, "secret-request-saved");
  expect(await asked).toEqual({
    status: "saved",
    secretRef: expect.stringMatching(/^secret-ref:/),
  });

  // Neither the page nor the thread's events hold the value.
  expect(await page.content()).not.toContain(SECRET);
  const events = await node.client().call("threads.events", { threadId });
  expect(JSON.stringify(events)).not.toContain(SECRET);
});

test("D1032: a declined request says so", async ({ page }) => {
  const threadId = await holdingThread(page);
  const asked = node.client().call("secrets.request", {
    threadId,
    label: "API token",
    reason: "For the deploy.",
  });
  const card = page.getByRole("form", { name: "API token" });
  await card.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("API token · Declined")).toBeVisible();
  expect(await asked).toEqual({ status: "declined" });
});
