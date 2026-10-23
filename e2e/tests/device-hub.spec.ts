// The device hub in the Device panel (docs/plans/preview.md, D1206–D1209), end to end against
// the fakes of support/device-hub-fakes.ts.
import * as Fs from "node:fs";

import { expect, test, type TestInfo, type Page } from "@playwright/test";

import { fakeTools } from "./support/device-hub-fakes.ts";
import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
let tools: ReturnType<typeof fakeTools>;
test.beforeAll(async () => {
  tools = fakeTools();
  node = await startNode({
    config: {
      "jhin.devices": { xcrun: tools.xcrun, npm: tools.npm, hub: true, onboardingCompleted: true },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D1208: an open simulator streams from the device hub and takes touches and the rail's Home", async ({
  page,
}, info) => {
  // The simulator's screen, as a JPEG the fake hub streams.
  await page.setViewportSize({ width: 360, height: 720 });
  await page.setContent(
    `<body style="margin:0;background:#0b5cad;font:32px sans-serif;color:white"><div style="padding:48px 24px">Hello from SIM-1</div></body>`,
  );
  Fs.writeFileSync(tools.jpeg, await page.screenshot({ type: "jpeg" }));
  await page.setViewportSize({ width: 1280, height: 800 });
  // No WebCodecs: the panel takes serve-sim's MJPEG feed, as T3 does then.
  await page.addInitScript(() => {
    delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("a simulator please");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: a simulator please");
  const threadId = decodeURIComponent(/[#&]t=([^&]+)/.exec(page.url())![1]!);

  // An agent opens the simulator: the hub installs and starts, the panel streams it.
  await node.client().call("device.open", { threadId, deviceId: "SIM-1" });
  const panel = page.getByRole("complementary", { name: "Device panel" });
  const screen = panel.getByRole("application", { name: "iOS Simulator screen" });
  await expect(screen).toBeVisible();
  await expect(panel.getByText("Connecting video…")).toBeHidden();
  const home = panel.getByRole("button", { name: "Home" });
  await expect(home).toBeEnabled();
  await shot(page, info, "device-hub-stream");

  // The middle of the device's frame, then the rail's Home.
  await screen.locator(":scope > div").first().click();
  await home.click();
  const sent = await tools.inputs(3);
  expect(sent.map((each) => each.tag)).toEqual([0x03, 0x03, 0x04]);
  expect(sent[0]!.body).toMatchObject({ type: "begin" });
  expect(sent[1]!.body).toMatchObject({ type: "end" });
  const touch = sent[0]!.body as { x: number; y: number };
  expect(touch.x).toBeCloseTo(0.5, 1);
  expect(touch.y).toBeCloseTo(0.5, 1);
  expect(sent[2]!.body).toEqual({ button: "home" });
});

test("D1333: the device tools beside the screen read and change the simulator's settings", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("device tools please");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(
    "Echo: device tools please",
  );
  const threadId = decodeURIComponent(/[#&]t=([^&]+)/.exec(page.url())![1]!);
  await node.client().call("device.open", { threadId, deviceId: "SIM-1" });
  const panel = page.getByRole("complementary", { name: "Device panel" });
  await panel.getByRole("button", { name: "Device tools" }).click();
  const toolsPanel = panel.getByRole("region", { name: "Device tools" });
  const appearance = toolsPanel.getByRole("group", { name: "Appearance" });
  await expect(appearance.getByRole("button", { name: "Light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await appearance.getByRole("button", { name: "Dark" }).click();
  await expect(appearance.getByRole("button", { name: "Dark" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await shot(page, info, "device-tools");
  // Unknown settings (no serve-sim helper in the fake hub) cannot be switched.
  await expect(toolsPanel.getByRole("switch", { name: "Reduce Motion" })).toBeDisabled();
});

test("D1328: T3's Set up devices wizard turns the hub on, checks the simulators and finishes", async ({
  page,
}, info) => {
  const setupTools = fakeTools();
  const fresh = await startNode({
    config: { "jhin.devices": { xcrun: setupTools.xcrun, npm: setupTools.npm } },
  });
  try {
    await page.setViewportSize({ width: 360, height: 720 });
    await page.setContent(`<body style="margin:0;background:#2d6a4f"></body>`);
    Fs.writeFileSync(setupTools.jpeg, await page.screenshot({ type: "jpeg" }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    });
    await page.goto(`${fresh.ui}#token=${fresh.token}`);
    await page.getByRole("button", { name: "Start a thread" }).click();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("set up devices");
    await message.press("Enter");
    await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: set up devices");
    const threadId = decodeURIComponent(/[#&]t=([^&]+)/.exec(page.url())![1]!);

    // Nothing is set up yet: the Device panel opens on T3's wizard, the hub off.
    await fresh.client().call("device.open", { threadId, deviceId: "SIM-1" });
    const wizard = page.getByRole("dialog", { name: "Set up devices" });
    await expect(wizard).toBeVisible();
    const hub = wizard.getByRole("switch", { name: "Enable device hub" });
    await expect(hub).not.toBeChecked();
    await expect(wizard.getByRole("button", { name: "Continue" })).toBeDisabled();
    await shot(page, info, "device-setup-hub");

    // The switch is the consent: the hub installs, starts, and the wizard says so.
    await hub.click();
    await expect(hub).toBeChecked();
    await expect(wizard.getByText("Device hub is ready.")).toBeVisible();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await expect(wizard.getByText("Xcode and iOS Simulator are available.")).toBeVisible();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await expect(
      wizard.getByRole("switch", { name: "Allow agents to control devices" }),
    ).not.toBeChecked();
    await shot(page, info, "device-setup-agents");
    await wizard.getByRole("button", { name: "Done" }).click();
    await expect(wizard).toBeHidden();

    // Set up: the panel streams the simulator, and the node keeps the settings.
    const panel = page.getByRole("complementary", { name: "Device panel" });
    await expect(panel.getByRole("application", { name: "iOS Simulator screen" })).toBeVisible();
    const { value } = await fresh
      .client()
      .call<{ value: Record<string, unknown> }>("host.config.get", { section: "jhin.devices" });
    expect(value).toMatchObject({ hub: true, agentAccess: false, onboardingCompleted: true });
  } finally {
    await fresh.stop();
  }
});
