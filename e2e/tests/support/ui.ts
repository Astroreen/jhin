import { expect, type Locator, type Page } from "@playwright/test";

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A thread's row in the sidebar: a card, or a slim row on the Settled shelf.
 * Its name is T3's: the title, then the status shown, then the project.
 */
export function threadRow(page: Page, title: string): Locator {
  return page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: new RegExp(`^${escape(title)}, `) });
}

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

/**
 * Shows the open thread's details (t3-parity.md D802, D1350), wherever they go. Beside a wide
 * chat the card is open already unless it was closed (T3's inline card): its sections come a
 * moment later, so the card is waited for, not toggled. Elsewhere the header's toggle opens the
 * popover. The toggle names the presentation once the thread's view has measured its room.
 */
export async function showThreadDetails(page: Page): Promise<Locator> {
  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  const details = page.getByRole("region", { name: "Thread details" });
  await expect(toggle).toHaveAttribute("data-details-presentation", /^(inline|popover)$/);
  if ((await toggle.getAttribute("data-details-presentation")) !== "inline") {
    await toggle.click();
  } else if ((await toggle.getAttribute("data-details-inline-open")) !== "true") {
    // A closed card opens again from the toggle once it knows it has a section to show.
    await expect(toggle).toHaveAttribute("data-details-effective", "inline");
    await toggle.click();
  }
  await expect(details).toBeVisible();
  return details;
}

/** Hides them again: the toggle closes the inline card or the popover alike. */
export async function hideThreadDetails(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  await expect(page.getByRole("region", { name: "Thread details" })).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("region", { name: "Thread details" })).toHaveCount(0);
}

/**
 * Opens a surface of the right panel as T3's user does (t3-parity.md D1422): from "Open a surface"
 * when the panel has none, else from "Add panel surface". `label` is the menu's ("Browser",
 * "Diff", "Linked pull requests", "Terminal", "Device").
 */
export async function openSurface(page: Page, label: string): Promise<Locator> {
  const panel = page.getByRole("complementary", { name: "Right panel" });
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "Toggle right panel" }).click();
  }
  // The entry's name is its label and its letter ("Browser B").
  const name = new RegExp(`^${escape(label)}( |$)`);
  const launcher = panel.getByLabel("Open a surface");
  if (await launcher.isVisible()) {
    await launcher.getByRole("button", { name }).click();
  } else {
    await panel.getByRole("button", { name: "Add panel surface" }).click();
    await page.getByRole("menuitem", { name }).click();
  }
  return panel;
}
