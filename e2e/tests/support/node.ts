import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";

const BIN = Path.resolve(import.meta.dirname, "../../../apps/jhin/bin/jhin.js");

export interface RunningNode {
  readonly home: string;
  /** Base URL of the web client, e.g. http://127.0.0.1:41234/ (when served). */
  readonly ui: string;
  /** RPC endpoint, e.g. ws://127.0.0.1:41234/rpc (when served). */
  readonly rpc: string;
  readonly token: string;
  /** An RPC client to the node, opened on first use. */
  client(): RpcClient;
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

const WEB = Path.resolve(import.meta.dirname, "../../../apps/web");
const VP = Path.resolve(import.meta.dirname, "../../../node_modules/vite-plus/bin/vp");

export interface DevServer {
  /** Base URL of the web client served by `vp dev`, once it listens. */
  ready(): Promise<string>;
  /** Stops `vp dev` and every process it started; resolves when all have exited. */
  stop(): Promise<void>;
}

/**
 * Starts `vp dev` for the web client on a free port, proxying to `node`
 * (`JHIN_NODE_URL`). Returns at once, so a test can stop it (in `afterEach`)
 * even if it never becomes ready; `ready()` resolves with its URL.
 */
export function startDevServer(node: string): DevServer {
  // `vp dev` runs Vite in a child process of its own: the server gets its own
  // process group, and stopping it signals the whole group.
  const child = ChildProcess.spawn(
    process.execPath,
    [VP, "dev", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: WEB,
      env: { ...process.env, JHIN_NODE_URL: node.replace(/\/$/, "") },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  // Every process of the group holds the output pipes: they close when the last one exits.
  const closed = Promise.all(
    [child.stdout, child.stderr].map(
      (stream) => new Promise((resolve) => stream.once("close", resolve)),
    ),
  );
  const url = new Promise<string>((resolve, reject) => {
    let text = "";
    const read = (chunk: unknown) => {
      // Colours (the test runner may force them) split the URL.
      // oxlint-disable-next-line no-control-regex
      text += String(chunk).replaceAll(/\u001B\[[\d;]*m/g, "");
      const found = /Local:\s+(http:\/\/\S+)/.exec(text)?.[1];
      if (found !== undefined) resolve(found);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => reject(new Error(`vp dev exited with ${code}:\n${text}`)));
  });
  // Rejections surface through ready(); a stopped server's must not go unhandled.
  url.catch(() => undefined);
  return {
    ready: () => url,
    async stop() {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // The group is gone already.
      }
      await closed;
    },
  };
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
  const rpcUrl = /rpc: (ws:\/\/\S+)/.exec(stderr)?.[1] ?? "";
  const token = Fs.existsSync(tokenFile) ? Fs.readFileSync(tokenFile, "utf8").trim() : "";
  let connection: RpcClient | undefined;
  return {
    home,
    ui: /ui: (http:\/\/\S+)/.exec(stderr)?.[1] ?? "",
    rpc: rpcUrl,
    token,
    client() {
      connection ??= createRpcClient({ connect: () => connectWebSocket(rpcUrl, token) });
      return connection;
    },
    async stop() {
      connection?.close();
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
}
