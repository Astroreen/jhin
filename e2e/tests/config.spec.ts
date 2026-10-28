import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

/** A user plugin whose section has a title but no field descriptions: the file's comments give them. */
function writeDemoPlugin(home: string): void {
  const root = Path.join(home, "plugins", "acme-demo");
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: "acme-demo",
      version: "0.1.0",
      type: "module",
      jhin: {
        id: "acme.demo",
        version: "0.1.0",
        apiVersion: 1,
        side: "server",
        provides: {},
        entry: "index.js",
      },
    }),
  );
  Fs.writeFileSync(
    Path.join(root, "index.js"),
    `import { definePlugin, z } from "@jhin/sdk";
const Config = z
  .object({
    enabled: z.boolean().default(true),
    label: z.string().default("demo"),
    level: z.enum(["low", "medium", "high"]).default("medium"),
    retries: z.number().int().min(0).max(10).default(3),
    mode: z.enum(["auto", "custom"]).default("auto"),
    instructions: z.string().optional().meta({ when: { mode: "custom" } }),
    env: z.record(z.string(), z.string()).optional(),
  })
  .meta({ title: "Demo" });
export default definePlugin({
  activate(context) {
    context.config.define("acme.demo", Config);
  },
});
`,
  );
  Fs.writeFileSync(
    Path.join(home, "config.jsonc"),
    `{
  // The demo plugin.
  "acme.demo": {
    // Turns the demo on.
    "enabled": true,
    // What the demo calls itself.
    "label": "first"
  }
}
`,
  );
}

let node: RunningNode | undefined;
test.afterEach(async () => {
  await node?.stop();
  node = undefined;
});

test("D80: edits a config section as a form and saves it to the node file, keeping its comments", async ({
  page,
}, info) => {
  node = await startNode({ setup: writeDemoPlugin });
  const file = Path.join(node.home, "config.jsonc");
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Demo", exact: true })
    .click();

  const section = page.getByRole("region", { name: "Demo" });
  // D81: without a description in the schema, the comment above the key describes it.
  await expect(section.getByText("Turns the demo on.")).toBeVisible();
  await expect(section.getByText("What the demo calls itself.")).toBeVisible();
  const save = section.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();

  await section.getByRole("switch", { name: "Enabled" }).click();
  await section.getByRole("textbox", { name: "Label" }).fill("edge");
  await section.getByRole("combobox", { name: "Level" }).click();
  await page.getByRole("option", { name: "high" }).click();
  // Checked where it is typed: the error is next to the field and nothing is saved.
  const retries = section.getByRole("textbox", { name: "Retries" });
  await retries.fill("11");
  await expect(retries).toHaveAttribute("aria-invalid", "true");
  await expect(retries).toHaveAccessibleDescription("Must be at most 10");
  await expect(save).toBeDisabled();
  const invalid = info.outputPath("config-form-invalid.png");
  await page.screenshot({ path: invalid, fullPage: true });
  await info.attach("config-form-invalid", { path: invalid, contentType: "image/png" });
  await retries.fill("4");
  await expect(retries).not.toHaveAttribute("aria-invalid");

  const shot = info.outputPath("config-form.png");
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach("config-form", { path: shot, contentType: "image/png" });

  await save.click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  const text = Fs.readFileSync(file, "utf8");
  expect(text).toContain("// Turns the demo on.");
  expect(text).toContain("// The demo plugin.");
  expect(await node.client().call("host.config.get", { section: "acme.demo" })).toMatchObject({
    value: { enabled: false, label: "edge", level: "high", retries: 4 },
    layers: { node: { enabled: false, label: "edge", level: "high", retries: 4 } },
  });
  await expect(save).toBeDisabled();

  // A key reset to its default leaves the file; the others stay as they are.
  await section.getByRole("button", { name: "Reset Label to default" }).click();
  await expect(section.getByRole("textbox", { name: "Label" })).toHaveAttribute(
    "placeholder",
    "demo",
  );
  await save.click();
  // A save clears the last outcome, so this one is the reset's.
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(Fs.readFileSync(file, "utf8")).not.toContain('"label"');
  expect(await node.client().call("host.config.get", { section: "acme.demo" })).toMatchObject({
    value: { enabled: false, label: "demo", level: "high", retries: 4 },
  });

  // The escape hatch: the same section as JSON.
  await section.getByRole("button", { name: "Edit as JSON" }).click();
  await expect(section.getByRole("textbox", { name: "acme.demo in the node file" })).toHaveValue(
    /"retries": 4/,
  );
});

