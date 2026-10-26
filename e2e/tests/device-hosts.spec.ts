// T3's "Device hosts" in the settings (docs/plans/preview.md, D1500), against a fake ssh that
// answers the remote script's probe: CI has no second machine.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode | undefined;
test.afterEach(async () => {
  await node?.stop();
  node = undefined;
});

/** `ssh -G` names a machine elsewhere; any remote command answers T3's probe. */
function fakeSsh(): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-ssh-e2e-"));
  const ssh = Path.join(dir, "ssh");
  Fs.writeFileSync(
    ssh,
    `#!/bin/sh
if [ "$1" = "-G" ]; then printf 'hostname mac.test\\nport 22\\n'; exit 0; fi
cat >/dev/null
printf '%s\\n' '{"nodePath":"/usr/local/bin/node","platforms":[{"platform":"ios","available":true},{"platform":"android","available":false,"reason":"Android SDK missing."}],"hubInstalled":false,"agentDeviceInstalled":false}'
`,
    { mode: 0o755 },
  );
  return ssh;
}

test("D1500: adds a device host after testing its connection, and saves it to the node", async ({
  page,
}, info) => {
  node = await startNode({ config: { "jhin.devices": { ssh: fakeSsh() } } });
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Devices" })
    .click();
  await expect(page.getByText("Device hosts", { exact: true })).toBeVisible();
  await expect(page.getByText("No device hosts.")).toBeVisible();

  await page.getByRole("button", { name: "Add host" }).click();
  const dialog = page.getByRole("dialog", { name: "Add device host" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Mac mini");
  await dialog.getByRole("textbox", { name: "SSH target" }).fill("me@mac.test");
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Connection checks passed");
  const shot = info.outputPath("device-hosts-editor.png");
  await page.screenshot({ path: shot });
  await info.attach("device-hosts-editor", { path: shot, contentType: "image/png" });
  await dialog.getByRole("button", { name: "Save host" }).click();
  await expect(dialog).toHaveCount(0);

  const row = page.locator("[data-device-host]");
  await expect(row.getByText("Mac mini")).toBeVisible();
  await expect(row.getByText("me@mac.test")).toBeVisible();
  const listed = info.outputPath("device-hosts-list.png");
  await page.screenshot({ path: listed });
  await info.attach("device-hosts-list", { path: listed, contentType: "image/png" });
  const saved = await node
    .client()
    .call<{ value: { sshHosts: { label: string; target: string }[] } }>("host.config.get", {
      section: "jhin.devices",
    });
  expect(saved.value.sshHosts).toEqual([
    expect.objectContaining({ label: "Mac mini", target: "me@mac.test" }),
  ]);
});
