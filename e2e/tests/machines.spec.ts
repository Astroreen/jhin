import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { expectOpenConnections, threadRow } from "./support/ui.ts";

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

/** A node whose owner named its machine kind in the node config file (`jhin.host.machine`). */
async function start(mode: "ui" | "serve", machine: string): Promise<RunningNode> {
  const node = await startNode({
    mode,
    setup: (home) =>
      Fs.writeFileSync(
        Path.join(home, "config.jsonc"),
        JSON.stringify({ "jhin.host": { machine } }, null, 2),
      ),
  });
  running.push(node);
  return node;
}

/** A project `name` and a thread in it with one finished turn, made through the node's API. */
async function addThread(node: RunningNode, name: string, text: string): Promise<void> {
  const path = Path.join(node.home, name);
  Fs.mkdirSync(path, { recursive: true });
  const project = await node.client().call<{ id: string }>("projects.create", { path });
  const thread = await node
    .client()
    .call<{ id: string }>("threads.create", { projectId: project.id });
  await node.client().call("threads.send", { threadId: thread.id, text });
}

/** The machine kind the icon inside `scope` draws. */
const machineIn = (scope: Locator) => scope.locator("svg[data-machine]");

/** A screenshot of the page, or of one part of it, in the report. */
async function shoot(
  target: Page | Locator,
  info: Pick<TestInfo, "outputPath" | "attach">,
  name: string,
) {
  const path = info.outputPath(`${name}.png`);
  await target.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D130–D133: every node shows the icon of its machine kind, and its owner can change it", async ({
  page,
}, info) => {
  const x = await start("ui", "laptop");
  const y = await start("serve", "cloud");
  const xHost = new URL(x.ui).host;
  const yHost = new URL(y.rpc).host;
  expect(await x.client().call("host.identity", {})).toMatchObject({ machine: "laptop" });
  await addThread(x, "web", "on x");
  await addThread(y, "api", "on y");

  await page.goto(`${x.ui}#token=${x.token}`);
  // One node: nothing says where a thread lives (D71), so no machine icon either.
  await expect(threadRow(page, "on x")).toBeVisible();
  await expect(page.locator("[data-host-indicator]")).toHaveCount(0);

  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Node URL" }).fill(y.rpc);
  await page.getByRole("textbox", { name: "Token" }).fill(y.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expectOpenConnections(page, 2);

  // Thread cards: the bottom-right icon is each node's own machine.
  const onX = threadRow(page, "on x");
  const onY = threadRow(page, "on y");
  await expect(machineIn(onX.getByLabel(`On ${xHost}`, { exact: true }))).toHaveAttribute(
    "data-machine",
    "laptop",
  );
  await expect(machineIn(onY.getByLabel(`On ${yHost}`, { exact: true }))).toHaveAttribute(
    "data-machine",
    "cloud",
  );
  await shoot(page, info, "sidebar-two-machines");

  // The project filter names each project's node with its icon.
  await page.getByRole("combobox", { name: "Filter threads by project" }).click();
  await expect(
    machineIn(page.getByRole("option", { name: new RegExp(`^web.*${xHost}`) })),
  ).toHaveAttribute("data-machine", "laptop");
  await expect(
    machineIn(page.getByRole("option", { name: new RegExp(`^api.*${yHost}`) })),
  ).toHaveAttribute("data-machine", "cloud");
  await shoot(page, info, "project-filter-machines");
  await page.keyboard.press("Escape");

  // The palette's projects, as T3 marks a project's environment.
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: "New thread in...", exact: true }).click();
  await expect(
    machineIn(palette.getByRole("option", { name: new RegExp(`^api\\s*${yHost}`) })),
  ).toHaveAttribute("data-machine", "cloud");
  await expect(
    machineIn(palette.getByRole("option", { name: new RegExp(`^No project\\s*${xHost}$`) })),
  ).toHaveAttribute("data-machine", "laptop");
  await shoot(page, info, "palette-machines");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // The add-project node picker.
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: "Add project", exact: true })
    .click();
  const adding = page.getByRole("dialog", { name: "Add project" });
  await adding.getByRole("combobox", { name: "Node" }).click();
  await expect(machineIn(page.getByRole("option", { name: yHost, exact: true }))).toHaveAttribute(
    "data-machine",
    "cloud",
  );
  await expect(machineIn(page.getByRole("option", { name: xHost, exact: true }))).toHaveAttribute(
    "data-machine",
    "laptop",
  );
  // The node list alone: the dialog also lists the folders of the machine's home.
  await shoot(page.getByRole("listbox"), info, "add-project-machines");
  await page.keyboard.press("Escape");
  await adding.getByRole("button", { name: "Cancel" }).click();

  // Settings → Nodes: each row leads with its machine, and T3's Icon menu changes it.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  const nodes = page.getByRole("region", { name: "Nodes" });
  await expect(nodes.locator('svg[data-machine="laptop"]')).toHaveCount(1);
  await expect(nodes.locator('svg[data-machine="cloud"]')).toHaveCount(1);
  await page.getByRole("button", { name: `More actions for ${yHost}` }).click();
  await page.getByRole("menuitem", { name: "Icon" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Cloud VM" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await shoot(page, info, "node-icon-menu");
  await page.getByRole("menuitemradio", { name: "Desktop" }).click();
  await expect(nodes.locator('svg[data-machine="desktop"]')).toHaveCount(1);
  await expect(nodes.locator('svg[data-machine="cloud"]')).toHaveCount(0);
  // Kept on the node, for every client: in its node config file.
  const file = JSON.parse(Fs.readFileSync(Path.join(y.home, "config.jsonc"), "utf8"));
  expect(file["jhin.host"]).toEqual({ machine: "desktop" });
  expect(await y.client().call("host.identity", {})).toMatchObject({ machine: "desktop" });
  // A radio item keeps the menu open, as in T3: Escape closes the submenu, then the menu.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemradio", { name: "Desktop" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await shoot(page, info, "settings-nodes-machines");

  // The same choice is a field of the node config form (jhin.host), and saving it there
  // changes the icon too.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Config section" }).click();
  await page.getByRole("option", { name: /^Host\s*jhin\.host/ }).click();
  const section = page.getByRole("region", { name: "Host", exact: true });
  const machine = section.getByRole("combobox", { name: "Machine" });
  await expect(machine).toContainText("Laptop");
  await machine.click();
  await page.getByRole("option", { name: "Workstation" }).click();
  await shoot(page, info, "node-config-machine");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(machineIn(onY.getByLabel(`On ${yHost}`, { exact: true }))).toHaveAttribute(
    "data-machine",
    "desktop",
  );
  await expect(machineIn(onX.getByLabel(`On ${xHost}`, { exact: true }))).toHaveAttribute(
    "data-machine",
    "mac-studio",
  );
  await shoot(page, info, "sidebar-after-changes");
});
