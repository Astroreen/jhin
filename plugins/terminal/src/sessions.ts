// Session handling follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts — default size, scrollback, shell, the
// environment kept from the node, the kill grace and polling for the program
// a terminal runs. T3's history files, restart-on-attach and Windows process
// table are not ported.
import * as Fs from "node:fs";

import type { MemoryStreams } from "@jhin/rpc";
import type { Logger } from "@jhin/sdk";
import {
  TERMINALS_STREAM,
  TerminalEvents,
  terminalStream,
  type CloseTerminalInput,
  type TerminalErrorCode,
  type TerminalSessions,
  type TerminalSnapshot,
  type TerminalSummary,
} from "@jhin/terminal-api";

import type { PtyProcess, PtySpawner } from "./pty.ts";
import { subprocessOf, type ProcessTable } from "./processes.ts";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** How long a closed terminal's process has to exit after SIGHUP before it is killed. */
const KILL_GRACE_MS = 1000;
/** Most output kept per session, whatever the line count. */
const MAX_SCROLLBACK_BYTES = 8 * 1024 * 1024;
/** Output is sent at most this big per event; a burst within one tick is one event. */
const MAX_CHUNK_LENGTH = 64 * 1024;
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 60_000;
/** The node's own ports would confuse dev servers started in a terminal. */
const ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: TerminalErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface SessionOptions {
  readonly streams: MemoryStreams;
  /** Resolves with node-pty, or rejects with why it cannot load. */
  readonly pty: () => Promise<PtySpawner>;
  /** The process table, to tell when a program runs in a terminal; none on Windows. */
  readonly processTable?: () => Promise<ProcessTable>;
  readonly config: () => { shell?: string | undefined; scrollback: number };
  readonly log: Logger;
  /** Reads the working directory; `fs.promises.stat` unless a test controls it. */
  readonly stat?: (path: string) => Promise<Fs.Stats>;
  readonly now?: () => string;
}

interface Session {
  readonly threadId: string;
  readonly terminalId: string;
  readonly stream: string;
  cwd: string;
  process: PtyProcess | undefined;
  /** Set while a process is being started for it. */
  starting: Promise<void> | undefined;
  /** Closed: its stream ended, what the process still prints goes nowhere. */
  closed: boolean;
  summary: TerminalSummary;
  /** Output not sent yet: what arrived within this tick. */
  pending: string;
  flush: ReturnType<typeof setImmediate> | undefined;
  /** What the stream keeps of the current process's output. */
  keptLines: number;
  keptBytes: number;
  /** Resolves when the current process exited. */
  exited: Promise<void>;
  stop: (() => void)[];
}

const key = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;
/** Refused once the plugin is going: nothing is left to stop a process started now. */
const stopping = () =>
  new TerminalError("TERMINAL_UNAVAILABLE", "Terminals are stopping with their plugin");
const lines = (data: string) => data.split("\n").length - 1;

function defaultShell(): string {
  if (process.platform === "win32") return process.env["COMSPEC"] ?? "powershell.exe";
  return process.env["SHELL"] ?? "/bin/sh";
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !ENV_BLOCKLIST.has(name)) env[name] = value;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  return env;
}

