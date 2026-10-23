// Fake npm, device hub and agent-device for the hub's tests (D409, D1206–D1209): the real
// packages are never installed; npm "installs" these scripts, and they log what they were asked.
import * as Fs from "node:fs";
import { createRequire } from "node:module";
import * as Os from "node:os";
import * as Path from "node:path";

const require = createRequire(import.meta.url);

export interface FakeTools {
  readonly dir: string;
  readonly home: string;
  readonly npm: string;
  readonly adb: string;
  /** Makes the next npm install fail with exit code 1. */
  failNpm(): void;
  /** Stops (and starts again) the fake agent-device daemon: its health check and its commands. */
  killDaemon(): void;
  reviveDaemon(): void;
  /** The packages npm was asked for, in order. */
  npmCalls(): { name: string; version: string }[];
  /** Every agent-device invocation's arguments. */
  agentCalls(): string[][];
  /** Every `adb shell input …`. */
  adbInputs(): string[];
  /** The running fake hub's arguments, once one started. */
  hubArgs(): { args: string[]; pid: number } | undefined;
}

const lines = (file: string) =>
  Fs.existsSync(file)
    ? Fs.readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];

export function fakeTools(): FakeTools {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-device-hub-"));
  const home = Path.join(dir, "home");
  Fs.mkdirSync(home);
  const at = (name: string) => Path.join(dir, name);

  // The hub: `/readyz`, an echo of every request and WebSocket, on the port it is given.
  Fs.writeFileSync(
    at("hub.mjs"),
    `import * as Fs from "node:fs";
import * as Http from "node:http";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.url)(${JSON.stringify(require.resolve("ws"))});
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--host") + 1];
const server = Http.createServer((request, response) => {
  const url = new URL(request.url, "http://hub");
  if (url.pathname === "/readyz") return response.end("ok");
  // The fake agent-device daemon's health check lives here too.
  if (url.pathname === "/health") {
    response.writeHead(Fs.existsSync(${JSON.stringify(at("daemon-dead"))}) ? 503 : 200);
    return response.end();
  }
  // A feed that runs until its client goes.
  if (url.pathname === "/vendor/serve-sim/helper/SIM-2/stream.mjpeg") {
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    response.write("--frame\\r\\n");
    return;
  }
  // A feed whose hub dies after its first bytes.
  if (url.pathname === "/vendor/serve-sim/helper/SIM-1/stream.mjpeg") {
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    response.write("--frame\\r\\n", () => response.socket.destroy());
    return;
  }
  if (url.pathname === "/vendor/serve-emu/api/accessibility") {
    response.writeHead(302, { location: "https://elsewhere.example/x" });
    return response.end();
  }
  if (url.pathname === "/vendor/serve-emu/health") {
    response.writeHead(302, { location: "/vendor/serve-emu/api/devices" });
    return response.end();
  }
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "identity",
      "set-cookie": "hub=1; Path=/",
      "access-control-allow-origin": "*",
    });
    response.end(JSON.stringify({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, body }));
  });
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket, request) => {
  socket.send(JSON.stringify({ url: request.url, headers: request.headers }));
  socket.on("message", (data, isBinary) =>
    socket.send(isBinary ? data : "echo:" + data.toString(), { binary: isBinary }),
  );
});
server.listen(port, host, () =>
  Fs.writeFileSync(${JSON.stringify(at("hub.json"))}, JSON.stringify({ args, pid: process.pid })),
);
process.on("SIGTERM", () => process.exit(0));
`,
  );

  // agent-device: the first command publishes a daemon; every call is logged.
  Fs.writeFileSync(
    at("agent-device.mjs"),
    `import * as Fs from "node:fs";
import * as Path from "node:path";
// The daemon answers on the fake hub's port (its /health), which starts before it.
const hubPort = () => {
  const { args } = JSON.parse(Fs.readFileSync(${JSON.stringify(at("hub.json"))}, "utf8"));
  return Number(args[args.indexOf("--port") + 1]);
};
const args = process.argv.slice(2);
Fs.appendFileSync(${JSON.stringify(at("agent.log"))}, JSON.stringify(args) + "\\n");
if (args[0] === "devices") {
  const dir = process.env.AGENT_DEVICE_STATE_DIR;
  Fs.mkdirSync(dir, { recursive: true });
  Fs.writeFileSync(Path.join(dir, "daemon.json"), JSON.stringify({ httpPort: hubPort(), token: "daemon-token", pid: process.pid, version: "0.21.25" }));
}
if (args[0] !== "devices" && args[0] !== "daemon" && Fs.existsSync(${JSON.stringify(at("daemon-dead"))})) {
  console.log(JSON.stringify({ success: false, error: { message: "The daemon did not answer." } }));
  process.exit(1);
}
if (args.includes("DIE")) {
  // The daemon carries the input out, then dies before it answers.
  Fs.writeFileSync(${JSON.stringify(at("daemon-dead"))}, "");
  process.exit(1);
}
if (args.includes("REFUSE")) {
  console.log(JSON.stringify({ success: false, error: { message: "No element at that point." } }));
  process.exit(1);
}
console.log(JSON.stringify({ success: true }));
`,
  );

  // npm: puts the right fake where the package's entry point goes.
  const npm = at("npm");
  Fs.writeFileSync(
    npm,
    `#!${process.execPath}
const Fs = require("node:fs");
const Path = require("node:path");
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
const [name, version] = args.at(-1).split(/@(?=[^@]*$)/);
Fs.appendFileSync(${JSON.stringify(at("npm.log"))}, JSON.stringify({ name, version }) + "\\n");
if (Fs.existsSync(${JSON.stringify(at("npm-fails"))})) {
  Fs.rmSync(${JSON.stringify(at("npm-fails"))});
  process.stderr.write("registry rejected https://private:credential@example.test/package");
  process.exit(1);
}
const entries = {
  "expo-device-hub": [["dist", "server", "cli.mjs"], ${JSON.stringify(at("hub.mjs"))}],
  "agent-device": [["bin", "agent-device.mjs"], ${JSON.stringify(at("agent-device.mjs"))}],
};
const [entry, source] = entries[name];
const target = Path.join(prefix, "node_modules", name, ...entry);
Fs.mkdirSync(Path.dirname(target), { recursive: true });
Fs.copyFileSync(source, target);
`,
    { mode: 0o755 },
  );

  // adb: one running emulator; `shell input` is logged.
  const adb = at("adb");
  Fs.writeFileSync(
    adb,
    `#!/bin/sh
case "$1" in
  devices) echo "List of devices attached"; echo "emulator-5554 device product:sdk model:sdk_gphone64 device:emu"; exit 0;;
  -s) shift 2;;
esac
case "$*" in
  "emu avd name") echo Pixel_7_API_34; echo OK;;
  "shell getprop ro.build.version.release") echo 14;;
  "shell input"*) echo "$*" >> ${JSON.stringify(at("adb.log"))};;
  *) echo "unknown: $*" >&2; exit 1;;
esac
`,
    { mode: 0o755 },
  );

  return {
    dir,
    home,
    npm,
    adb,
    failNpm: () => Fs.writeFileSync(at("npm-fails"), ""),
    killDaemon: () => Fs.writeFileSync(at("daemon-dead"), ""),
    reviveDaemon: () => Fs.rmSync(at("daemon-dead"), { force: true }),
    npmCalls: () => lines(at("npm.log")).map((line) => JSON.parse(line)),
    agentCalls: () => lines(at("agent.log")).map((line) => JSON.parse(line)),
    adbInputs: () => lines(at("adb.log")),
    hubArgs: () =>
      Fs.existsSync(at("hub.json"))
        ? JSON.parse(Fs.readFileSync(at("hub.json"), "utf8"))
        : undefined,
  };
}
