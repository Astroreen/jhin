// Session handling follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts — default size, scrollback, shell, the
// environment kept from the node, the kill grace, polling for the program a
// terminal runs, history kept across restarts and the limit on exited sessions.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

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

import { envKey, shellEnv, type EnvFilter } from "./env.ts";
import type { HistoryStore } from "./history.ts";
import type { PtyProcess, PtySpawner } from "./pty.ts";
import { subprocessOf, type ProcessTable } from "./processes.ts";
import { lineBreaks, planTrim, type HistoryLimits } from "./scrollback.ts";

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
/** Sessions without a process kept at most (T3's `maxRetainedInactiveSessions`, D465). */
const MAX_EXITED_SESSIONS = 128;
/** A change that is only a size reaches the `terminals` stream at most this often (D469). */
const RESIZE_PUBLISH_MS = 100;

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
  readonly config: () => {
    shell?: string | undefined;
    scrollback: number;
    env?: EnvFilter | undefined;
  };
  readonly log: Logger;
  /** Where output is kept across restarts (D464); nothing is kept without it. */
  readonly history?: HistoryStore;
  /** The environment shells start from; the node's unless a test picks one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How many sessions without a process are kept (128, T3's). */
  readonly maxExited?: number;
  /** Reads the working directory; `fs.promises.stat` unless a test controls it. */
  readonly stat?: (path: string) => Promise<Fs.Stats>;
  /** This run's id (`TerminalSummary.instance`); a random one unless a test picks it. */
  readonly instance?: string;
  /** How often the process table is read while a terminal runs (1 s, T3's). */
  readonly pollIntervalMs?: number;
  readonly now?: () => string;
}

interface Session {
  readonly threadId: string;
  readonly terminalId: string;
  readonly stream: string;
  cwd: string;
  /** `cwd` without links, to tell whether another `cwd` names the same folder. */
  realCwd: string;
  process: PtyProcess | undefined;
  /** Set while a process is being started for it. */
  starting: Promise<void> | undefined;
  /** Closed: its stream ended, what the process still prints goes nowhere. */
  closed: boolean;
  /** Set once closing starts: a second close waits for it (D460). */
  closing: Promise<void> | undefined;
  /** The terminal's own variables as `envKey` gives them, for the next open to compare. */
  envKey: string;
  /** This node always names its run (`instance`), which 1.1 allows a provider to leave out. */
  summary: TerminalSummary & { instance: string };
  /** Output not sent yet: what arrived within this tick. */
  pending: string;
  flush: ReturnType<typeof setImmediate> | undefined;
  /** What the stream keeps of the current process's output. */
  kept: { lineBreaks: number; bytes: number; endsWithNewline: boolean };
  /** Resolves when the current process exited. */
  exited: Promise<void>;
  stop: (() => void)[];
}

const key = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;
/** Refused once the plugin is going: nothing is left to stop a process started now. */
const stopping = () =>
  new TerminalError("TERMINAL_UNAVAILABLE", "Terminals are stopping with their plugin");
const notRunning = (threadId: string, terminalId: string, error?: unknown) =>
  new TerminalError(
    "TERMINAL_NOT_RUNNING",
    `Terminal ${terminalId} in thread ${threadId} is not running`,
    {
      threadId,
      terminalId,
      ...(error === undefined ? {} : { error: String(error) }),
    },
  );

function defaultShell(): string {
  if (process.platform === "win32") return process.env["COMSPEC"] ?? "powershell.exe";
  return process.env["SHELL"] ?? "/bin/sh";
}

