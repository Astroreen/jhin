// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// packages/provider-opencode/src/server/OpenCodeRuntime.ts, OpenCodeServerOwner.ts,
// versionProbe.ts and v2/OpenCode2Server.ts at eb7b35ac: starting `opencode serve` with a
// generated password, reading its URL line, verifying `/api/info`, the version probe, one
// server shared until it idles, and stopping its process group. Rewritten without Effect.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as Net from "node:net";

import {
  createClient,
  OpenCodeError,
  realClock,
  type Clock,
  type OpenCodeClient,
  type StreamEvent,
} from "./client.ts";

/** Where the OpenCode server is and how to reach it: the parts of the config that matter. */
export interface ServerSettings {
  readonly binaryPath: string;
  readonly serverUrl?: string | undefined;
  readonly serverPassword?: string | undefined;
}

const STARTUP_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;
const INFO_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const OUTPUT_LIMIT = 64 * 1024;
/** A lost event stream is opened again this often, this far apart (T3's, D887). */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2_000;
export const RECONNECT_FAILED = "The OpenCode event stream was lost and could not reconnect.";
const LISTENING = /server listening on\s+(https?:\/\/[^\s]+)/i;

/** The version `opencode --version` (or a bare `1.2.3`) printed. */
export function parseVersion(output: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
}

/** Runs `<binary> --version` (T3's version probe); rejects with T3's wording. */
export function probeVersion(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ["--version"],
      { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(
              new OpenCodeError(
                `OpenCode CLI (\`${binaryPath}\`) is not installed or not on PATH.`,
                "NotInstalled",
              ),
            );
          } else if (error.killed) {
            reject(new OpenCodeError("OpenCode CLI version probe timed out after 10 seconds."));
          } else {
            reject(
              new OpenCodeError(`Failed to execute OpenCode CLI health check: ${error.message}`),
            );
          }
          return;
        }
        const version = parseVersion(`${stdout}\n${stderr}`);
        if (version === undefined) {
          reject(
            new OpenCodeError(
              "Unable to determine OpenCode version from `opencode --version` output. Jhin requires OpenCode 2.",
            ),
          );
          return;
        }
        resolve(version);
      },
    );
  });
}

/** OpenCode 2 is the protocol Jhin speaks (D325). */
export function isSupportedVersion(version: string): boolean {
  return Number(version.split(".")[0]) >= 2;
}

export const unsupportedVersion = (version: string) =>
  `OpenCode v${version} is too old. Upgrade to OpenCode 2.`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = Net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The inherited 1.x variable is dropped: `OPENCODE_PASSWORD` wins in OpenCode 2, and the
 * generated password is the only one in play (T3's serverEnvironment).
 */
export function serverEnvironment(env: NodeJS.ProcessEnv, password: string): NodeJS.ProcessEnv {
  const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = env;
  return { ...rest, OPENCODE_PASSWORD: password };
}

/** SIGTERM to the process group, SIGKILL a second later (T3's shutdown). */
function stopProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid!, name);
    } catch {
      child.kill(name);
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
  // Not unref'd: a node shutting down waits the second, so a server ignoring SIGTERM is killed.
  child.once("exit", () => clearTimeout(timer));
}

