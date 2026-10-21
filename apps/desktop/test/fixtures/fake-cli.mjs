// Stands in for `jhin serve --ui` in local-node.test.ts. FAKE_CLI chooses what it does:
// `ready` (token, then the CLI's lines), `exit` (fails first), `no-token`,
// `stuck` (ready, but ignores SIGTERM).
import * as Fs from "node:fs";
import * as Path from "node:path";

const home = process.argv[process.argv.indexOf("--home") + 1];
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
process.stderr.write(`ui: http://127.0.0.1:7777/\nlogs: ${home}/logs/node.log\n`);
// Stays up until stopped.
setInterval(() => undefined, 1 << 30);
