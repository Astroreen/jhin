import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import {
  startDevServer,
  startNode,
  writeConfig,
  type DevServer,
  type RunningNode,
} from "./support/node.ts";

/** A user client plugin as a plain ES module: no build step, shared packages from the import map. */
function writeButtonPlugin(home: string, label: string, id = "acme.hello"): string {
  const root = Path.join(home, "plugins", id.replace(".", "-"));
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: id.replace(".", "-"),
      type: "module",
      jhin: {
        id,
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
        id: "${id}.button",
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
let dev: DevServer | undefined;
test.afterEach(async () => {
  await dev?.stop();
  dev = undefined;
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

test("a user plugin dropped in while the page is open activates, and deactivates when removed", async ({
  page,
}) => {
  node = await startNode({ watch: true });
  await page.goto(`${node.ui}#token=${node.token}`);
  const actions = page.getByRole("toolbar", { name: "Sidebar actions" });
  await expect(actions.getByRole("button", { name: "Inspector" })).toBeVisible();
  await page.evaluate(() => Object.assign(window, { untouched: true }));

  const root = writeButtonPlugin(node.home, "Hello new");
  await expect(actions.getByRole("button", { name: "Hello new" })).toBeVisible();
  await test.info().attach("added", { body: await page.screenshot(), contentType: "image/png" });

  Fs.rmSync(root, { recursive: true });
  await expect(actions.getByRole("button", { name: "Hello new" })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "Inspector" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          jhin: { kernel: { inspect(): { plugins: { id: string }[] } } };
        }
      ).jhin.kernel
        .inspect()
        .plugins.some((plugin) => plugin.id === "acme.hello"),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { untouched?: boolean }).untouched)).toBe(
    true,
  );
});

test("a user plugin dropped in with a builtin's id replaces it; removing it brings the builtin back", async ({
  page,
}) => {
  node = await startNode({ watch: true });
  await page.goto(`${node.ui}#token=${node.token}`);
  const actions = page.getByRole("toolbar", { name: "Sidebar actions" });
  await expect(actions.getByRole("button", { name: "Inspector" })).toBeVisible();

  const root = writeButtonPlugin(node.home, "My inspector", "jhin.inspector");
  await expect(actions.getByRole("button", { name: "My inspector" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Inspector", exact: true })).toHaveCount(0);

  Fs.rmSync(root, { recursive: true });
  await expect(actions.getByRole("button", { name: "Inspector", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "My inspector" })).toHaveCount(0);
});

/** Reads `/client/events` and yields event names in arrival order. */
async function openEvents(ui: string): Promise<{ next(): Promise<string>; close(): void }> {
  const controller = new AbortController();
  const response = await fetch(`${ui}client/events`, { signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const match = /^event: (\S+)$/m.exec(buffer);
        if (match !== null) {
          buffer = buffer.slice(match.index + match[0].length);
          return match[1]!;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended");
        buffer += value;
      }
    },
    close: () => controller.abort(),
  };
}

test("the node sends `plugins` for client plugin list changes only, in order", async () => {
  node = await startNode({ watch: true });
  const events = await openEvents(node.ui);
  try {
    const rescan = () => node!.client().call("host.plugins.rescan");
    // A config change is the marker: it shows which events came before it.
    const configChanged = (marker: string) =>
      writeConfig(node!.home, { "jhin.ui": { hide: { "sidebar.actions": [marker] } } });

    // A server-only plugin added: no `plugins` before the marker.
    const server = Path.join(node.home, "plugins", "acme-server");
    Fs.mkdirSync(server, { recursive: true });
    Fs.writeFileSync(Path.join(server, "index.js"), "export default { activate() {} };\n");
    const manifest = (side: string) =>
      JSON.stringify({
        name: "acme-server",
        type: "module",
        jhin: { id: "acme.server", version: "1.0.0", apiVersion: 1, side, entry: "index.js" },
      });
    Fs.writeFileSync(Path.join(server, "package.json"), manifest("server"));
    await rescan();
    configChanged("a");
    expect(await events.next()).toBe("config");

    // The same plugin turned into a client plugin, then back: each changes the list.
    Fs.writeFileSync(Path.join(server, "package.json"), manifest("client"));
    await rescan();
    expect(await events.next()).toBe("plugins");
    Fs.writeFileSync(Path.join(server, "package.json"), manifest("server"));
    await rescan();
    expect(await events.next()).toBe("plugins");
    configChanged("b");
    expect(await events.next()).toBe("config");
  } finally {
    events.close();
  }
});

test("under vp dev, a user plugin loads with the app's shared modules and hot reloads", async ({
  page,
}) => {
  let root = "";
  node = await startNode({
    watch: true,
    setup: (home) => void (root = writeButtonPlugin(home, "Dev v1")),
  });
  dev = startDevServer(node.ui);
  await page.goto(`${await dev.ready()}#token=${node.token}`);
  const actions = page.getByRole("toolbar", { name: "Sidebar actions" });
  await expect(actions.getByRole("button", { name: "Dev v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
  await page.evaluate(() => Object.assign(window, { untouched: true }));

  Fs.writeFileSync(Path.join(root, "label.js"), 'export const label = "Dev v2";\n');

  await expect(actions.getByRole("button", { name: "Dev v2" })).toBeVisible();
  await test
    .info()
    .attach("dev-server", { body: await page.screenshot(), contentType: "image/png" });
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
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();
});

test("jhin client serves only the web client and connects to a remote node", async ({ page }) => {
  const remote = await startNode({ mode: "serve" });
  try {
    node = await startNode({ mode: "client" });
    await page.goto(node.ui);

    await page.getByRole("textbox", { name: "Node URL" }).fill(remote.rpc);
    await page.getByRole("textbox", { name: "Pairing code or token" }).fill(remote.token);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Start a thread" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("from the client");
    await page.getByRole("textbox", { name: "Message" }).press("Enter");

    await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: from the client");
  } finally {
    await remote.stop();
  }
});

test("config reorders contributions in a slot, live", async ({ page }) => {
  node = await startNode({ watch: true, setup: (home) => void writeButtonPlugin(home, "Hello") });
  await page.goto(`${node.ui}#token=${node.token}`);
  const actions = page.getByRole("toolbar", { name: "Sidebar actions" }).getByRole("button");
  // Default order: by order, then id — "Add node" (order -10), then "acme.hello.button", then the inspector.
  await expect(actions).toHaveText(["", "Hello", ""]);
  await expect(actions.nth(0)).toHaveAccessibleName("Add node");
  await expect(actions.nth(2)).toHaveAccessibleName("Inspector");

  writeConfig(node.home, {
    "jhin.ui": { order: { "sidebar.actions": ["jhin.inspector.toggle"] } },
  });

  await expect(actions.nth(0)).toHaveAccessibleName("Inspector");
  await expect(actions.nth(2)).toHaveText("Hello");
});