test("D441: a shortcut that another command has warns of the conflict", async ({ page }, info) => {
  node = await startNode();
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Keybindings" })
    .click();
  const conflict = page.getByRole("img", { name: /^Conflicts with / });
  await expect(
    page.getByRole("button", { name: "Change shortcut of Toggle sidebar" }),
  ).toBeVisible();
  await expect(conflict).toHaveCount(0);

  // Give "Toggle sidebar" (always) the palette's ⌘/Ctrl+K: both rows warn.
  await page.getByRole("button", { name: "Change shortcut of Toggle sidebar" }).click();
  await page.getByRole("textbox", { name: "New shortcut for Toggle sidebar" }).press("Control+k");
  await expect(page.getByRole("img", { name: "Conflicts with Command palette." })).toBeVisible();
  await expect(page.getByRole("img", { name: "Conflicts with Toggle sidebar." })).toBeVisible();
  await page.getByRole("img", { name: "Conflicts with Command palette." }).hover();
  await expect(
    page.getByText(
      "Conflicts with Command palette. The most recent matching binding wins when both conditions can apply.",
    ),
  ).toBeVisible();
  const shot = info.outputPath("keybinding-conflict.png");
  await page.screenshot({ path: shot });
  await info.attach("keybinding-conflict", { path: shot, contentType: "image/png" });

  // Reset: the conflict goes with it.
  await page.getByRole("button", { name: "Reset shortcut of Toggle sidebar" }).click();
  await expect(conflict).toHaveCount(0);
});

test("D477: edits the project file, which wins over the node file", async ({ page }, info) => {
  node = await startNode({ setup: writeDemoPlugin });
  // The node runs in its home: the project file is the home's .jhin/config.jsonc.
  const projectFile = Path.join(node.home, ".jhin", "config.jsonc");
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Demo", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Config file" }).click();
  await page.getByRole("option", { name: "Project file" }).click();

  const section = page.getByRole("region", { name: "Demo" });
  await expect(
    section.getByText('The node file sets "first"; this file wins over it.'),
  ).toBeVisible();
  await section.getByRole("textbox", { name: "Label" }).fill("project");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(JSON.parse(Fs.readFileSync(projectFile, "utf8"))).toMatchObject({
    "acme.demo": { label: "project" },
  });
  expect(await node.client().call("host.config.get", { section: "acme.demo" })).toMatchObject({
    value: { label: "project" },
    layers: { node: { label: "first" }, project: { label: "project" } },
  });
  const shot = info.outputPath("config-project-file.png");
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach("config-project-file", { path: shot, contentType: "image/png" });
});

