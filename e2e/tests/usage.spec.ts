import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

test("opens T3's Usage page from the sidebar with every agent's limits", async ({ page }, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: "Usage" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  // The fake agent reports a session and a weekly window (providers.md D1144).
  const agent = page.getByRole("region", { name: "Fake agent" });
  await expect(agent.getByRole("heading", { name: "Fake agent" })).toBeVisible();
  await expect(agent.getByRole("group", { name: "Session: 75% left" })).toBeVisible();
  await expect(agent.getByRole("group", { name: "Weekly: 40% left" })).toBeVisible();
  await expect(agent.getByRole("button", { name: /: 75% left, resets in/ })).toBeVisible();
  const shot = info.outputPath("usage-page.png");
  await page.screenshot({ path: shot });
  await info.attach("usage page", { path: shot, contentType: "image/png" });

  await page.getByRole("button", { name: "Refresh limits" }).click();
  await expect(agent.getByRole("group", { name: "Session: 75% left" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toHaveCount(0);
  // Escape closes it too, as the settings page.
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: "Usage" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toHaveCount(0);
});

/** A user plugin whose agent has a subscription with two reset credits banked (D1655, D1656). */
function writeCreditsAgent(home: string): void {
  const root = Path.join(home, "plugins", "acme-credits");
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: "acme-credits",
      version: "0.1.0",
      type: "module",
      jhin: {
        id: "acme.credits",
        version: "0.1.0",
        apiVersion: 1,
        side: "server",
        provides: {},
        requires: { "agent.registry": "^1" },
        entry: "index.js",
      },
    }),
  );
  Fs.writeFileSync(
    Path.join(root, "index.js"),
    `import { definePlugin } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    let credits = 2;
    let used = 92;
    const registry = context.services.get("agent.registry");
    context.subscriptions.add(
      registry.register({
        agentId: "acme.credits",
        name: "Credits",
        startTurn: () => ({ items: (async function* () {})(), interrupt() {} }),
        usageLimits: async () => ({
          checkedAt: new Date().toISOString(),
          windows: [
            {
              id: "session",
              kind: "session",
              label: "Session",
              usedPercent: used,
              resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
              windowDurationMins: 300,
            },
          ],
          resetCredits: {
            availableCount: credits,
            nextExpiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
          },
        }),
        consumeResetCredit: async () => {
          if (credits === 0) return "noCredit";
          credits -= 1;
          used = 0;
          return "reset";
        },
      }),
    );
  },
});
`,
  );
}

test("D1655–D1656: shows an account's reset credits and uses one after asking", async ({
  page,
}, info) => {
  const credited = await startNode({ setup: writeCreditsAgent });
  try {
    await page.goto(`${credited.ui}#token=${credited.token}`);
    await page
      .getByRole("navigation", { name: "Sidebar" })
      .getByRole("button", { name: "Usage" })
      .click();
    const agent = page.getByRole("region", { name: "Credits" });
    await expect(agent.getByText(/^2 reset credits banked · next expires in/)).toBeVisible();
    const shot = info.outputPath("reset-credits.png");
    await agent.screenshot({ path: shot });
    await info.attach("reset credits", { path: shot, contentType: "image/png" });
    await agent.getByRole("button", { name: "Use reset" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Use a reset credit?" });
    await expect(dialog).toBeVisible();
    const ask = info.outputPath("reset-credit-dialog.png");
    await dialog.screenshot({ path: ask });
    await info.attach("asking first", { path: ask, contentType: "image/png" });
    await dialog.getByRole("button", { name: "Use credit" }).click();
    await expect(agent.getByText("Reset applied. Your windows have cleared.")).toBeVisible();
    await expect(agent.getByText(/^1 reset credit banked/)).toBeVisible();
    const done = info.outputPath("reset-credit-used.png");
    await agent.screenshot({ path: done });
    await info.attach("a credit used", { path: done, contentType: "image/png" });
  } finally {
    await credited.stop();
  }
});
