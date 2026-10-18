import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

const BIN = Path.resolve(import.meta.dirname, "../../../apps/jhin/bin/jhin.js");

export interface RunningNode {
  readonly home: string;
  /** Base URL of the web client, e.g. http://127.0.0.1:41234/ */
  readonly ui: string;
  readonly token: string;
  stop(): Promise<void>;
}

/** Starts `jhin serve --ui` on a free port in a fresh home; resolves once it printed its URLs. */
export async function startNode(): Promise<RunningNode> {
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-e2e-"));
  Fs.mkdirSync(Path.join(home, ".jhin"));
  Fs.writeFileSync(Path.join(home, ".jhin", "config.jsonc"), '{ "jhin.http": { "port": 0 } }');
  const child = ChildProcess.spawn(
    process.execPath,
    [BIN, "serve", "--ui", "--home", home, "--cwd", home],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const ui = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const match = /ui: (http:\/\/\S+)/.exec(stderr);
      if (match !== null) resolve(match[1]!);
    });
    child.once("exit", (code) => reject(new Error(`jhin serve exited with ${code}:\n${stderr}`)));
  });
  const token = Fs.readFileSync(Path.join(home, "data", "jhin.auth-token", "token"), "utf8").trim();
  return {
    home,
    ui,
    token,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
}
