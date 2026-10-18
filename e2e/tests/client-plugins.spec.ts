import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, writeConfig, type RunningNode } from "./support/node.ts";

/** A user client plugin as a plain ES module: no build step, shared packages from the import map. */
function writeButtonPlugin(home: string, label: string): string {
  const root = Path.join(home, "plugins", "acme-hello");
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: "acme-hello",
      type: "module",
      jhin: {
        id: "acme.hello",
        version: "1.0.0",
        apiVersion: 1,
        side: "client",
        requires: { "ui.slots": "^1" },
        entry: "index.js",
      },
    }),
  );
  Fs.writeFileSync(path(root, "label.js"), `export const label = ${JSON.stringify(label)};\n`);
  Fs.writeFileSync(
    path(root, "index.js"),
    `import { createElement } from "react";
import { definePlugin } from "@jhin/sdk";
import { Button, UI_SLOTS_CAPABILITY } from "@jhin/ui";
import { label } from "./label.js";

export default definePlugin({
  activate(context) {
    const slots = context.services.get(UI_SLOTS_CAPABILITY);
    context.subscriptions.add(
      slots.contribute("sidebar.actions", {
        id: "acme.hello.button",
        component: () => createElement(Button, { size: "xs", variant: "outline" }, label),
      }),
    );
  },
});
`,
  );
  return root;
}

const path = (...parts: string[]) => Path.join(...parts);

let node: RunningNode | undefined;
test.afterEach(async () => {
  await node?.stop();
  node = undefined;
});

test("a user plugin adds a sidebar button without a rebuild and hot reloads", async ({ page }) => {
  let root = "";
  node = await startNode({
    watch: true,
    setup: (home) => void (root = writeButtonPlugin(home, "Hello v1")),
  });
  await page.goto(`${node.ui}#token=${node.token}`);
  const actions = page.getByRole("toolbar", { name: "Sidebar actions" });
  await expect(actions.getByRole("button", { name: "Hello v1" })).toBeVisible();
  // The page must not reload: this marker would be lost.
  await page.evaluate(() => Object.assign(window, { untouched: true }));

  // A file the entry imports, not the entry itself.
  Fs.writeFileSync(Path.join(root, "label.js"), 'export const label = "Hello v2";\n');

  await expect(actions.getByRole("button", { name: "Hello v2" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Hello v1" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { untouched?: boolean }).untouched)).toBe(
    true,
  );
});

test("config hides a first-party contribution, live", async ({ page }) => {
  node = await startNode({ watch: true });
  await page.goto(`${node.ui}#token=${node.token}`);
  const inspector = page.getByRole("button", { name: "Inspector" });
  await expect(inspector).toBeVisible();

  writeConfig(node.home, { "jhin.ui": { hide: { "sidebar.actions": ["jhin.inspector.toggle"] } } });

  await expect(inspector).toHaveCount(0);
  await expect(page.getByLabel("Connection open")).toBeVisible();
});

test("jhin client serves only the web client and connects to a remote node", async ({ page }) => {
  const remote = await startNode({ mode: "serve" });
  try {
    node = await startNode({ mode: "client" });
    await page.goto(node.ui);

    await page.getByRole("textbox", { name: "Node URL" }).fill(remote.rpc);
    await page.getByRole("textbox", { name: "Token" }).fill(remote.token);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Start a thread" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("from the client");
    await page.getByRole("textbox", { name: "Message" }).press("Enter");

    await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: from the client");
  } finally {
    await remote.stop();
  }
});