test("D479: edits keybinding rules as a list of groups", async ({ page }, info) => {
  node = await startNode({ setup: writeDemoPlugin });
  const file = Path.join(node.home, "config.jsonc");
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Keybindings", exact: true })
    .click();

  const section = page.getByRole("region", { name: "Keybindings" });
  await section.getByRole("button", { name: "Add" }).click();
  await section.getByRole("button", { name: "Add" }).click();
  const first = section.getByRole("group", { name: "Rules 1" });
  // A required key is reported until it is filled in, and blocks the save.
  await expect(first.getByRole("textbox", { name: "Command" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await first.getByRole("textbox", { name: "Command" }).fill("palette.open");
  // An empty key unbinds: it is kept as "" (D478).
  await first.getByRole("textbox", { name: "Key" }).fill("x");
  await first.getByRole("textbox", { name: "Key" }).fill("");
  const second = section.getByRole("group", { name: "Rules 2" });
  await second.getByRole("textbox", { name: "Key" }).fill("mod+shift+p");
  await second.getByRole("textbox", { name: "Command" }).fill("settings.open");
  await section.getByRole("button", { name: "Move Rules 2 up" }).click();
  const shot = info.outputPath("config-list-of-groups.png");
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach("config-list-of-groups", { path: shot, contentType: "image/png" });

  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(
    await node.client().call("host.config.get", { section: "jhin.keybindings" }),
  ).toMatchObject({
    layers: {
      node: {
        rules: [
          { key: "mod+shift+p", command: "settings.open" },
          { key: "", command: "palette.open" },
        ],
      },
    },
  });
  // The demo section's comments in the same file are untouched.
  expect(Fs.readFileSync(file, "utf8")).toContain("// Turns the demo on.");
});

test("D480, D481: renames a record key in place and shows a field for its sibling's value", async ({
  page,
}, info) => {
  node = await startNode({ setup: writeDemoPlugin });
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Demo", exact: true })
    .click();
  const section = page.getByRole("region", { name: "Demo" });

  // D481: "Instructions" shows only while Mode is custom.
  await expect(section.getByRole("textbox", { name: "Instructions" })).toHaveCount(0);
  await section.getByRole("combobox", { name: "Mode" }).click();
  await page.getByRole("option", { name: "custom" }).click();
  await section.getByRole("textbox", { name: "Instructions" }).fill("be brief");

  // D480: a key added, then renamed in place.
  await section.getByRole("textbox", { name: "New key of Env" }).fill("TOKEN");
  await section.getByRole("button", { name: "Add" }).click();
  await section.getByRole("textbox", { name: "Env TOKEN" }).fill("x");
  const key = section.getByRole("textbox", { name: "Key TOKEN of Env" });
  await key.fill("API_TOKEN");
  await key.press("Enter");
  await expect(section.getByRole("textbox", { name: "Key API_TOKEN of Env" })).toBeVisible();
  const shot = info.outputPath("config-rename-when.png");
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach("config-rename-when", { path: shot, contentType: "image/png" });

  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(await node.client().call("host.config.get", { section: "acme.demo" })).toMatchObject({
    value: { mode: "custom", instructions: "be brief", env: { API_TOKEN: "x" } },
  });
});

test("D483, D484: a change made elsewhere reaches the open page, keeping the edits on top", async ({
  page,
}, info) => {
  node = await startNode({ setup: writeDemoPlugin });
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Demo", exact: true })
    .click();
  const section = page.getByRole("region", { name: "Demo" });
  await expect(section.getByRole("textbox", { name: "Label" })).toHaveValue("first");

  // Without edits: the page shows what another client saved.
  await node.client().call("host.config.patch", {
    layer: "node",
    section: "acme.demo",
    values: { label: "from elsewhere" },
  });
  await expect(section.getByRole("textbox", { name: "Label" })).toHaveValue("from elsewhere");

  // With edits: they stay, on top of the new file.
  await section.getByRole("textbox", { name: "Retries" }).fill("7");
  await node.client().call("host.config.patch", {
    layer: "node",
    section: "acme.demo",
    values: { level: "low" },
  });
  await expect(
    section.getByText("Changed on the node while you edited; your changes are kept on top of it."),
  ).toBeVisible();
  await expect(section.getByRole("combobox", { name: "Level" })).toContainText("low");
  await expect(section.getByRole("textbox", { name: "Retries" })).toHaveValue("7");
  const shot = info.outputPath("config-pushed.png");
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach("config-pushed", { path: shot, contentType: "image/png" });

  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(await node.client().call("host.config.get", { section: "acme.demo" })).toMatchObject({
    layers: { node: { label: "from elsewhere", level: "low", retries: 7 } },
  });
});

test("D1172–D1173: the Threads section keeps threads with a PR, and per project", async ({
  page,
}, info) => {
  node = await startNode();
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Threads", exact: true })
    .click();
  const section = page.getByRole("region", { name: "Threads" });
  await expect(
    section.getByText(
      "Inactivity does not settle threads with a pull request. Merge and close still do.",
    ),
  ).toBeVisible();
  // The record of projects is edited in the page's project scope, not as a field (D1463).
  await expect(section.getByText("Settling per project")).toHaveCount(0);
  await section.getByRole("switch", { name: "Keep threads with a PR" }).click();
  await section.getByText("Keep threads with a PR").scrollIntoViewIfNeeded();
  const shot = info.outputPath("keep-threads-with-a-pr.png");
  await page.screenshot({ path: shot });
  await info.attach("keep-threads-with-a-pr", { path: shot, contentType: "image/png" });
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(await node.client().call("host.config.get", { section: "jhin.threads" })).toMatchObject({
    value: { autoSettleKeepPullRequests: true, projects: {} },
  });
});

test("D1126: T3's worktree branch naming settings, each field shown for its mode", async ({
  page,
}, info) => {
  node = await startNode({});
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Source control", exact: true })
    .click();
  const section = page.getByRole("region", { name: "Source control" });

  const mode = section.getByRole("combobox", { name: "Worktree branch naming" });
  await expect(mode).toHaveText("Static prefix");
  // The default shows as the empty field's placeholder.
  await expect(section.getByRole("textbox", { name: "Branch prefix" })).toHaveAttribute(
    "placeholder",
    "jhin",
  );
  await expect(section.getByRole("textbox", { name: "Branch naming instructions" })).toHaveCount(0);
  await mode.click();
  await expect(page.getByRole("option", { name: "Semantic prefix" })).toBeVisible();
  await page.getByRole("option", { name: "Custom instructions" }).click();
  await expect(section.getByRole("textbox", { name: "Branch prefix" })).toHaveCount(0);
  await section
    .getByRole("textbox", { name: "Branch naming instructions" })
    .fill("Use julius/ followed by the issue ID.");
  const shot = info.outputPath("branch-naming-settings.png");
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach("branch-naming-settings", { path: shot, contentType: "image/png" });

  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("list", { name: "Outcome" })).toContainText("applied");
  expect(
    await node.client().call("host.config.get", { section: "jhin.source-control" }),
  ).toMatchObject({
    value: {
      branchNamingMode: "custom",
      branchNameInstructions: "Use julius/ followed by the issue ID.",
    },
  });
});

test("D1463: T3's project scope edits a project's own settings, showing what it inherits", async ({
  page,
}, info) => {
  node = await startNode({ mode: "ui" });
  const dir = Path.join(node.home, "acme");
  Fs.mkdirSync(dir, { recursive: true });
  const project = await node
    .client()
    .call<{ id: string }>("projects.create", { path: dir, name: "acme" });
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config" })
    .click();
  await page
    .getByRole("list", { name: "Node config outline" })
    .getByRole("button", { name: "Source control", exact: true })
    .click();
  const section = page.getByRole("region", { name: "Source control" });

  // All projects: the node's own settings, the record of projects is no field.
  // The scope is the page's, above every section (D1622).
  await expect(page.getByText("Applying settings for")).toBeVisible();
  await expect(section.getByRole("group", { name: "Settings per project" })).toHaveCount(0);

  await page.getByRole("button", { name: "Project scope: All projects" }).click();
  await page.getByRole("menuitemradio", { name: "acme" }).click();
  // The project's keys edit its entry; the rest are the node's alone.
  const naming = section.getByRole("combobox", { name: "Worktree branch naming" });
  await expect(naming).toHaveText(/Static prefix/);
  // Inherited: the node sets none, the project has no t3.json, so T3's built-in.
  await expect(section.getByRole("combobox", { name: "Worktree submodules" })).toHaveText(
    /Recursive/,
  );
  await expect(section.getByRole("group", { name: "Node-wide settings" })).toBeVisible();
  await expect(section.getByRole("switch", { name: "Watch repositories" })).toBeDisabled();
  await naming.click();
  await page.getByRole("option", { name: "Custom instructions", exact: true }).click();
  // T3's text area for the instructions, shown for custom naming.
  const instructions = section.getByRole("textbox", { name: "Branch naming instructions" });
  await instructions.fill("Use the ticket id.\nKeep it short.");
  // T3's "Automatic worktree cleanup": Inherit, Off or Custom.
  const cleanup = section.getByRole("combobox", { name: "Mode" });
  await expect(cleanup).toHaveText(/Inherit/);
  await cleanup.click();
  await page.getByRole("option", { name: "Off", exact: true }).click();
  // The whole scoped form in one picture, with the layers of a setting open.
  await page.setViewportSize({ width: 1280, height: 1300 });
  await page.getByText("Applying settings for").scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: /^Worktree branch naming: Project override/ }).click();
  const layers = page.getByRole("list", { name: "Where Worktree branch naming comes from" });
  await expect(layers.getByRole("listitem")).toHaveText([
    /Project\s*Custom instructions/,
    /Inherits/,
    /Default\s*Static prefix/,
  ]);
  const shot = info.outputPath("project-scope.png");
  await page.screenshot({ path: shot });
  await info.attach("project-scope", { path: shot, contentType: "image/png" });
  await page.keyboard.press("Escape");

  const save = section.getByRole("button", { name: "Save" });
  await save.click();
  // Read back: nothing is left unsaved.
  await expect(save).toBeDisabled();
  const saved = await node
    .client()
    .call<{ layers: { node?: Record<string, unknown> } }>("host.config.get", {
      section: "jhin.source-control",
    });
  expect(saved.layers.node?.["projects"]).toEqual({
    [project.id]: {
      branchNamingMode: "custom",
      branchNameInstructions: "Use the ticket id.\nKeep it short.",
      worktreeCleanup: { mode: "off" },
    },
  });

  // Reset to inherited value: the entry goes with its last key.
  await section
    .getByRole("button", { name: "Reset Branch naming instructions to inherited value" })
    .click();
  await section
    .getByRole("button", { name: "Reset Worktree branch naming to inherited value" })
    .click();
  await cleanup.click();
  await page.getByRole("option", { name: "Inherit", exact: true }).click();
  await save.click();
  await expect(save).toBeDisabled();
  const reset = await node
    .client()
    .call<{ layers: { node?: Record<string, unknown> } }>("host.config.get", {
      section: "jhin.source-control",
    });
  expect(reset.layers.node?.["projects"]).toBeUndefined();
});

