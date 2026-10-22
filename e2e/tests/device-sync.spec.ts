import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

let node: RunningNode | undefined;
test.afterEach(async () => {
  await node?.stop();
  node = undefined;
});

test("D485: a visit and a mark unread on one device show on another", async ({ browser }, info) => {
  node = await startNode({ mode: "ui" });
  const thread = await node.client().call<{ id: string }>("threads.create", {});
  await node.client().call("threads.send", { threadId: thread.id, text: "shared" });

  // Two devices: separate browser contexts, so separate storage.
  const laptop = await (await browser.newContext()).newPage();
  const phone = await (await browser.newContext()).newPage();
  for (const page of [laptop, phone]) await page.goto(`${node.ui}#token=${node.token}`);

  // Marked unread on the laptop: the phone shows "Done" too.
  await threadRow(laptop, "shared").click();
  await threadRow(laptop, "shared").click({ button: "right" });
  await laptop.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect(threadRow(phone, "shared").getByText("Done")).toBeVisible();
  const shot = info.outputPath("visits-two-devices.png");
  await phone.screenshot({ path: shot });
  await info.attach("visits-two-devices", { path: shot, contentType: "image/png" });

  // Seen on the phone: the laptop no longer shows it as new.
  await threadRow(phone, "shared").click();
  await expect(threadRow(laptop, "shared").getByText("Done")).toHaveCount(0);
});

test("D486–D488: settings and a draft follow to another device, unless sync is off", async ({
  browser,
}, info) => {
  node = await startNode({ mode: "ui" });
  const thread = await node.client().call<{ id: string }>("threads.create", {});
  await node.client().call("threads.send", { threadId: thread.id, text: "draft here" });
  const laptop = await (await browser.newContext()).newPage();
  const phone = await (await browser.newContext()).newPage();
  // Sharing is asked for on each device: both switches start off (D488).
  for (const page of [laptop, phone]) {
    await page.goto(`${node.ui}#token=${node.token}`);
    await page.getByRole("button", { name: "Settings" }).click();
    for (const name of ["Sync settings across devices", "Sync drafts across devices"]) {
      const toggle = page.getByRole("switch", { name });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
    }
    await page.getByRole("button", { name: "Back" }).click();
  }

  // A draft typed on the laptop is there when the phone opens the thread.
  await threadRow(laptop, "draft here").click();
  await laptop.getByRole("textbox", { name: "Message" }).fill("finish me on the phone");
  // Leaving the thread saves the draft.
  await laptop.getByRole("button", { name: "Settings" }).click();
  await threadRow(phone, "draft here").click();
  await expect(phone.getByRole("textbox", { name: "Message" })).toHaveText(
    "finish me on the phone",
  );
  const shot = info.outputPath("draft-two-devices.png");
  await phone.screenshot({ path: shot });
  await info.attach("draft-two-devices", { path: shot, contentType: "image/png" });

  // A setting changed on the laptop shows on the phone's settings page.
  await phone.getByRole("button", { name: "Settings" }).click();
  await laptop.getByRole("switch", { name: "Confirm archiving" }).click();
  await expect(phone.getByRole("switch", { name: "Confirm archiving" })).toBeChecked();

  // Sync off on the phone: the laptop's next change stays on the laptop.
  await phone.getByRole("switch", { name: "Sync settings across devices" }).click();
  await laptop.getByRole("switch", { name: "Confirm deleting" }).click();
  await expect(laptop.getByRole("switch", { name: "Confirm deleting" })).not.toBeChecked();
  await expect(phone.getByRole("switch", { name: "Confirm deleting" })).toBeChecked();
  const settingsShot = info.outputPath("settings-sync.png");
  await phone.screenshot({ path: settingsShot, fullPage: true });
  await info.attach("settings-sync", { path: settingsShot, contentType: "image/png" });
});
