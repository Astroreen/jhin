// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// packages/effect-codex-app-server/src/protocol.ts and apps/server/src/provider/CodexProvider.ts
// at eb7b35ac: the app-server's JSON-RPC over stdio (one message per line), its
// `initialize` handshake and the environment it is started with.
import * as ChildProcess from "node:child_process";
import * as Readline from "node:readline";

import { pickEnvironment } from "@jhin/agent-api";

/** The client name Codex is told (`initialize`) and its catalog fetch is made with. */
const CODEX_CLIENT_NAME = "Jhin";

/** A JSON-RPC error Codex answered a request with. */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly method: string;
  constructor(method: string, code: number, message: string) {
    super(message);
    this.code = code;
    this.method = method;
  }
}

/** Jhin ended the app-server (a stop, an idle end, a close): what waited on it fails with this. */
export class CodexEnded extends Error {}

/** The app-server could not be started (no such binary, not executable). */
export class CodexSpawnError extends Error {}

/** How the app-server process ended. */
interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process could not be started. */
  readonly error?: Error;
}

/** A request the app-server sends the client (an approval, a question). */
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

/** One running `codex app-server`, spoken to over its stdin and stdout. */
export interface AppServerConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /** Receives every notification; the last handler set wins. */
  onNotification(handler: NotificationHandler): void;
  /** Answers every request the app-server sends; unanswered ones get "method not found". */
  onRequest(handler: RequestHandler): void;
  /** Settles once the process exited. */
  readonly exited: Promise<Exit>;
  readonly running: boolean;
  /** The last lines the process wrote to stderr, for error messages. */
  stderr(): string;
  /** Ends the process. */
  close(): void;
}

