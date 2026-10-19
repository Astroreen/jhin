import { expect, type Page } from "@playwright/test";

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Starts a new thread without a project on the node named `node`, as a user
 * does since the sidebar has no section per node (D70): the command palette's
 * "New thread in..." lists every node's projects, the node named under each.
 * The option shows once the client reaches the node and has its catalog.
 */
export async function newThreadOn(page: Page, node: string): Promise<void> {
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: "New thread in...", exact: true }).click();
  await palette
    .getByRole("option", { name: new RegExp(`^No project\\s*${escape(node)}$`) })
    .click();
  await expect(palette).toBeHidden();
}

/** Waits until settings → Nodes shows `count` open connections, and leaves settings again. */
export async function expectOpenConnections(page: Page, count: number): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  await expect(page.getByLabel("Connection open")).toHaveCount(count);
  await page.getByRole("button", { name: "Back", exact: true }).click();
}
