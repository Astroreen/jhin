// Fakes of the device hub's tools (docs/plans/preview.md, D1206–D1209), shared by the
// browser and desktop e2e: CI has no simulators, so a fake npm "installs" a fake hub that
// serves serve-sim's MJPEG feed and input socket, and records what the panel sends it.
import * as Fs from "node:fs";
import { createRequire } from "node:module";
import * as Os from "node:os";
import * as Path from "node:path";

const WS = createRequire(
  Path.resolve(import.meta.dirname, "../../../plugins/devices/package.json"),
).resolve("ws");

export function fakeTools() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-device-hub-e2e-"));
  const at = (name: string) => Path.join(dir, name);
  const xcrun = at("xcrun");
  Fs.writeFileSync(
    xcrun,
    `#!/bin/sh
case "$2 $3" in
  "list devices") printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-2":[{"udid":"SIM-1","name":"iPhone 15","state":"Booted","isAvailable":true}]}}';;
  # The tools panel's appearance (D1332): read, or set and remembered.
  "ui SIM-1") if [ -n "$5" ]; then echo "$5" > "${dir}/appearance"; else cat "${dir}/appearance" 2>/dev/null || echo light; fi;;
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
// \`npm ci\` of the plugin's lockfile (D1330): the tool is the manifest's one dependency.
const name = Object.keys(JSON.parse(Fs.readFileSync(Path.join(prefix, "package.json"), "utf8")).dependencies)[0];
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