/** Starts `opencode serve` and resolves with its URL once it says it listens. */
async function startServer(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  password: string,
): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    env: serverEnvironment(env, password),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const keep = (buffer: string, chunk: Buffer) => (buffer + chunk.toString()).slice(-OUTPUT_LIMIT);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        stopProcess(child);
        reject(error);
      } else {
        resolve({ url: url!, child });
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new OpenCodeError(
            `Timed out waiting for OpenCode server start after ${STARTUP_TIMEOUT_MS}ms.`,
          ),
        ),
      STARTUP_TIMEOUT_MS,
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout = keep(stdout, chunk);
      const match = LISTENING.exec(stdout);
      if (match !== null) finish(undefined, match[1]!);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (!settled) stderr = keep(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT"
          ? new OpenCodeError(
              `OpenCode CLI (\`${binaryPath}\`) is not installed or not on PATH.`,
              "NotInstalled",
            )
          : new OpenCodeError(`Failed to spawn OpenCode server process: ${error.message}`),
      ),
    );
    child.once("exit", (code) =>
      finish(
        new OpenCodeError(
          `OpenCode server exited before startup completed (code: ${code}).\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
        ),
      ),
    );
  });
}

/** T3's verifyServer: `/api/info` within 5 s, with its wording for each failure. */
async function verify(client: OpenCodeClient): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INFO_TIMEOUT_MS);
  try {
    const info = await client.info(abort.signal);
    if (typeof info?.version !== "string") {
      throw new OpenCodeError("The server is not an OpenCode 2 server.");
    }
    return info.version;
  } catch (error) {
    if (abort.signal.aborted) throw new OpenCodeError("Timed out waiting for the OpenCode server.");
    if (error instanceof OpenCodeError && error.tag === "UnauthorizedError") {
      throw new OpenCodeError(
        "The OpenCode server rejected the server password.",
        "UnauthorizedError",
      );
    }
    if (error instanceof SyntaxError) {
      throw new OpenCodeError("The server is not an OpenCode 2 server.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A running (or configured) server, its client and its event stream. */
export interface Connection {
  readonly client: OpenCodeClient;
  readonly version: string;
  readonly external: boolean;
  /** Calls `handler` for every event of the session; disposing stops it. */
  listen(sessionId: string, handler: (event: StreamEvent) => void): () => void;
  /**
   * Calls `handler` once the event stream is lost for good: the server exited, or the stream
   * could not be opened again (it is opened again on the next use).
   */
  onLost(handler: (reason: string) => void): () => void;
  /** Calls `handler` each time a lost event stream is open again: events sent meanwhile are gone. */
  onReconnected(handler: () => void): () => void;
}

/**
 * The node's one OpenCode server (D326): started on first use, shared by every thread, and
 * stopped after `idleMs` without anyone using it (0: never), on `close()` and on `dispose()`.
 */
export function createServerOwner(options: {
  readonly settings: () => ServerSettings;
  readonly env: () => NodeJS.ProcessEnv;
  readonly idleMs: () => number;
  /** The timers of its clients (the stream's silence limit, retry waits); tests fire them. */
  readonly clock?: Clock;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}) {
  interface Running {
    readonly key: string;
    readonly child: ChildProcess | undefined;
    readonly client: OpenCodeClient;
    readonly version: string;
    readonly external: boolean;
    stream: { close(): void } | undefined;
    opening: Promise<void> | undefined;
    readonly listeners: Map<string, Set<(event: StreamEvent) => void>>;
    readonly lost: Set<(reason: string) => void>;
    readonly reconnected: Set<() => void>;
    /** Ends the wait between two reconnect attempts. */
    cancelReconnect: () => void;
    exited: boolean;
    /** Turns and probes using this server now. */
    users: number;
    /** Replaced (settings changed, closed): it stops once its last user is done. */
    retired: boolean;
    stopped: boolean;
  }
  let running: Promise<Running> | undefined;
  let current: Running | undefined;
  let users = 0;
  let cancelIdle = () => {};
  let disposed = false;
  /** Servers taken out of service that turns still use: stopped with the owner too. */
  const retired = new Set<Running>();

  const clock = options.clock === undefined ? {} : { clock: options.clock };
  const keyOf = (settings: ServerSettings) =>
    JSON.stringify([settings.binaryPath, settings.serverUrl ?? "", settings.serverPassword ?? ""]);

  const stop = (server: Running) => {
    server.stopped = true;
    server.cancelReconnect();
    retired.delete(server);
    server.stream?.close();
    server.stream = undefined;
    if (server.child !== undefined) stopProcess(server.child);
  };

  const start = async (settings: ServerSettings): Promise<Running> => {
    const key = keyOf(settings);
    const url = settings.serverUrl?.trim() ?? "";
    let child: ChildProcess | undefined;
    let client: OpenCodeClient;
    if (url.length > 0) {
      if (!/^https?:\/\//i.test(url)) {
        throw new OpenCodeError("The OpenCode server URL is not a valid http:// or https:// URL.");
      }
      const host = new URL(url).hostname;
      if (
        /^http:/i.test(url) &&
        (settings.serverPassword ?? "").length > 0 &&
        !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)
      ) {
        options.log?.("the opencode server password goes over plain http", { host });
      }
      client = createClient({ url, password: settings.serverPassword, ...clock });
    } else {
      // OpenCode 2 always wants one, and prints a generated one otherwise (T3).
      const password = randomBytes(32).toString("base64url");
      const started = await startServer(settings.binaryPath, options.env(), password);
      child = started.child;
      client = createClient({ url: started.url, password, ...clock });
      // Exited after its "listening" line, before anyone listened for its exit.
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new OpenCodeError(
          `The OpenCode server exited unexpectedly (${child.exitCode ?? child.signalCode}).`,
        );
      }
    }
    // Listening from the start: a server that exits while it is checked is not handed out.
    let exitedEarly: number | null | undefined;
    const early = (code: number | null) => (exitedEarly = code);
    child?.once("exit", early);
    let version: string;
    try {
      version = await verify(client);
      if (exitedEarly !== undefined) {
        throw new OpenCodeError(`The OpenCode server exited unexpectedly (${exitedEarly}).`);
      }
    } catch (error) {
      if (child !== undefined) stopProcess(child);
      throw error;
    } finally {
      child?.off("exit", early);
    }
    const server: Running = {
      key,
      child,
      client,
      version,
      external: child === undefined,
      stream: undefined,
      opening: undefined,
      listeners: new Map(),
      lost: new Set(),
      reconnected: new Set(),
      cancelReconnect: () => {},
      exited: false,
      users: 0,
      retired: false,
      stopped: false,
    };
    child?.once("exit", (code) => {
      server.exited = true;
      retired.delete(server);
      lose(server, `The OpenCode server exited unexpectedly (${code}).`);
      if (current === server) {
        current = undefined;
        running = undefined;
      }
    });
    return server;
  };

  const lose = (server: Running, reason: string) => {
    server.stream?.close();
    server.stream = undefined;
    const handlers = [...server.lost];
    server.lost.clear();
    for (const handler of handlers) handler(reason);
  };

  /** Opens the event stream when none is open: it carries every session's events. */
  const ensureStream = (server: Running): Promise<void> => {
    if (server.stream !== undefined) return Promise.resolve();
    server.opening ??= openStream(server).finally(() => {
      server.opening = undefined;
    });
    return server.opening;
  };

  /**
   * Opens a lost stream again, up to RECONNECT_ATTEMPTS times RECONNECT_DELAY_MS apart (T3's
   * reconnect, D887), then tells the turns; a stream that stays lost loses them.
   */
  const reconnect = (server: Running) => {
    const timers = options.clock ?? realClock;
    const attempt = async (left: number): Promise<void> => {
      if (server.stopped || server.exited) throw new Error("The OpenCode server is gone.");
      try {
        await openStream(server);
      } catch (error) {
        if (left <= 1) throw error;
        await new Promise<void>((resolve) => {
          const cancel = timers.after(RECONNECT_DELAY_MS, resolve);
          // A stop ends the wait: the next attempt sees the server gone.
          server.cancelReconnect = () => {
            cancel();
            resolve();
          };
        });
        server.cancelReconnect = () => {};
        return attempt(left - 1);
      }
    };
    server.opening = attempt(RECONNECT_ATTEMPTS)
      .then(
        () => {
          for (const handler of Array.from(server.reconnected)) handler();
        },
        (error: unknown) => {
          options.log?.("could not reconnect to the opencode event stream", {
            error: String(error),
          });
          // A server that exited meanwhile already told its turns why.
          if (!server.exited) lose(server, RECONNECT_FAILED);
        },
      )
      .finally(() => {
        server.opening = undefined;
      });
  };

  const openStream = (server: Running): Promise<void> =>
    server.client
      .subscribe((event) => {
        const sessionId =
          typeof event.data["sessionID"] === "string"
            ? event.data["sessionID"]
            : typeof (event.data["form"] as { sessionID?: unknown } | undefined)?.sessionID ===
                "string"
              ? (event.data["form"] as { sessionID: string }).sessionID
              : undefined;
        if (sessionId === undefined) return;
        // A handler that stops listening meanwhile is skipped by the set's own iteration.
        for (const handler of server.listeners.get(sessionId) ?? []) {
          // One session's handler failing must not cost every other session its stream.
          try {
            handler(event);
          } catch (error) {
            options.log?.("an opencode event handler failed", {
              type: event.type,
              error: String(error),
            });
          }
        }
      })
      .then((stream) => {
        // Stopped while the stream opened: nothing will close it later.
        if (server.stopped) {
          stream.close();
          return;
        }
        server.stream = stream;
        stream.closed.then(
          () => undefined,
          (error: unknown) => {
            options.log?.("the opencode event stream was lost", { error: String(error) });
            if (server.stream !== stream) return;
            server.stream = undefined;
            reconnect(server);
          },
        );
      });

  /** Starts the idle time of a server nobody uses, as the setting says now (0: none). */
  const armIdle = () => {
    cancelIdle();
    cancelIdle = () => {};
    if (users > 0 || disposed || current === undefined) return;
    const idleMs = options.idleMs();
    if (idleMs <= 0) return;
    cancelIdle = (options.clock ?? realClock).after(idleMs, () => {
      if (users === 0) close();
    });
  };

  const release = () => {
    users--;
    armIdle();
  };

  /**
   * Takes a server out of service: new users get another one, and it stops once the users
   * it has (running turns) are done, so a settings change never cuts a turn off.
   */
  const retire = (server: Running) => {
    server.retired = true;
    if (current === server) {
      current = undefined;
      running = undefined;
    }
    if (server.users === 0) stop(server);
    else retired.add(server);
  };

  const close = () => {
    cancelIdle();
    if (current !== undefined) retire(current);
    running = undefined;
  };

  const acquire = async (): Promise<Running> => {
    for (;;) {
      const settings = options.settings();
      const key = keyOf(settings);
      if (current !== undefined && (current.key !== key || current.exited)) retire(current);
      if (running === undefined) {
        const attempt = start(settings);
        running = attempt;
        attempt.then(
          (server) => {
            if (running === attempt && !disposed) current = server;
            else stop(server);
          },
          () => {
            if (running === attempt) running = undefined;
          },
        );
      }
      const server = await running;
      if (disposed) throw new OpenCodeError("The OpenCode runtime was stopped.");
      // Started with settings that changed meanwhile: retired, the next round starts anew.
      if (server.key !== keyOf(options.settings())) {
        retire(server);
        continue;
      }
      // Replaced or stopped while it started: take the one that serves now.
      if (!server.stopped && !server.retired) return server;
    }
  };

  return {
    /**
     * Runs `use` with the server (started when needed) and its event stream open. The server
     * stays up while anyone uses it; `stream: false` skips opening the event stream.
     */
    async use<T>(use: (connection: Connection) => Promise<T>, stream = true): Promise<T> {
      if (disposed) throw new OpenCodeError("The OpenCode runtime was stopped.");
      users++;
      cancelIdle();
      try {
        const server = await acquire();
        server.users++;
        try {
          if (stream) await ensureStream(server);
          return await useServer(server, use);
        } finally {
          server.users--;
          if (server.retired && server.users === 0) stop(server);
        }
      } finally {
        release();
      }
    },
    /** Applies a changed idle time to a server waiting idle now. */
    rearm: armIdle,
    /** Retires the server: it stops once its running turns are done; the next use starts one. */
    close,
    /** Whether a server is up now (started by the plugin or connected to). */
    get running() {
      return current !== undefined;
    },
    dispose() {
      disposed = true;
      cancelIdle();
      const server = current;
      current = undefined;
      running = undefined;
      if (server !== undefined) stop(server);
      // `stop` removes each from the set, which its own iteration allows.
      for (const busy of retired) stop(busy);
    },
  };

  function useServer<T>(server: Running, use: (connection: Connection) => Promise<T>) {
    return use({
      client: server.client,
      version: server.version,
      external: server.external,
      listen(sessionId, handler) {
        let set = server.listeners.get(sessionId);
        if (set === undefined) server.listeners.set(sessionId, (set = new Set()));
        set.add(handler);
        return () => {
          set.delete(handler);
          if (set.size === 0) server.listeners.delete(sessionId);
        };
      },
      onLost(handler) {
        // Lost before the caller listened (it was open when `use` began): tell it at once.
        if (server.stream === undefined && server.opening === undefined) {
          let disposedEarly = false;
          queueMicrotask(() => {
            if (!disposedEarly) handler("The OpenCode event stream was lost.");
          });
          return () => {
            disposedEarly = true;
          };
        }
        server.lost.add(handler);
        return () => server.lost.delete(handler);
      },
      onReconnected(handler) {
        server.reconnected.add(handler);
        return () => server.reconnected.delete(handler);
      },
    });
  }
}

export type ServerOwner = ReturnType<typeof createServerOwner>;
