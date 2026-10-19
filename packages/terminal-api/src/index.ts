// The shape of terminal sessions follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/terminal.ts.
import { z } from "@jhin/sdk";

/** `terminal.sessions@1`: the terminal sessions of a node (docs/plans/terminal.md). */
export const TERMINAL_SESSIONS_CAPABILITY = "terminal.sessions";

/** The node's live stream of its sessions: one `terminal.sessions` event after each change. */
export const TERMINALS_STREAM = "terminals";
/** Every session's live stream starts with this. */
export const TERMINAL_STREAM_PREFIX = "terminal/";
/** The live stream of one session: what it printed, when it started, exited and closed. */
export const terminalStream = (threadId: string, terminalId: string): string =>
  `${TERMINAL_STREAM_PREFIX}${threadId}/${terminalId}`;

/** Event types of the terminal streams. */
export const TerminalEvents = {
  /**
   * Session stream: `{ terminal }`, a summary. A process started, the first
   * one or a new one after the last exited: output before it belongs to an
   * earlier process.
   */
  started: "terminal.started",
  /** Session stream: `{ data }`, what the process printed. */
  output: "terminal.output",
  /** Session stream: `{ exitCode, signal }`. */
  exited: "terminal.exited",
  /** Session stream: `{}`; the session is gone and its stream ends. */
  closed: "terminal.closed",
  /** `terminals` stream: `{ terminals }`, every session of the node after a change. */
  sessions: "terminal.sessions",
} as const;

/** Error codes of the terminal commands. */
export type TerminalErrorCode =
  /** No session with that thread and terminal id. */
  | "TERMINAL_NOT_FOUND"
  /** The session's process exited: open it again to start a new one. */
  | "TERMINAL_NOT_RUNNING"
  /** The working directory does not exist or is not a directory. */
  | "TERMINAL_CWD_INVALID"
  /** The session runs in another folder: `cwd` counts only when a shell starts (1.1). */
  | "TERMINAL_CWD_MISMATCH"
  /** The node cannot start terminals: its PTY module did not load, or the shell did not start. */
  | "TERMINAL_UNAVAILABLE";

/** Part of a stream name: no `/`, so a session's stream names exactly one session. */
const StreamPart = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "letters, digits, . _ : -");

/** The thread a terminal belongs to; its project's folder is where it starts. */
export const TerminalThreadId = StreamPart;
/** Chosen by the client, as in T3 Code (`term-1`, `term-2`, …): there is no server-side allocation. */
export const TerminalId = StreamPart;
export const TerminalCols = z.number().int().min(1).max(1000);
export const TerminalRows = z.number().int().min(1).max(500);

export const TerminalStatus = z.enum(["running", "exited"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TerminalSummary = z.object({
  threadId: z.string(),
  terminalId: z.string(),
  /** Where the process started. */
  cwd: z.string(),
  status: TerminalStatus,
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** A program other than the shell runs in it (T3's "terminal process running"). */
  hasRunningSubprocess: z.boolean(),
  /** That program's name, for the tab; empty while the shell waits. */
  label: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  /**
   * Which run of the node's terminals holds the session: new whenever they
   * start over (a node restart, a plugin reload). `TERMINAL_NOT_FOUND`
   * carries it in its details too, so a client tells "closed while I was
   * away" (same instance) from "the node started over" (another one). Added
   * in 1.1: a client should expect it missing from an older node.
   */
  instance: z.string(),
});
export type TerminalSummary = z.infer<typeof TerminalSummary>;

export const TerminalSnapshot = TerminalSummary.extend({
  /** What the session's stream still holds of the output, oldest first. */
  history: z.string(),
  /** The head of the session's stream: subscribe after it to follow on. */
  sequence: z.number().int(),
});
export type TerminalSnapshot = z.infer<typeof TerminalSnapshot>;

export const OpenTerminalInput = z.object({
  threadId: TerminalThreadId,
  terminalId: TerminalId,
  /** Absolute; usually the folder of the thread's project. */
  cwd: z.string().min(1).max(4096),
  cols: TerminalCols.optional(),
  rows: TerminalRows.optional(),
});
export type OpenTerminalInput = z.infer<typeof OpenTerminalInput>;

export const WriteTerminalInput = z.object({
  threadId: TerminalThreadId,
  terminalId: TerminalId,
  data: z.string().min(1).max(65_536),
});
export type WriteTerminalInput = z.infer<typeof WriteTerminalInput>;

export const ResizeTerminalInput = z.object({
  threadId: TerminalThreadId,
  terminalId: TerminalId,
  cols: TerminalCols,
  rows: TerminalRows,
});
export type ResizeTerminalInput = z.infer<typeof ResizeTerminalInput>;

export const CloseTerminalInput = z.object({
  threadId: TerminalThreadId,
  /** Without it, every terminal of the thread. */
  terminalId: TerminalId.optional(),
});
export type CloseTerminalInput = z.infer<typeof CloseTerminalInput>;

/** `terminal.sessions@1` for other plugins of the node; the `terminals.*` commands use it. */
export interface TerminalSessions {
  /** The run these sessions belong to (`TerminalSummary.instance`, 1.1). */
  readonly instance: string;
  /**
   * Starts a shell in `cwd`, or returns the session already running under
   * these ids (resized to `cols` × `rows` when given). A session whose
   * process exited starts a new process.
   */
  open(input: OpenTerminalInput): Promise<TerminalSummary>;
  write(input: WriteTerminalInput): void;
  resize(input: ResizeTerminalInput): void;
  /** Ends the sessions and their processes; resolves with how many it closed. */
  close(input: CloseTerminalInput): Promise<number>;
  list(threadId?: string): readonly TerminalSummary[];
  get(threadId: string, terminalId: string): TerminalSnapshot | undefined;
}
