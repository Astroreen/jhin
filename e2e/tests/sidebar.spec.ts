import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { expectOpenConnections, newThreadOn } from "./support/ui.ts";

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

test("D70: one list of projects; rows name their node only while several nodes are shown", async ({
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
  // One node: its rows say nothing about where they live.
  await expect(page.getByRole("list", { name: "Threads of No project" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Threads of web" })).toBeVisible();
  await expect(page.locator("[data-host-indicator]")).toHaveCount(0);
  const oneNode = info.outputPath("sidebar-one-node.png");
  await page.screenshot({ path: oneNode });
  await info.attach("sidebar-one-node", { path: oneNode, contentType: "image/png" });

  // D71: settings sits at the right end of the sidebar's footer.
  const settings = await box(page.getByRole("button", { name: "Settings", exact: true }));
  const palette = await box(page.getByRole("button", { name: "Command palette" }));
  const search = await box(page.getByRole("searchbox", { name: "Search threads" }));
  expect(settings.x).toBeGreaterThan(palette.x);
  expect(settings.x).toBeGreaterThan(search.x + search.width / 2);

  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Node URL" }).fill(y.rpc);
  await page.getByRole("textbox", { name: "Token" }).fill(y.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expectOpenConnections(page, 2);
  await newThreadOn(page, yHost);
  await send(page, "on y");

  // Two nodes, no section per node: every project and thread row names its node, and the
  // two projects called "web" stay apart.
  const onX = page.getByRole("list", { name: `Threads of No project on ${xHost}` });
  const onY = page.getByRole("list", { name: `Threads of No project on ${yHost}` });
  await expect(onX.getByRole("button", { name: "on x", exact: true })).toBeVisible();
  await expect(onY.getByRole("button", { name: "on y", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(onX.getByLabel(`On ${xHost}`, { exact: true })).toBeVisible();
  await expect(onY.getByLabel(`On ${yHost}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: `Threads of web on ${xHost}` })).toBeVisible();
  await expect(page.getByRole("list", { name: `Threads of web on ${yHost}` })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Node / })).toHaveCount(0);
  const shot = info.outputPath("sidebar-two-nodes.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-two-nodes", { path: shot, contentType: "image/png" });

  // Adding a project asks on which node.
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const adding = page.getByRole("dialog", { name: "Add project" });
  await adding.getByRole("combobox", { name: "Node" }).click();
  await page.getByRole("option", { name: xHost, exact: true }).click();
  await expect(adding.getByText(`A folder on ${xHost}.`, { exact: false })).toBeVisible();
  await adding.getByRole("button", { name: "Cancel" }).click();

  // The node's actions moved to its menu in settings → Nodes (the `node.actions` slot).
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

  // D72: the dialog's footer is part of its panel, not a box below it.
  const dialog = page.getByRole("dialog", { name: "Rename node" });
  const panel = await box(dialog);
  const rename = await box(dialog.getByRole("button", { name: "Rename" }));
  const field = await box(dialog.getByRole("textbox", { name: "Node name" }));
  expect(rename.y + rename.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(rename.y).toBeGreaterThan(field.y + field.height);
  const dialogShot = info.outputPath("rename-node-dialog.png");
  await page.screenshot({ path: dialogShot });
  await info.attach("rename-node-dialog", { path: dialogShot, contentType: "image/png" });

  await dialog.getByRole("textbox", { name: "Node name" }).fill("studio");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("list", { name: "Threads of No project on studio" })).toBeVisible();
  await expect(page.getByLabel("On studio", { exact: true }).first()).toBeVisible();
});