/** The node's terminals: one PTY process per session, its output in the session's live stream. */
export function createSessions(options: SessionOptions): TerminalSessions & {
  readonly instance: string;
  dispose(): Promise<void>;
} {
  const { streams, log } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const sessions = new Map<string, Session>();
  /** Closes still stopping their process: deactivation waits for them too. */
  const closing = new Set<Promise<void>>();
  let disposed = false;
  let resizePublish: ReturnType<typeof setTimeout> | undefined;
  let spawner: Promise<PtySpawner> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let pollFailures = 0;
  /** This run of the node's terminals: a client that comes back tells a restart by it. */
  const instance = options.instance ?? Crypto.randomUUID();
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  /** Every session after a change; the stream keeps only the latest list. */
  const publish = () => {
    if (resizePublish !== undefined) clearTimeout(resizePublish);
    resizePublish = undefined;
    streams.clear(TERMINALS_STREAM);
    streams.append(TERMINALS_STREAM, TerminalEvents.sessions, {
      terminals: [...sessions.values()].map((session) => session.summary),
    });
  };
  /** A change that is only a size: published once the window ends, or with the next change. */
  const publishSizes = () => {
    if (resizePublish !== undefined || disposed) return;
    resizePublish = setTimeout(publish, RESIZE_PUBLISH_MS);
    resizePublish.unref?.();
  };
  const update = (session: Session, change: Partial<Omit<TerminalSummary, "instance">>) => {
    session.summary = { ...session.summary, ...change, updatedAt: now() };
  };

  const find = (threadId: string, terminalId: string): Session => {
    const session = sessions.get(key(threadId, terminalId));
    if (session === undefined) {
      throw new TerminalError(
        "TERMINAL_NOT_FOUND",
        `No terminal ${terminalId} in thread ${threadId}`,
        { threadId, terminalId, instance },
      );
    }
    return session;
  };
  const running = (threadId: string, terminalId: string): Session & { process: PtyProcess } => {
    const session = find(threadId, terminalId);
    if (session.process === undefined || session.summary.status !== "running") {
      throw notRunning(threadId, terminalId);
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

  const limits = (): HistoryLimits => ({
    lines: options.config().scrollback,
    bytes: MAX_SCROLLBACK_BYTES,
  });
  /** The output the stream keeps, oldest first. */
  const historyOf = (session: Session) =>
    streams
      .events(session.stream)
      .filter((event) => event.type === TerminalEvents.output)
      .map((event) => (event.payload as { data: string }).data)
      .join("");
  /** Writes the kept output to the session's history file soon (D464). */
  const persist = (session: Session) => {
    if (session.closed) return;
    options.history?.write(session.threadId, session.terminalId, () => historyOf(session));
  };

  /**
   * Forgets the oldest output until what is kept fits the scrollback: whole
   * events, then the oldest one left cut after a line break or at a code
   * point (D460); never the `terminal.started` that opens the stream, nor
   * events of other kinds. Bytes are counted as UTF-8, as they leave the node.
   */
  const trim = (session: Session) => {
    const { lines, bytes } = limits();
    const { kept } = session;
    const keptLines = kept.lineBreaks + (kept.endsWithNewline || kept.bytes === 0 ? 0 : 1);
    if (keptLines <= lines && kept.bytes <= bytes) return;
    // One look at the stream: pick what to forget, then forget it at once.
    // Other events (`terminal.started`, any kind added later) stay where they are.
    const outputs = streams
      .events(session.stream)
      .filter((event) => event.type === TerminalEvents.output)
      .map((event) => ({
        sequence: event.sequence,
        data: (event.payload as { data: string }).data,
      }));
    const plan = planTrim(outputs, kept, { lines, bytes });
    if (plan.forget.size > 0) streams.remove(session.stream, plan.forget);
    if (plan.cut !== undefined) {
      streams.update(session.stream, plan.cut.sequence, { data: plan.cut.data });
    }
  };
  /** Adds output to the stream's count. */
  const count = (session: Session, data: string) => {
    session.kept.lineBreaks += lineBreaks(data);
    session.kept.bytes += Buffer.byteLength(data);
    session.kept.endsWithNewline = data.endsWith("\n");
  };
  const flushOutput = (session: Session) => {
    if (session.flush !== undefined) clearImmediate(session.flush);
    session.flush = undefined;
    const data = session.pending;
    if (data.length === 0) return;
    session.pending = "";
    streams.append(session.stream, TerminalEvents.output, { data });
    count(session, data);
    trim(session);
    persist(session);
  };

  async function start(
    session: Session,
    size: { cols: number; rows: number },
    launch: { env: Readonly<Record<string, string>> | undefined; fresh: boolean },
  ): Promise<void> {
    const pty = await loadPty();
    // A session the node did not have may have history from an earlier run (D464).
    const restored =
      launch.fresh && options.history !== undefined
        ? await options.history
            .read(session.threadId, session.terminalId, limits())
            .catch((error: unknown) => {
              log.warn("terminal history not read", {
                threadId: session.threadId,
                terminalId: session.terminalId,
                error: String(error),
              });
              return "";
            })
        : "";
    if (disposed) throw stopping();
    // Closed while node-pty loaded: no process for it, and the open fails.
    if (session.closed) {
      throw new TerminalError(
        "TERMINAL_NOT_FOUND",
        `Terminal ${session.terminalId} in thread ${session.threadId} was closed while it started`,
        { threadId: session.threadId, terminalId: session.terminalId },
      );
    }
    const config = options.config();
    const shell = config.shell ?? defaultShell();
    const env = shellEnv({
      base: options.env ?? process.env,
      platform: process.platform,
      filter: config.env,
      extra: launch.env,
    });
    let child: PtyProcess;
    try {
      child = pty.spawn({ shell, args: [], cwd: session.cwd, ...size, env });
    } catch (error) {
      throw new TerminalError(
        "TERMINAL_UNAVAILABLE",
        `Could not start ${shell}: ${(error as Error).message}`,
        { shell },
      );
    }
    session.process = child;
    session.envKey = envKey(launch.env);
    session.pending = "";
    session.kept = { lineBreaks: 0, bytes: 0, endsWithNewline: false };
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
    if (restored.length > 0) {
      streams.append(session.stream, TerminalEvents.output, { data: restored });
      count(session, restored);
    }
    persist(session);
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
        evictExited();
      }),
    ];
    publish();
    schedulePoll(pollInterval);
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

  /**
   * Ends a session: its stream at once, its process after. Once only: a
   * second close of the same session gets the first one's promise (D460).
   * `keepHistory` when the plugin stops, so the next run shows it (D464).
   */
  function closeSession(session: Session, keepHistory = false): Promise<void> {
    session.closing ??= (async () => {
      const id = key(session.threadId, session.terminalId);
      if (sessions.get(id) === session) sessions.delete(id);
      publish();
      // The stream ends now, before the process is gone: a session opened again
      // under these ids meanwhile starts its stream afresh and keeps it.
      flushOutput(session);
      // What the next run shows: taken now, the stream is about to go.
      if (keepHistory && options.history !== undefined) {
        const kept = historyOf(session);
        options.history.write(session.threadId, session.terminalId, () => kept);
      }
      session.closed = true;
      streams.append(session.stream, TerminalEvents.closed, {});
      streams.delete(session.stream);
      // Started now, before anything waits: a session opened again under these
      // ids meanwhile writes its own history only after this delete.
      const forgetting = keepHistory
        ? undefined
        : options.history?.delete(session.threadId, session.terminalId);
      // A process on its way is stopped once it is there.
      await session.starting?.catch(() => undefined);
      await stopProcess(session);
      await forgetting;
    })();
    const done = session.closing;
    closing.add(done);
    void done.finally(() => closing.delete(done));
    return done;
  }

  /** Closes the sessions without a process updated longest ago, past the limit (D465). */
  function evictExited() {
    const limit = options.maxExited ?? MAX_EXITED_SESSIONS;
    const exited = [...sessions.values()].filter(
      (session) => session.process === undefined && session.starting === undefined,
    );
    if (exited.length <= limit) return;
    exited.sort(
      (left, right) =>
        left.summary.updatedAt.localeCompare(right.summary.updatedAt) ||
        left.threadId.localeCompare(right.threadId) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    for (const session of exited.slice(0, exited.length - limit)) {
      void closeSession(session).catch((error: unknown) =>
        log.warn("exited terminal not closed", {
          threadId: session.threadId,
          terminalId: session.terminalId,
          error: String(error),
        }),
      );
    }
  }

  /** Resizes a running process; a PTY already gone answers `TERMINAL_NOT_RUNNING` (D460). */
  function resizeProcess(session: Session & { process: PtyProcess }, cols: number, rows: number) {
    try {
      session.process.resize(cols, rows);
    } catch (error) {
      // node-pty's "ioctl failed" for a PTY that died before its exit was reported.
      throw notRunning(session.threadId, session.terminalId, error);
    }
    update(session, { cols, rows });
    publishSizes();
  }

  // --- What a terminal runs ------------------------------------------------
  function schedulePoll(delay: number) {
    if (options.processTable === undefined || disposed || poll !== undefined) return;
    if (![...sessions.values()].some((session) => session.process !== undefined)) return;
    poll = setTimeout(() => {
      void inspect().finally(() => {
        poll = undefined;
        schedulePoll(Math.min(pollInterval * 2 ** pollFailures, MAX_POLL_INTERVAL_MS));
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
      // Said once per run of failures: polling backs off, and the indicator and
      // tab labels stop until `ps` answers again (a process table past its buffer).
      if (pollFailures === 1) {
        log.warn("process table not read; terminal labels and indicators wait for it", {
          error: String(error),
        });
      } else log.debug("process table not read", { error: String(error) });
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
    instance,
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
      const realCwd = await Fs.promises.realpath(input.cwd).catch(() => Path.resolve(input.cwd));
      // Disposed while the folder was read: the sessions it closed did not
      // include this one, so it must not start one now.
      if (disposed) throw stopping();
      const id = key(input.threadId, input.terminalId);
      const existing = sessions.get(id);
      const wantedEnv = envKey(input.env);
      /**
       * A running shell stays where and how it started: another folder or
       * environment is refused, not ignored.
       */
      const sameFolder = (session: Session) => {
        if (session.realCwd !== realCwd) {
          throw new TerminalError(
            "TERMINAL_CWD_MISMATCH",
            `Terminal ${input.terminalId} in thread ${input.threadId} runs in ${session.summary.cwd}, not ${input.cwd}`,
            { threadId: input.threadId, terminalId: input.terminalId, cwd: session.summary.cwd },
          );
        }
        // The variables are never told back: they may be secrets.
        if (session.envKey !== wantedEnv) {
          throw new TerminalError(
            "TERMINAL_ENV_MISMATCH",
            `Terminal ${input.terminalId} in thread ${input.threadId} runs with another environment`,
            { threadId: input.threadId, terminalId: input.terminalId },
          );
        }
      };
      if (existing?.starting !== undefined) {
        // Opened twice at once: one process, both get it.
        await existing.starting;
        sameFolder(existing);
        return existing.summary;
      }
      if (existing?.process !== undefined) {
        sameFolder(existing);
        const cols = input.cols ?? existing.summary.cols;
        const rows = input.rows ?? existing.summary.rows;
        if (cols !== existing.summary.cols || rows !== existing.summary.rows) {
          resizeProcess(existing as Session & { process: PtyProcess }, cols, rows);
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
        realCwd,
        process: undefined,
        starting: undefined,
        closed: false,
        closing: undefined,
        envKey: "",
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
          instance,
          ...size,
        },
        pending: "",
        flush: undefined,
        kept: { lineBreaks: 0, bytes: 0, endsWithNewline: false },
        exited: Promise.resolve(),
        stop: [],
      };
      session.cwd = input.cwd;
      session.realCwd = realCwd;
      sessions.set(id, session);
      session.starting = start(session, size, { env: input.env, fresh: existing === undefined });
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
      const session = running(input.threadId, input.terminalId);
      try {
        session.process.write(input.data);
      } catch (error) {
        // The PTY died before node-pty reported its exit (EBADF).
        throw notRunning(input.threadId, input.terminalId, error);
      }
    },
    resize(input) {
      const session = running(input.threadId, input.terminalId);
      if (session.summary.cols === input.cols && session.summary.rows === input.rows) return;
      resizeProcess(session, input.cols, input.rows);
    },
    async close(input: CloseTerminalInput) {
      const matching = [...sessions.values()].filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.terminalId === undefined || session.terminalId === input.terminalId),
      );
      await Promise.all(matching.map((session) => closeSession(session)));
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
      // Their history stays for the next run (D464); closes already running are waited for.
      await Promise.all([
        ...[...sessions.values()].map((session) => closeSession(session, true)),
        ...closing,
      ]);
      if (resizePublish !== undefined) clearTimeout(resizePublish);
      resizePublish = undefined;
      await options.history?.flush();
    },
  };
}