export interface LaunchOptions {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const STDERR_LINES = 20;
/** A Codex that has not exited this long after SIGTERM is killed (T3's forceKillAfter). */
const FORCE_KILL_AFTER_MS = 2_000;

/** Starts `<binary> app-server <args>` and speaks JSON-RPC to it; nothing is sent yet. */
export function launchAppServer(
  options: LaunchOptions & {
    readonly forceKillAfterMs?: number;
    /** Hears about lines Codex wrote that are not JSON-RPC, so a protocol drift shows. */
    readonly log?: (message: string, data?: Record<string, unknown>) => void;
  },
): AppServerConnection {
  const child = ChildProcess.spawn(options.binaryPath, ["app-server", ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let onNotification: NotificationHandler = () => {};
  let onRequest: RequestHandler | undefined;
  let running = true;
  let closing = false;
  const stderr: string[] = [];

  /** Whether the message went out; a process that no longer reads its input takes none. */
  const write = (message: Record<string, unknown>): boolean => {
    if (!running || !child.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };

  let settle!: (exit: Exit) => void;
  const exited = new Promise<Exit>((resolve) => (settle = resolve));
  const end = (exit: Exit) => {
    if (!running) return;
    running = false;
    const error =
      exit.error === undefined
        ? new Error(
            `Codex exited${exit.code === null ? "" : ` with code ${exit.code}`}${
              stderr.length === 0 ? "" : `: ${stderr.join("\n")}`
            }`,
          )
        : // Only a process that never got a pid failed to start (ENOENT, EACCES); a later
          // error (a failed kill, a broken pipe) is no spawn failure.
          child.pid === undefined
          ? new CodexSpawnError(exit.error.message)
          : new Error(`Codex failed: ${exit.error.message}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    settle(exit);
  };
  child.once("error", (error) => end({ code: null, signal: null, error }));
  // "close", not "exit": it comes once stdout is drained, so a last line (a turn/completed,
  // an answer) written just before exiting is still read.
  child.once("close", (code, signal) => end({ code, signal }));
  const close = () => {
    if (!running || closing) return;
    closing = true;
    // Ended on purpose: what waits on an answer fails now, not once the process is gone.
    const ended = new CodexEnded("Codex was ended.");
    for (const request of pending.values()) request.reject(ended);
    pending.clear();
    child.stdin.end();
    child.kill();
    // One that ignores SIGTERM (or is stuck in a tool) is not left behind.
    const force = setTimeout(() => {
      if (running) child.kill("SIGKILL");
    }, options.forceKillAfterMs ?? FORCE_KILL_AFTER_MS);
    // Not unref'd: a node that is stopping waits for it, so no Codex outlives the node.
    void exited.then(() => clearTimeout(force));
  };
  // A broken pipe: the process can take nothing more, so it is ended and what waits on it
  // fails with its exit.
  child.stdin.on("error", () => close());

  Readline.createInterface({ input: child.stderr }).on("line", (line) => {
    stderr.push(line);
    if (stderr.length > STDERR_LINES) stderr.shift();
  });

  const answer = (id: unknown, method: string, params: unknown) => {
    if (onRequest === undefined) {
      write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    onRequest(method, params).then(
      (result) => write({ id, result: result ?? null }),
      (error: unknown) =>
        write({
          id,
          error: {
            // A CodexRpcError keeps its code (-32601 for requests Jhin does not answer);
            // anything else is an internal error.
            code: error instanceof CodexRpcError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
  };

  Readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      options.log?.("codex wrote a line that is not JSON-RPC", {
        line: line.slice(0, 500),
        stderr: stderr.join("\n"),
      });
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const method = message["method"];
    const id = message["id"];
    if (typeof method === "string") {
      if (typeof id === "string" || typeof id === "number") answer(id, method, message["params"]);
      else {
        try {
          onNotification(method, message["params"]);
        } catch (error) {
          options.log?.("a codex notification could not be handled", {
            method,
            error: String(error),
          });
        }
      }
      return;
    }
    if (typeof id !== "number") return;
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
    const error = message["error"] as { code?: unknown; message?: unknown } | undefined;
    if (error !== undefined && error !== null) {
      request.reject(
        new CodexRpcError(
          request.method,
          typeof error.code === "number" ? error.code : 0,
          typeof error.message === "string" ? error.message : "Codex request failed",
        ),
      );
    } else {
      request.resolve(message["result"]);
    }
  });

  return {
    request(method, params) {
      if (!running) return Promise.reject(new Error("Codex is not running"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        if (!write({ id, method, ...(params === undefined ? {} : { params }) })) {
          pending.delete(id);
          reject(new Error("Codex no longer reads its input"));
        }
      });
    },
    notify(method, params) {
      void write({ method, ...(params === undefined ? {} : { params }) });
    },
    onNotification(handler) {
      onNotification = handler;
    },
    onRequest(handler) {
      onRequest = handler;
    },
    exited,
    get running() {
      return running;
    },
    stderr: () => stderr.join("\n"),
    close,
  };
}

/** What `initialize` answers: Codex's home and its user agent (which names its version). */
export interface Initialized {
  readonly userAgent?: string;
  readonly codexHome?: string;
}

/** The handshake every app-server needs before anything else (T3's buildCodexInitializeParams). */
export async function initialize(
  connection: AppServerConnection,
  version: string,
): Promise<Initialized> {
  const result = (await connection.request("initialize", {
    clientInfo: { name: CODEX_CLIENT_NAME, title: CODEX_CLIENT_NAME, version },
    capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"] },
  })) as Initialized | null;
  connection.notify("initialized");
  return result ?? {};
}

/** Codex's version, from the user agent `initialize` reports (`codex_cli_rs/0.200.0 …`). */
export function codexVersion(userAgent: string | undefined): string | undefined {
  return userAgent?.match(/\/([^\s]+)/)?.[1];
}

/**
 * The environment Codex runs with: the node's (through `inheritEnv`), the config's `env` and
 * `CODEX_HOME`. The
 * originator is named at spawn, since the app-server's first catalog fetch goes out before
 * `initialize` names the client (T3's codexAppServerEnvironment).
 */
export function codexEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  home: string | undefined,
  inherit?: readonly string[],
): Record<string, string | undefined> {
  return {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME,
    // The node's variables the allow-list lets through (D346, as for Claude Code).
    ...pickEnvironment(process.env, inherit),
    ...env,
    ...(home === undefined ? {} : { CODEX_HOME: home }),
  };
}
