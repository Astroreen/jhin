import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Net from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { findRunningNode, isProcessAlive, localUrl } from "@jhin/node-host/running";

/** Where the app finds the CLI and its own client plugin (resolved from the app's package). */
export interface LocalNodePaths {
  /** The `jhin` bin of the `jhin-ai` package. */
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

/**
 * The CLI's entry: its manifest's `jhin` bin, `bin/jhin.js` in the workspace and
 * `dist/main.js` in a packed install (D942).
 */
export function cliEntry(manifest: string): string {
  const bin = (JSON.parse(Fs.readFileSync(manifest, "utf8")) as { bin?: { jhin?: unknown } }).bin
    ?.jhin;
  if (typeof bin !== "string") throw new Error(`${manifest} names no "jhin" bin`);
  return Path.join(Path.dirname(manifest), bin);
}

/** How long a node may take to stop after SIGTERM before it is killed (T3 waits 5 s). */
const STOP_GRACE_MS = 5_000;

/** The last lines a failed node printed, for the dialog that reports it. */
const OUTPUT_LIMIT = 8_000;

/** The node's home, as the CLI resolves it: `$JHIN_HOME` or `~/.jhin` (D512). */
export function localNodeHome(env: NodeJS.ProcessEnv = process.env): string {
  // An empty JHIN_HOME counts as unset.
  return env["JHIN_HOME"] || Path.join(Os.homedir(), ".jhin");
}

/**
 * Starts `jhin serve --ui` with this app's client plugin, run by Electron's
 * own Node (D512), and resolves once it printed its web client's address.
 * Rejects with the node's output when it exits first.
 */
export function startLocalNode(
  paths: LocalNodePaths,
  home = localNodeHome(),
  /** Arms the SIGKILL after SIGTERM and returns its cancel; tests run it at once. */
  scheduleKill: (kill: () => void) => () => void = (kill) => {
    const timer = setTimeout(kill, STOP_GRACE_MS);
    return () => clearTimeout(timer);
  },
  /** The port the app chose when the node's own was taken (D1487). */
  port?: number,
): Promise<RunningLocalNode> {
  Fs.mkdirSync(home, { recursive: true });
  const child = ChildProcess.spawn(
    process.execPath,
    // The node's folder is its home: no project layer or workspace plugins of wherever the app started.
    [
      paths.cli,
      "serve",
      "--ui",
      "--plugin-dir",
      paths.plugin,
      "--home",
      home,
      "--cwd",
      home,
      ...(port === undefined ? [] : ["--port", String(port)]),
    ],
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
  /** SIGTERM, then SIGKILL if the node has not exited after the grace period. */
  const stop = async () => {
    stopping = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    // A node stuck in its plugins' dispose must not keep the app from quitting.
    const cancel = scheduleKill(() => child.kill("SIGKILL"));
    await exited;
    cancel();
  };

  return new Promise((resolve, reject) => {
    const onData = () => {
      // Printed once every plugin is active: `ui: http://127.0.0.1:7777/` then `logs: <file>`.
      if (!/^logs: /m.test(output)) return;
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onEarlyExit);
      // `logs:` is the last line; without `ui:` before it the web client is not served
      // (its plugin failed, the port is taken): the node's problem lines say why.
      const url = /^ui: (http:\/\/\S+)$/m.exec(output)?.[1];
      if (url === undefined) {
        void stop().then(() =>
          reject(new Error(`The local node does not serve the web client:\n${output.trim()}`)),
        );
        return;
      }
      // jhin.auth-token writes its token before the node reports itself ready.
      const tokenFile = homeTokenFile(home);
      const token = readHomeToken(home);
      if (token === "") {
        // Stopped before the error is shown, so Try Again does not meet the old node.
        void stop().then(() =>
          reject(
            new Error(`The local node has no access token at ${tokenFile}:\n${output.trim()}`),
          ),
        );
        return;
      }
      resolve({
        url,
        token,
        home,
        onExit: (listener) => void exitListeners.push(listener),
        stop,
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
    // A spawn that fails (a missing executable, no processes left) emits this instead of `exit`.
    child.once("error", (error) => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onEarlyExit);
      reject(new Error(`The local node could not be started: ${error.message}`));
    });
  });
}

const homeTokenFile = (home: string) => Path.join(home, "data", "jhin.auth-token", "token");

/** The home's owner token, or "" when there is none (D512). */
function readHomeToken(home: string): string {
  try {
    return Fs.readFileSync(homeTokenFile(home), "utf8").trim();
  } catch {
    return "";
  }
}

/** A node of the app's home that was already running: shown, never stopped by the app (D1486). */
export interface AttachedNode {
  readonly url: string;
  readonly token: string;
  readonly home: string;
  readonly pid: number;
}

/**
 * The node of `home` that already runs (security.md D1184), ready to show:
 * undefined when none runs; an error when it serves no web client or the home
 * has no token for it (D1486).
 */
export async function attachRunningNode(home = localNodeHome()): Promise<AttachedNode | undefined> {
  const running = await findRunningNode(home);
  if (running === undefined) return undefined;
  const url = `${localUrl(running.url)}/`;
  let page: Response | undefined;
  try {
    page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await page.body?.cancel();
  } catch {
    page = undefined;
  }
  if (page === undefined || !page.ok || !page.headers.get("content-type")?.includes("text/html")) {
    throw new Error(
      `A Jhin node of this home already runs at ${url} without the web client. Stop it, or start it with \`jhin serve --ui\`.`,
    );
  }
  const token = readHomeToken(home);
  if (token === "") {
    throw new Error(
      `A Jhin node of this home already runs at ${url}, but there is no access token at ${homeTokenFile(home)}.`,
    );
  }
  return { url, token, home, pid: running.pid };
}

/**
 * Calls `onGone` once the attached node's process is gone, checking every
 * `intervalMs` (D1486); returns the stop.
 */
export function watchAttachedNode(
  node: Pick<AttachedNode, "pid">,
  onGone: () => void,
  alive: (pid: number) => boolean = isProcessAlive,
  intervalMs = 2_000,
): () => void {
  const timer = setInterval(() => {
    if (alive(node.pid)) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  return () => clearInterval(timer);
}

/** The port and address `jhin.http` could not listen on, from a failed node's output (D1487). */
export function portInUse(output: string): { port: number; host: string } | undefined {
  const match = /Port (\d+) on (\S+) is in use/.exec(output);
  return match === null ? undefined : { port: Number(match[1]), host: match[2]! };
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = Net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** The first port above `taken` that `host` can be listened on at (D1487). */
export async function freePortAbove(taken: number, host: string): Promise<number> {
  for (let port = taken + 1; port <= 65_535; port += 1) {
    if (await canListen(port, host)) return port;
  }
  throw new Error(`No port above ${taken} is free on ${host}.`);
}

/** What D1487's choice of a port needs, injected so it is tested without processes. */
export interface PortChoice<Node> {
  /** The port the app kept from an earlier choice, if any. */
  readonly kept: number | undefined;
  /** Starts the node, on `port` when given. */
  start(port: number | undefined): Promise<Node>;
  /** The node of the app's home that runs now, if any (security.md D1184). */
  running(): Promise<{ readonly url: string } | undefined>;
  freePortAbove(taken: number, host: string): Promise<number>;
  /** Keeps the port the node came up on. */
  keep(port: number): void;
  /** Whether the app is quitting: nothing starts again then. */
  quitting(): boolean;
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Starts the node on its port, or on the one the app kept (D1487); when that
 * port is taken by something else, on the next free one above it, which is
 * kept once the node came up there.
 */
export async function startOnFreePort<Node>(choice: PortChoice<Node>): Promise<Node> {
  const { kept } = choice;
  try {
    return await choice.start(kept);
  } catch (error) {
    const busy = portInUse(error instanceof Error ? error.message : String(error));
    // With a kept port, a failure on another port is a configured jhin.http.port's: it wins
    // over the app's choice, so its failure is the node's to report.
    if (choice.quitting() || busy === undefined || (kept !== undefined && busy.port !== kept)) {
      throw error;
    }
    // A node of this home took the port meanwhile: one node per home (D1486).
    const running = await choice.running();
    if (running !== undefined) {
      throw new Error(
        `A Jhin node of this home already runs at ${running.url}. Quit it, or restart the app to show it.`,
        { cause: error },
      );
    }
    const port = await choice.freePortAbove(busy.port, busy.host);
    choice.log("the node's port is taken; trying another", { taken: busy.port, port });
    const started = await choice.start(port);
    choice.keep(port);
    return started;
  }
}
