import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

/** Where the app finds the CLI and its own client plugin (resolved from the app's package). */
export interface LocalNodePaths {
  /** `bin/jhin.js` of the `jhin-ai` package. */
  readonly cli: string;
  /** The `jhin.desktop` client plugin's package directory (D514). */
  readonly plugin: string;
}

export interface RunningLocalNode {
  /** The web client's address: `http://127.0.0.1:7777/`. */
  readonly url: string;
  /** The node's access token, from its home. */
  readonly token: string;
  readonly home: string;
  /** Called once if the node exits without being asked to. */
  onExit(listener: (output: string) => void): void;
  /** Stops the node and resolves once it exited. */
  stop(): Promise<void>;
}

/** How long a node may take to stop after SIGTERM before it is killed (T3 waits 5 s). */
const STOP_GRACE_MS = 5_000;

/** The last lines a failed node printed, for the dialog that reports it. */
const OUTPUT_LIMIT = 8_000;

/** The node's home, as the CLI resolves it: `$JHIN_HOME` or `~/.jhin` (D512). */
function localNodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["JHIN_HOME"] ?? Path.join(Os.homedir(), ".jhin");
}

/**
 * Starts `jhin serve --ui` with this app's client plugin, run by Electron's
 * own Node (D512), and resolves once it printed its web client's address.
 * Rejects with the node's output when it exits first.
 */
export function startLocalNode(
  paths: LocalNodePaths,
  home = localNodeHome(),
): Promise<RunningLocalNode> {
  Fs.mkdirSync(home, { recursive: true });
  const child = ChildProcess.spawn(
    process.execPath,
    // The node's folder is its home: no project layer or workspace plugins of wherever the app started.
    [paths.cli, "serve", "--ui", "--plugin-dir", paths.plugin, "--home", home, "--cwd", home],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", JHIN_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const append = (chunk: unknown) => {
    output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let stopping = false;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const exitListeners: ((output: string) => void)[] = [];
  child.once("exit", () => {
    if (!stopping) for (const listener of exitListeners) listener(output);
  });

  return new Promise((resolve, reject) => {
    const onData = () => {
      // Printed once every plugin is active: `ui: http://127.0.0.1:7777/` then `logs: <file>`.
      const url = /^ui: (http:\/\/\S+)$/m.exec(output)?.[1];
      if (url === undefined || !/^logs: /m.test(output)) return;
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onEarlyExit);
      // jhin.auth-token writes its token before the node reports itself ready.
      const tokenFile = Path.join(home, "data", "jhin.auth-token", "token");
      let token = "";
      try {
        token = Fs.readFileSync(tokenFile, "utf8").trim();
      } catch {
        // Missing: reported below.
      }
      if (token === "") {
        stopping = true;
        child.kill("SIGTERM");
        reject(new Error(`The local node has no access token at ${tokenFile}:\n${output.trim()}`));
        return;
      }
      resolve({
        url,
        token,
        home,
        onExit: (listener) => void exitListeners.push(listener),
        async stop() {
          stopping = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          // A node stuck in its plugins' dispose must not keep the app from quitting.
          const kill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
          await exited;
          clearTimeout(kill);
        },
      });
    };
    const onEarlyExit = (code: number | null) => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      reject(new Error(`The local node exited with ${code ?? "a signal"}:\n${output.trim()}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onEarlyExit);
  });
}
