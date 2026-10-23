// The device hub in the Device panel (docs/plans/preview.md, D1206–D1209), end to end against
// fakes: CI has no simulators, so a fake npm "installs" a fake hub that serves serve-sim's MJPEG
// feed and input socket, and records what the panel sends it.
import * as Fs from "node:fs";
import { createRequire } from "node:module";
import * as Os from "node:os";
import * as Path from "node:path";

import { expect, test, type TestInfo, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

const WS = createRequire(
  Path.resolve(import.meta.dirname, "../../plugins/devices/package.json"),
).resolve("ws");

function fakeTools() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-device-hub-e2e-"));
  const at = (name: string) => Path.join(dir, name);
  const xcrun = at("xcrun");
  Fs.writeFileSync(
    xcrun,
    `#!/bin/sh
case "$2 $3" in
  "list devices") printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-2":[{"udid":"SIM-1","name":"iPhone 15","state":"Booted","isAvailable":true}]}}';;
  *) echo "unknown: $*" >&2; exit 1;;
esac
`,
    { mode: 0o755 },
  );
  // serve-sim's MJPEG feed (one frame, kept open) and its input socket: admitted, then the
  // screen; every message it gets is logged.
  Fs.writeFileSync(
    at("hub.mjs"),
    `import * as Fs from "node:fs";
import * as Http from "node:http";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.url)(${JSON.stringify(WS)});
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = Http.createServer((request, response) => {
  const url = new URL(request.url, "http://hub");
  if (url.pathname === "/readyz") return response.end("ok");
  if (url.pathname === "/vendor/serve-sim/helper/SIM-1/stream.mjpeg") {
    const jpeg = Fs.readFileSync(${JSON.stringify(at("screen.jpg"))});
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    // Chromium shows a part once the next one begins: two frames, then the feed stays open.
    for (let frame = 0; frame < 2; frame++) {
      response.write("--frame\\r\\nContent-Type: image/jpeg\\r\\nContent-Length: " + jpeg.length + "\\r\\n\\r\\n");
      response.write(jpeg);
      response.write("\\r\\n");
    }
    return;
  }
  response.writeHead(404).end();
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.send(Uint8Array.of(0x83));
  const config = new TextEncoder().encode(JSON.stringify({ width: 360, height: 720, orientation: "portrait" }));
  socket.send(Uint8Array.of(0x82, ...config));
  socket.on("message", (data) => {
    const bytes = new Uint8Array(data);
    Fs.appendFileSync(${JSON.stringify(at("input.log"))}, JSON.stringify({ tag: bytes[0], body: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) }) + "\\n");
  });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`,
  );
  const npm = at("npm");
  Fs.writeFileSync(
    npm,
    `#!${process.execPath}
const Fs = require("node:fs");
const Path = require("node:path");
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
const name = args.at(-1).split(/@(?=[^@]*$)/)[0];
if (name !== "expo-device-hub") process.exit(1);
const target = Path.join(prefix, "node_modules", name, "dist", "server", "cli.mjs");
Fs.mkdirSync(Path.dirname(target), { recursive: true });
Fs.copyFileSync(${JSON.stringify(at("hub.mjs"))}, target);
`,
    { mode: 0o755 },
  );
  const log = at("input.log");
  /** Resolves once the hub logged `count` input messages, on the file's change events. */
  const inputs = (count: number) =>
    new Promise<{ tag: number; body: unknown }[]>((resolve) => {
      const read = () =>
        Fs.existsSync(log)
          ? Fs.readFileSync(log, "utf8")
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => JSON.parse(line) as { tag: number; body: unknown })
          : [];
      const check = () => {
        const found = read();
        if (found.length < count) return false;
        watcher.close();
        resolve(found);
        return true;
      };
      const watcher = Fs.watch(dir, check);
      check();
    });
  return { dir, xcrun, npm, jpeg: at("screen.jpg"), inputs };
}

let node: RunningNode;
let tools: ReturnType<typeof fakeTools>;
test.beforeAll(async () => {
  tools = fakeTools();
  node = await startNode({
    config: { "jhin.devices": { xcrun: tools.xcrun, npm: tools.npm, hub: true } },
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
