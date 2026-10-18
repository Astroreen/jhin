import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

const BIN = Path.resolve(import.meta.dirname, "../../../apps/jhin/bin/jhin.js");

export interface RunningNode {
  readonly home: string;
  /** Base URL of the web client, e.g. http://127.0.0.1:41234/ (when served). */
  readonly ui: string;
  /** RPC endpoint, e.g. ws://127.0.0.1:41234/rpc (when served). */
  readonly rpc: string;
  readonly token: string;
  stop(): Promise<void>;
}

export interface NodeOptions {
  /** `serve --ui` (default), `serve` without the web client, or `client`. */
  readonly mode?: "ui" | "serve" | "client";
  readonly watch?: boolean;
  /** Extra project config merged next to the free-port setting. */
  readonly config?: Record<string, unknown>;
  /** Runs before the node starts, e.g. to install user plugins into `<home>/plugins`. */
  readonly setup?: (home: string) => void;
}

export function writeConfig(home: string, config: Record<string, unknown>): void {
  Fs.mkdirSync(Path.join(home, ".jhin"), { recursive: true });
  Fs.writeFileSync(
    Path.join(home, ".jhin", "config.jsonc"),
    JSON.stringify({ "jhin.http": { port: 0 }, ...config }, null, 2),
  );
}

/** Starts a node in a fresh home on a free port; resolves once it printed its URLs. */
export async function startNode(options: NodeOptions = {}): Promise<RunningNode> {
  const mode = options.mode ?? "ui";
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-e2e-"));
  writeConfig(home, options.config ?? {});
  options.setup?.(home);
  const args = [
    BIN,
    mode === "client" ? "client" : "serve",
    ...(mode === "ui" ? ["--ui"] : []),
    ...(options.watch === true ? ["--watch"] : []),
    "--home",
    home,
    "--cwd",
    home,
  ];
  const child = ChildProcess.spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wanted = mode === "serve" ? /rpc: (ws:\/\/\S+)/ : /ui: (http:\/\/\S+)/;
  const stderr = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += String(chunk);
      if (wanted.test(text) && text.includes("logs:")) resolve(text);
    });
    child.once("exit", (code) => reject(new Error(`jhin ${mode} exited with ${code}:\n${text}`)));
  });
  const tokenFile = Path.join(home, "data", "jhin.auth-token", "token");
  return {
    home,
    ui: /ui: (http:\/\/\S+)/.exec(stderr)?.[1] ?? "",
    rpc: /rpc: (ws:\/\/\S+)/.exec(stderr)?.[1] ?? "",
    token: Fs.existsSync(tokenFile) ? Fs.readFileSync(tokenFile, "utf8").trim() : "",
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
}