test("D1622–D1626: every section on one page, jumped to from the navigation, edits kept and named", async ({
  page,
}, info) => {
  node = await startNode({ setup: writeDemoPlugin });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  const opened = Date.now();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Node config", exact: true })
    .click();
  // No section picker: the sections are listed under the page in the navigation (D1623).
  await expect(page.getByRole("combobox", { name: "Config section" })).toHaveCount(0);
  const outline = page.getByRole("list", { name: "Node config outline" });
  const entries = outline.getByRole("button");
  await expect(entries.first()).toBeVisible();
  const titles = await entries.allTextContents();
  expect(titles.length).toBeGreaterThan(5);
  // The first section's form, read with every other section in one call (D1624).
  const first = page.getByRole("region", { name: titles[0]!, exact: true });
  await expect(first.getByRole("button", { name: "Save" })).toBeVisible();
  info.annotations.push({
    type: "timing",
    description: `Node config: first section's form shown ${Date.now() - opened} ms after the click`,
  });

  // A click brings the section into view, focuses its heading and names it in the route (D1628).
  await outline.getByRole("button", { name: "Demo", exact: true }).click();
  const demo = page.getByRole("region", { name: "Demo", exact: true });
  await expect(demo.getByRole("heading", { name: "Demo" })).toBeFocused();
  await expect(demo.getByRole("heading", { name: "Demo" })).toBeInViewport();
  await expect(page).toHaveURL(/[#&]a=acme\.demo(&|$)/);
  await expect(outline.getByRole("button", { name: "Demo", exact: true })).toHaveAttribute(
    "aria-current",
    "location",
  );
  const desktop = info.outputPath("config-one-page.png");
  await page.screenshot({ path: desktop });
  await info.attach("config-one-page", { path: desktop, contentType: "image/png" });

  // A reload opens at the section the route names.
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Demo", exact: true }).getByRole("heading", { name: "Demo" }),
  ).toBeInViewport();

  // An unsaved edit belongs to its section and survives scrolling away and back (D1626).
  await demo.getByRole("textbox", { name: "Label" }).fill("edited");
  const last = titles[titles.length - 1]!;
  await outline.getByRole("button", { name: last, exact: true }).click();
  await expect(
    page.getByRole("region", { name: last, exact: true }).getByRole("heading", { name: last }),
  ).toBeInViewport();
  await expect(demo.getByRole("heading", { name: "Demo" })).not.toBeInViewport();
  await outline.getByRole("button", { name: "Demo", exact: true }).click();
  await expect(demo.getByRole("textbox", { name: "Label" })).toHaveValue("edited");

  // Leaving the page asks first, naming the section that would lose its edits.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  const leave = page.getByRole("alertdialog", { name: "Discard the changes to Demo?" });
  await leave.getByRole("button", { name: "Cancel" }).click();
  await expect(demo.getByRole("textbox", { name: "Label" })).toHaveValue("edited");
  // So does choosing the other file.
  await page.getByRole("combobox", { name: "Config file" }).click();
  await page.getByRole("option", { name: "Project file" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard the changes to Demo?" })
    .getByRole("button", { name: "Discard" })
    .click();
  await expect(page.getByRole("combobox", { name: "Config file" })).toHaveText("Project file");
  await expect(demo.getByRole("textbox", { name: "Label" })).toHaveValue("");

  // Narrow, the navigation folds away and the outline is a menu (D1623).
  await page.setViewportSize({ width: 420, height: 860 });
  await page.getByRole("button", { name: "Jump to section" }).click();
  await expect(page.getByRole("menuitem", { name: /^Demo/ })).toBeVisible();
  const narrow = info.outputPath("config-one-page-narrow.png");
  await page.screenshot({ path: narrow });
  await info.attach("config-one-page-narrow", { path: narrow, contentType: "image/png" });
  await page.getByRole("menuitem", { name: new RegExp(`^${last}`) }).click();
  await expect(
    page.getByRole("region", { name: last, exact: true }).getByRole("heading", { name: last }),
  ).toBeInViewport();
});