/** The node's terminals: one PTY process per session, its output in the session's live stream. */
export function createSessions(options: SessionOptions): TerminalSessions & {
  dispose(): Promise<void>;
} {
  const { streams, log } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const sessions = new Map<string, Session>();
  let disposed = false;
  let spawner: Promise<PtySpawner> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let pollFailures = 0;

  /** Every session after a change; the stream keeps only the latest list. */
  const publish = () => {
    streams.clear(TERMINALS_STREAM);
    streams.append(TERMINALS_STREAM, TerminalEvents.sessions, {
      terminals: [...sessions.values()].map((session) => session.summary),
    });
  };
  const update = (session: Session, change: Partial<TerminalSummary>) => {
    session.summary = { ...session.summary, ...change, updatedAt: now() };
  };

  const find = (threadId: string, terminalId: string): Session => {
    const session = sessions.get(key(threadId, terminalId));
    if (session === undefined) {
      throw new TerminalError(
        "TERMINAL_NOT_FOUND",
        `No terminal ${terminalId} in thread ${threadId}`,
        { threadId, terminalId },
      );
    }
    return session;
  };
  const running = (threadId: string, terminalId: string): Session & { process: PtyProcess } => {
    const session = find(threadId, terminalId);
    if (session.process === undefined || session.summary.status !== "running") {
      throw new TerminalError(
        "TERMINAL_NOT_RUNNING",
        `Terminal ${terminalId} in thread ${threadId} is not running`,
        { threadId, terminalId },
      );
    }
    return session as Session & { process: PtyProcess };
  };

  const loadPty = (): Promise<PtySpawner> => {
    spawner ??= options.pty().catch((error: unknown) => {
      // Cached: a module that failed to load fails the same way until the plugin restarts.
      throw new TerminalError(
        "TERMINAL_UNAVAILABLE",
        `Terminals are unavailable on this node: node-pty did not load (${(error as Error).message})`,
        { platform: process.platform, arch: process.arch },
      );
    });
    return spawner;
  };

  /**
   * Forgets the oldest output until what is kept fits the scrollback: whole
   * events, never the newest one nor the `terminal.started` that opens the
   * stream. Bytes are counted as UTF-8, as they leave the node.
   */
  const trim = (session: Session) => {
    const limit = options.config().scrollback;
    while (session.keptLines > limit || session.keptBytes > MAX_SCROLLBACK_BYTES) {
      const kept = streams.events(session.stream);
      const oldest = kept.find((event) => event.type === TerminalEvents.output);
      if (oldest === undefined || oldest === kept.at(-1)) return;
      const data = (oldest.payload as { data: string }).data;
      session.keptLines -= lines(data);
      session.keptBytes -= Buffer.byteLength(data);
      streams.remove(session.stream, oldest.sequence);
    }
  };
  const flushOutput = (session: Session) => {
    if (session.flush !== undefined) clearImmediate(session.flush);
    session.flush = undefined;
    const data = session.pending;
    if (data.length === 0) return;
    session.pending = "";
    streams.append(session.stream, TerminalEvents.output, { data });
    session.keptLines += lines(data);
    session.keptBytes += Buffer.byteLength(data);
    trim(session);
  };

  async function start(session: Session, size: { cols: number; rows: number }): Promise<void> {
    const pty = await loadPty();
    if (disposed) throw stopping();
    // Closed while node-pty loaded: no process for it, and the open fails.
    if (session.closed) {
      throw new TerminalError(
        "TERMINAL_NOT_FOUND",
        `Terminal ${session.terminalId} in thread ${session.threadId} was closed while it started`,
        { threadId: session.threadId, terminalId: session.terminalId },
      );
    }
    const shell = options.config().shell ?? defaultShell();
    let child: PtyProcess;
    try {
      child = pty.spawn({ shell, args: [], cwd: session.cwd, ...size, env: shellEnv() });
    } catch (error) {
      throw new TerminalError(
        "TERMINAL_UNAVAILABLE",
        `Could not start ${shell}: ${(error as Error).message}`,
        { shell },
      );
    }
    session.process = child;
    session.pending = "";
    session.keptLines = 0;
    session.keptBytes = 0;
    update(session, {
      cwd: session.cwd,
      status: "running",
      pid: child.pid,
      exitCode: null,
      signal: null,
      hasRunningSubprocess: false,
      label: "",
      startedAt: now(),
      ...size,
    });
    // Output before this belongs to an earlier process.
    streams.clear(session.stream);
    streams.append(session.stream, TerminalEvents.started, { terminal: session.summary });
    let exited!: () => void;
    session.exited = new Promise((resolve) => (exited = resolve));
    session.stop = [
      child.onData((data) => {
        if (session.process !== child || session.closed) return;
        session.pending += data;
        if (session.pending.length >= MAX_CHUNK_LENGTH) flushOutput(session);
        else session.flush ??= setImmediate(() => flushOutput(session));
      }),
      child.onExit((exit) => {
        exited();
        if (session.process !== child) return;
        flushOutput(session);
        session.process = undefined;
        for (const stop of session.stop) stop();
        update(session, {
          status: "exited",
          exitCode: exit.exitCode,
          signal: exit.signal,
          hasRunningSubprocess: false,
          label: "",
        });
        // A closed session ends with `terminal.closed`, not with the exit it caused.
        if (sessions.get(key(session.threadId, session.terminalId)) !== session) return;
        streams.append(session.stream, TerminalEvents.exited, {
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
        publish();
      }),
    ];
    publish();
    schedulePoll(POLL_INTERVAL_MS);
  }

  /** Ends the session's process: SIGHUP as a closed terminal does, SIGKILL after the grace. */
  async function stopProcess(session: Session): Promise<void> {
    const child = session.process;
    if (child === undefined) return;
    try {
      child.kill("SIGHUP");
    } catch (error) {
      log.debug("SIGHUP failed", { pid: child.pid, error: String(error) });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), KILL_GRACE_MS);
    });
    const outcome = await Promise.race([session.exited, graceOver]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        log.debug("SIGKILL failed", { pid: child.pid, error: String(error) });
      }
      await session.exited;
    }
  }

  async function closeSession(session: Session): Promise<void> {
    sessions.delete(key(session.threadId, session.terminalId));
    publish();
    // The stream ends now, before the process is gone: a session opened again
    // under these ids meanwhile starts its stream afresh and keeps it.
    session.closed = true;
    flushOutput(session);
    streams.append(session.stream, TerminalEvents.closed, {});
    streams.delete(session.stream);
    // A process on its way is stopped once it is there.
    await session.starting?.catch(() => undefined);
    await stopProcess(session);
  }

  // --- What a terminal runs ------------------------------------------------
  function schedulePoll(delay: number) {
    if (options.processTable === undefined || disposed || poll !== undefined) return;
    if (![...sessions.values()].some((session) => session.process !== undefined)) return;
    poll = setTimeout(() => {
      void inspect().finally(() => {
        poll = undefined;
        schedulePoll(Math.min(POLL_INTERVAL_MS * 2 ** pollFailures, MAX_POLL_INTERVAL_MS));
      });
    }, delay);
    poll.unref?.();
  }
  async function inspect(): Promise<void> {
    let table: ProcessTable;
    try {
      table = await options.processTable!();
      pollFailures = 0;
    } catch (error) {
      // A partial table would make every terminal look idle: this round is skipped.
      pollFailures += 1;
      log.debug("process table not read", { error: String(error) });
      return;
    }
    let changed = false;
    for (const session of sessions.values()) {
      if (session.process === undefined) continue;
      const found = subprocessOf(table, session.process.pid);
      if (
        found.running === session.summary.hasRunningSubprocess &&
        found.label === session.summary.label
      ) {
        continue;
      }
      update(session, { hasRunningSubprocess: found.running, label: found.label });
      changed = true;
    }
    if (changed) publish();
  }

  publish();

  return {
    async open(input) {
      if (disposed) throw stopping();
      let stat: Fs.Stats | undefined;
      try {
        stat = await (options.stat ?? Fs.promises.stat)(input.cwd);
      } catch {
        stat = undefined;
      }
      if (stat?.isDirectory() !== true) {
        throw new TerminalError(
          "TERMINAL_CWD_INVALID",
          stat === undefined
            ? `Terminal cwd does not exist: ${input.cwd}`
            : `Terminal cwd is not a directory: ${input.cwd}`,
          { cwd: input.cwd },
        );
      }
      // Disposed while the folder was read: the sessions it closed did not
      // include this one, so it must not start one now.
      if (disposed) throw stopping();
      const id = key(input.threadId, input.terminalId);
      const existing = sessions.get(id);
      if (existing?.starting !== undefined) {
        // Opened twice at once: one process, both get it.
        await existing.starting;
        return existing.summary;
      }
      if (existing?.process !== undefined) {
        const cols = input.cols ?? existing.summary.cols;
        const rows = input.rows ?? existing.summary.rows;
        if (cols !== existing.summary.cols || rows !== existing.summary.rows) {
          existing.process.resize(cols, rows);
          update(existing, { cols, rows });
        }
        return existing.summary;
      }
      const size = {
        cols: input.cols ?? existing?.summary.cols ?? DEFAULT_COLS,
        rows: input.rows ?? existing?.summary.rows ?? DEFAULT_ROWS,
      };
      const at = now();
      const session: Session = existing ?? {
        threadId: input.threadId,
        terminalId: input.terminalId,
        stream: terminalStream(input.threadId, input.terminalId),
        cwd: input.cwd,
        process: undefined,
        starting: undefined,
        closed: false,
        summary: {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "exited",
          pid: null,
          exitCode: null,
          signal: null,
          hasRunningSubprocess: false,
          label: "",
          startedAt: at,
          updatedAt: at,
          ...size,
        },
        pending: "",
        flush: undefined,
        keptLines: 0,
        keptBytes: 0,
        exited: Promise.resolve(),
        stop: [],
      };
      session.cwd = input.cwd;
      sessions.set(id, session);
      session.starting = start(session, size);
      try {
        await session.starting;
      } catch (error) {
        if (existing === undefined && sessions.get(id) === session) sessions.delete(id);
        throw error;
      } finally {
        session.starting = undefined;
      }
      log.info("terminal started", {
        threadId: input.threadId,
        terminalId: input.terminalId,
        pid: session.summary.pid,
      });
      return session.summary;
    },
    write(input) {
      running(input.threadId, input.terminalId).process.write(input.data);
    },
    resize(input) {
      const session = running(input.threadId, input.terminalId);
      if (session.summary.cols === input.cols && session.summary.rows === input.rows) return;
      session.process.resize(input.cols, input.rows);
      update(session, { cols: input.cols, rows: input.rows });
    },
    async close(input: CloseTerminalInput) {
      const matching = [...sessions.values()].filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.terminalId === undefined || session.terminalId === input.terminalId),
      );
      await Promise.all(matching.map(closeSession));
      return matching.length;
    },
    list(threadId) {
      return [...sessions.values()]
        .filter((session) => threadId === undefined || session.threadId === threadId)
        .map((session) => session.summary);
    },
    get(threadId, terminalId): TerminalSnapshot | undefined {
      const session = sessions.get(key(threadId, terminalId));
      if (session === undefined) return undefined;
      flushOutput(session);
      const kept = streams.events(session.stream);
      return {
        ...session.summary,
        history: kept
          .filter((event) => event.type === TerminalEvents.output)
          .map((event) => (event.payload as { data: string }).data)
          .join(""),
        sequence: kept.at(-1)?.sequence ?? 0,
      };
    },
    async dispose() {
      disposed = true;
      if (poll !== undefined) clearTimeout(poll);
      poll = undefined;
      await Promise.all([...sessions.values()].map(closeSession));
    },
  };
}
