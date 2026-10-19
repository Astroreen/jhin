import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { expectOpenConnections, newThreadOn, threadRow } from "./support/ui.ts";

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

async function start(options: Parameters<typeof startNode>[0]): Promise<RunningNode> {
  const node = await startNode(options);
  running.push(node);
  return node;
}

/** A folder named `name` in the node's home, added as a project there. */
async function addProject(node: RunningNode, name: string): Promise<void> {
  const path = Path.join(node.home, name);
  Fs.mkdirSync(path, { recursive: true });
  await node.client().call("projects.create", { path });
}

/** A thread with one finished turn, made through the node's API. */
async function addThread(node: RunningNode, text: string): Promise<void> {
  const thread = await node.client().call<{ id: string }>("threads.create", {});
  await node.client().call("threads.send", { threadId: thread.id, text });
}

async function send(page: Page, text: string): Promise<void> {
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not rendered");
  return found;
}

test("D70: thread cards in one list; they name their node only while several nodes are shown", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  const y = await start({ mode: "serve" });
  const xHost = new URL(x.ui).host;
  const yHost = new URL(y.rpc).host;
  await addProject(x, "web");
  await addProject(y, "web");

  await page.goto(`${x.ui}#token=${x.token}`);
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await send(page, "on x");
  // One node: a card with its project and title, and nothing about where it lives.
  const onX = threadRow(page, "on x");
  await expect(onX).toHaveAccessibleName("on x, No project");
  await expect(onX).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-host-indicator]")).toHaveCount(0);
  // Nothing settled yet: the shelf is there, collapsed.
  await expect(page.getByRole("button", { name: "Settled (0)" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const oneNode = info.outputPath("sidebar-one-node.png");
  await page.screenshot({ path: oneNode });
  await info.attach("sidebar-one-node", { path: oneNode, contentType: "image/png" });

  // D73: settings leads the footer, as in T3.
  const settings = await box(page.getByRole("button", { name: "Settings", exact: true }));
  const palette = await box(page.getByRole("button", { name: "Command palette" }));
  const search = await box(page.getByRole("combobox", { name: "Search threads" }));
  expect(settings.x).toBeLessThan(palette.x);
  expect(settings.x).toBeLessThan(search.x + search.width / 2);

  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Node URL" }).fill(y.rpc);
  await page.getByRole("textbox", { name: "Token" }).fill(y.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expectOpenConnections(page, 2);
  await newThreadOn(page, yHost);
  await send(page, "on y");

  // Two nodes, no section per node: every card names its node.
  const onY = threadRow(page, "on y");
  await expect(onY).toHaveAttribute("aria-current", "page");
  await expect(onX.getByLabel(`On ${xHost}`, { exact: true })).toBeAttached();
  await expect(onY.getByLabel(`On ${yHost}`, { exact: true })).toBeAttached();
  await expect(page.getByRole("region", { name: /^Node / })).toHaveCount(0);
  const shot = info.outputPath("sidebar-two-nodes.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-two-nodes", { path: shot, contentType: "image/png" });

  // The project filter keeps the two projects called "web" apart by their node.
  await page.getByRole("combobox", { name: "Filter threads by project" }).click();
  await expect(page.getByRole("option", { name: new RegExp(`^web.*${xHost}`) })).toHaveCount(1);
  await page.getByRole("option", { name: new RegExp(`^web.*${yHost}`) }).click();
  await expect(page.getByText("No threads in web yet")).toBeVisible();
  await expect(onX).toHaveCount(0);
  await page.getByRole("combobox", { name: "Filter threads by project: web" }).click();
  await page.getByRole("option", { name: "All projects" }).click();
  await expect(onX).toBeVisible();

  // Search lists matching threads; Enter opens the highlighted one.
  const field = page.getByRole("combobox", { name: "Search threads" });
  await field.fill("on x");
  await expect(
    page.getByRole("listbox", { name: "Thread search results" }).getByRole("option"),
  ).toHaveCount(1);
  await field.press("Enter");
  await expect(onX).toHaveAttribute("aria-current", "page");

  // Adding a project asks on which node.
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const adding = page.getByRole("dialog", { name: "Add project" });
  await adding.getByRole("combobox", { name: "Node" }).click();
  await page.getByRole("option", { name: xHost, exact: true }).click();
  await expect(adding.getByText(`A folder on ${xHost}.`, { exact: false })).toBeVisible();
  await adding.getByRole("button", { name: "Cancel" }).click();

  // The node's actions live in its menu in settings → Nodes (the `node.actions` slot).
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  await page.getByRole("button", { name: `More actions for ${yHost}` }).click();
  for (const item of [
    "New thread without a project",
    "Add project",
    "Rename on this device",
    "Copy address",
    "Disconnect",
  ]) {
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "Rename on this device" }).click();

  // D74: the dialog's footer is part of its panel, not a box below it.
  const dialog = page.getByRole("dialog", { name: "Rename node" });
  const panel = await box(dialog);
  const rename = await box(dialog.getByRole("button", { name: "Rename" }));
  const field2 = await box(dialog.getByRole("textbox", { name: "Node name" }));
  expect(rename.y + rename.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(rename.y).toBeGreaterThan(field2.y + field2.height);
  const dialogShot = info.outputPath("rename-node-dialog.png");
  await page.screenshot({ path: dialogShot });
  await info.attach("rename-node-dialog", { path: dialogShot, contentType: "image/png" });

  await dialog.getByRole("textbox", { name: "Node name" }).fill("studio");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(onY.getByLabel("On studio", { exact: true })).toBeAttached();
});

test("D71: threads quiet for three days settle onto the Settled shelf", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "first quiet thread");
  await addThread(x, "second quiet thread");
  // The client's clock four days on: both threads saw no activity for three days.
  await page.clock.install({ time: Date.now() + 4 * 24 * 60 * 60 * 1000 });
  await page.clock.resume();
  await page.goto(`${x.ui}#token=${x.token}`);

  const shelf = page.getByRole("button", { name: "Settled (2)" });
  await expect(shelf).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("sidebar-row-card")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-row-slim")).toHaveCount(0);

  await shelf.click();
  const expanded = page.getByRole("button", { name: "Settled", exact: true });
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  // Most recently settled first, as slim rows.
  await expect(page.getByTestId("sidebar-row-slim")).toHaveText([
    /second quiet thread/,
    /first quiet thread/,
  ]);
  await threadRow(page, "first quiet thread").click();
  await expect(threadRow(page, "first quiet thread")).toHaveAttribute("aria-current", "page");
  const shot = info.outputPath("sidebar-settled.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-settled", { path: shot, contentType: "image/png" });

  // Collapsed again, the open thread stays in sight.
  await expanded.click();
  await expect(page.getByTestId("sidebar-row-slim")).toHaveCount(1);
  await expect(threadRow(page, "first quiet thread")).toBeVisible();
});
