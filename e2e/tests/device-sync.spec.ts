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
