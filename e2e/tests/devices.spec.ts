import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

// A device screen: a 360 × 720 PNG with a header bar and a card, so the panel draws something.
function screenPng(): Buffer {
  const [width, height] = [360, 720];
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const header = y < 80;
      const card = y > 160 && y < 360 && x > 24 && x < 336;
      const [r, g, b] = header ? [52, 107, 241] : card ? [228, 228, 231] : [250, 250, 250];
      row.writeUInt8(r, 1 + x * 3);
      row.writeUInt8(g, 2 + x * 3);
      row.writeUInt8(b, 3 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = screenPng();

/** Fake adb, emulator and xcrun keeping their state in files of one folder. */
function fakeTools() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-devices-"));
  Fs.writeFileSync(Path.join(dir, "screen.png"), PNG);
  Fs.writeFileSync(Path.join(dir, "running"), "");
  Fs.writeFileSync(Path.join(dir, "ios-state"), "Shutdown");
  const script = (name: string, body: string) => {
    const file = Path.join(dir, name);
    Fs.writeFileSync(file, `#!/bin/sh\nD=${JSON.stringify(dir)}\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const adb = script(
    "adb",
    `case "$1" in
  devices) echo "List of devices attached"; while read serial name; do [ -n "$serial" ] && echo "$serial device product:sdk model:sdk_gphone64 device:emu"; done < "$D/running"; exit 0;;
  -s) serial="$2"; shift 2;;
esac
case "$*" in
  "emu avd name") grep "^$serial " "$D/running" | cut -d' ' -f2; echo OK;;
  "shell getprop ro.build.version.release") echo 14;;
  "shell getprop sys.boot_completed") echo 1;;
  "exec-out screencap -p") cat "$D/screen.png";;
  "emu kill") grep -v "^$serial " "$D/running" > "$D/running.next"; mv "$D/running.next" "$D/running"; [ -f "$D/pid" ] && kill "$(cat "$D/pid")" 2>/dev/null; echo OK;;
  *) echo "unknown: $*" >&2; exit 1;;
esac`,
  );
  const emulator = script(
    "emulator",
    `case "$1" in
  -list-avds) echo Pixel_7_API_34;;
  -avd) echo "emulator-5554 $2" >> "$D/running"; echo $$ > "$D/pid"; exec sleep 600;;
esac`,
  );
  const xcrun = script(
    "xcrun",
    `case "$2 $3" in
  "list devices") printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-2":[{"udid":"SIM-1","name":"iPhone 15","state":"%s","isAvailable":true}]}}' "$(cat "$D/ios-state")";;
  "boot SIM-1") echo Booted > "$D/ios-state";;
  "bootstatus SIM-1") :;;
  "io SIM-1") cat "$D/screen.png";;
  "shutdown SIM-1") echo Shutdown > "$D/ios-state";;
  *) echo "unknown: $*" >&2; exit 1;;
esac`,
  );
  return { dir, adb, emulator, xcrun };
}

let node: RunningNode;
let tools: ReturnType<typeof fakeTools>;
test.beforeAll(async () => {
  tools = fakeTools();
  node = await startNode({
    config: { "jhin.devices": { adb: tools.adb, emulator: tools.emulator, xcrun: tools.xcrun } },
  });
});
test.afterAll(async () => {
  await node.stop();
});

async function startThread(page: Page, text: string): Promise<string> {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
  const threadId = /[#&]t=([^&]+)/.exec(page.url())?.[1];
  if (threadId === undefined) throw new Error(`no thread in ${page.url()}`);
  return decodeURIComponent(threadId);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D408: the Device panel lists the node's devices and shows the one an agent opens", async ({
  page,
}, info) => {
  const threadId = await startThread(page, "devices please");
  await page.getByRole("button", { name: "Toggle device panel" }).click();
  const panel = page.getByRole("complementary", { name: "Device panel" });
  const ios = panel.getByRole("region", { name: "iOS Simulators" });
  await expect(ios).toContainText("iPhone 15");
  await expect(ios).toContainText("This node · iOS 17.2 · Stopped");
  const android = panel.getByRole("region", { name: "Android Emulators" });
  await expect(android.getByRole("button", { name: "Start" })).toBeVisible();
  await shot(page, info, "devices-list");

  // An agent opens the emulator: the panel shows its screen.
  await page.getByRole("button", { name: "Close device panel" }).click();
  await expect(panel).toBeHidden();
  await node.client().call("device.open", { threadId, deviceId: "Pixel_7_API_34" });
  await expect(panel.getByRole("img", { name: "Pixel_7_API_34 screen" })).toBeVisible();
  await shot(page, info, "devices-open");

  await panel.getByRole("button", { name: "Power off device" }).click();
  await expect(panel.getByRole("region", { name: "Android Emulators" })).toContainText("Stopped");
});
