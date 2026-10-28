// Stands in for `jhin serve --ui` in local-node.test.ts. FAKE_CLI chooses what it does:
// `ready` (token, then the CLI's lines and its ready message), `exit` (fails first),
// `no-token`, `stuck` (ready, but ignores SIGTERM and the stop message), `no-ui` (a plugin
// failed, no web client). A `--port` shows in the address it prints (D1487). The stop
// message (D1688) ends it, as the CLI does, writing "stopped by message" to its home.
import * as Fs from "node:fs";
import * as Path from "node:path";

const home = process.argv[process.argv.indexOf("--home") + 1];
const port = process.argv.includes("--port")
  ? process.argv[process.argv.indexOf("--port") + 1]
  : "7777";
const mode = process.env.FAKE_CLI;
if (mode === "exit") {
  process.stderr.write("config file not applied\n");
  process.exit(3);
}
if (mode !== "no-token") {
  const dir = Path.join(home, "data", "jhin.auth-token");
  Fs.mkdirSync(dir, { recursive: true });
  Fs.writeFileSync(Path.join(dir, "token"), "secret\n");
}
if (mode === "stuck") process.on("SIGTERM", () => process.stderr.write("ignoring SIGTERM\n"));
const logs = `${home}/logs/node.log`;
const ui = `http://127.0.0.1:${port}/`;
const problem = { id: "jhin.http", status: "failed", message: "Port 7777 on 127.0.0.1 is in use" };
if (mode === "no-ui") {
  process.stderr.write(`  failed jhin.http: ${problem.message}\nlogs: ${logs}\n`);
} else {
  process.stderr.write(`ui: ${ui}\nlogs: ${logs}\n`);
}
process.on("message", (message) => {
  if (message?.type !== "jhin.serve.stop" || mode === "stuck") return;
  Fs.writeFileSync(Path.join(home, "stopped"), "stopped by message\n");
  process.exit(0);
});
process.send?.({
  type: "jhin.serve.ready",
  nodeId: "fake",
  logs,
  ...(mode === "no-ui" ? { problems: [problem] } : { ui, problems: [] }),
});
// Stays up until stopped.
setInterval(() => undefined, 1 << 30);
