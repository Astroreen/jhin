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
  await page.getByRole("combobox", { name: "Config section" }).click();
  await page.getByRole("option", { name: /^Demo/ }).click();

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
