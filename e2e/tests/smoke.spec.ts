import { expect, test } from "@playwright/test";

// Proves the browser toolchain works until the web client exists (PR 8).
test("renders a page and reads it through the accessibility tree", async ({ page }) => {
  await page.setContent(`<main><h1>Jhin</h1><button>Send</button></main>`);

  await expect(page.getByRole("heading", { name: "Jhin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Missing" })).toBeEnabled();
});
