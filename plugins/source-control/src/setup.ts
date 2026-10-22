// A new worktree's setup follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/project/WorktreeSetupTracker.ts (the snapshot of each thread's setup)
// and apps/server/src/project/ProjectSetupScriptRunner.ts (running the setup script in a
// terminal and reading its exit code from a sentinel line).
import * as Crypto from "node:crypto";

import type { ProjectScript } from "@jhin/agent-api";
import type { Disposable } from "@jhin/sdk";
import { TerminalEvents, type TerminalSessions } from "@jhin/terminal-api";
import {
  WORKTREE_SETUP_DETAIL_MAX_LENGTH,
  WORKTREE_SETUP_ERROR_MAX_LENGTH,
  WORKTREE_SETUP_STAGE_ORDER,
  WORKTREE_SETUP_TAIL_LINES,
  WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
  type WorktreeSetupStageId,
  type WorktreeSetupStageStatus,
} from "@jhin/source-control-api";

// --- The tracker ------------------------------------------------------------------------

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

const clampDetail = (detail: string | null): string | null =>
  detail === null ? null : clampText(detail, WORKTREE_SETUP_DETAIL_MAX_LENGTH);

function emptyStage(id: WorktreeSetupStageId): WorktreeSetupStage {
  return {
    id,
    status: "pending",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  };
}

export interface SetupTracker {
  begin(input: {
    threadId: string;
    branch: string | null;
    baseRef: string | null;
    stages: readonly WorktreeSetupStageId[];
  }): void;
  update(
    threadId: string,
    mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ): void;
  stage(
    threadId: string,
    id: WorktreeSetupStageId,
    patch: Partial<Omit<WorktreeSetupStage, "id">>,
  ): void;
  stageStatus(
    threadId: string,
    id: WorktreeSetupStageId,
    status: WorktreeSetupStageStatus,
    detail?: string | null,
  ): void;
  appendTail(threadId: string, id: WorktreeSetupStageId, line: string): void;
  finish(threadId: string, phase: "done" | "failed" | "cancelled", error?: string | null): void;
  get(threadId: string): WorktreeSetupSnapshot | null;
}

/**
 * T3's `WorktreeSetupTracker`: the snapshot of each thread's setup, handed to
 * `publish` after every change. A finished one stays until the thread's next setup.
 */
export function createSetupTracker(options: {
  publish: (snapshot: WorktreeSetupSnapshot) => void;
  now?: () => string;
}): SetupTracker {
  const now = options.now ?? (() => new Date().toISOString());
  const setups = new Map<string, WorktreeSetupSnapshot>();

  const set = (snapshot: WorktreeSetupSnapshot) => {
    setups.set(snapshot.threadId, snapshot);
    options.publish(snapshot);
  };

  const tracker: SetupTracker = {
    begin(input) {
      const previous = setups.get(input.threadId);
      set({
        threadId: input.threadId,
        phase: "running",
        startedAt: now(),
        endedAt: null,
        branch: input.branch,
        baseRef: input.baseRef,
        worktreePath: null,
        setupScript: null,
        stages: WORKTREE_SETUP_STAGE_ORDER.filter((id) => input.stages.includes(id)).map(
          emptyStage,
        ),
        error: null,
        // Sequences keep growing across setups of one thread, as in T3.
        sequence: previous === undefined ? 0 : previous.sequence + 1,
      });
    },
    update(threadId, mutate) {
      const existing = setups.get(threadId);
      if (existing === undefined) return;
      set({ ...mutate(existing), sequence: existing.sequence + 1 });
    },
    stage(threadId, id, patch) {
      tracker.update(threadId, (snapshot) => ({
        ...snapshot,
        stages: snapshot.stages.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                ...patch,
                ...(patch.detail === undefined
                  ? {}
                  : { detail: clampDetail(patch.detail ?? null) }),
              }
            : entry,
        ),
      }));
    },
    stageStatus(threadId, id, status, detail) {
      const at = now();
      tracker.update(threadId, (snapshot) => ({
        ...snapshot,
        stages: snapshot.stages.map((entry) => {
          if (entry.id !== id) return entry;
          const startedAt = entry.startedAt ?? (status === "pending" ? null : at);
          const endedAt =
            status === "running" || status === "pending" ? null : (entry.endedAt ?? at);
          return {
            ...entry,
            status,
            startedAt,
            endedAt,
            ...(detail === undefined ? {} : { detail: clampDetail(detail ?? null) }),
          };
        }),
      }));
    },
    appendTail(threadId, id, line) {
      tracker.update(threadId, (snapshot) => ({
        ...snapshot,
        stages: snapshot.stages.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                tail: [...entry.tail, clampText(line, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)].slice(
                  -WORKTREE_SETUP_TAIL_LINES,
                ),
              }
            : entry,
        ),
      }));
    },
    finish(threadId, phase, error) {
      const endedAt = now();
      tracker.update(threadId, (snapshot) => ({
        ...snapshot,
        phase,
        endedAt,
        error: error == null ? null : clampText(error, WORKTREE_SETUP_ERROR_MAX_LENGTH),
        stages: snapshot.stages.map((entry) =>
          entry.status === "running"
            ? {
                ...entry,
                status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
                endedAt,
              }
            : entry,
        ),
      }));
    },
    get: (threadId) => setups.get(threadId) ?? null,
  };
  return tracker;
}

// --- Running the script -----------------------------------------------------------------

/** Each run gets its own random token so script output cannot spoof completion. */
const COMPLETION_SENTINEL_PREFIX = "__JHIN_SETUP_DONE__";
const OUTPUT_LINE_MAX_LENGTH = 400;
const PARTIAL_LINE_MAX_LENGTH = 4_096;

const completionSentinel = (token: string) => `${COMPLETION_SENTINEL_PREFIX}_${token}:`;
const completionSentinelPattern = (token: string) =>
  new RegExp(`${COMPLETION_SENTINEL_PREFIX}_${token}:(-?\\d+)`);

/** Terminal escapes and control characters out of a line of output. */
function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex -- removing control characters is the point.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

export type CompletionShell = "posix" | "fish" | "powershell";

/** The shell the terminal starts, as far as the wrapper's syntax goes. */
export function completionShellOf(
  platform: NodeJS.Platform,
  shell: string | undefined,
): CompletionShell {
  if (platform === "win32") return "powershell";
  const name = (shell ?? "").split("/").at(-1) ?? "";
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return "posix";
}

/**
 * The command runs inside a block and the block closes on its own line, so a
 * trailing `# comment` or a heredoc terminator in the command cannot swallow the
 * sentinel. The shell reads the whole block before running any of it, so a script
 * that reads stdin cannot consume the sentinel line either.
 */
export function wrapCommandForCompletion(
  command: string,
  shell: CompletionShell,
  sentinel: string,
  env: Readonly<Record<string, string>> = {},
): string {
  const body = `${exportsFor(shell, env)}${command.replace(/\r?\n/g, "\r")}`;
  switch (shell) {
    case "powershell":
      return `$global:LASTEXITCODE = $null; & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__jc = $LASTEXITCODE } elseif ($?) { $__jc = 0 } else { $__jc = 1 }; Write-Host "${sentinel}$__jc"`;
    case "fish":
      return `begin\r${body}\rend; printf '\\n${sentinel}%s\\n' $status`;
    case "posix":
      return `( ${body}\r); printf '\\n${sentinel}%s\\n' "$?"`;
  }
}

/**
 * The script's variables, set inside its block: a terminal opened with an
 * `env` of its own would refuse the drawer's later open of it (`TERMINAL_ENV_MISMATCH`).
 */
function exportsFor(shell: CompletionShell, env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      switch (shell) {
        case "powershell":
          return `$env:${name} = '${value.replaceAll("'", "''")}'; `;
        case "fish":
          return `set -lx ${name} '${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'; `;
        case "posix":
          return `export ${name}='${value.replaceAll("'", "'\\''")}'; `;
      }
    })
    .join("");
}

/** How a session's live stream is followed: its events as the terminal plugin serves them. */
export type FollowTerminal = (
  threadId: string,
  terminalId: string,
  listener: (event: { type: string; payload: unknown }) => void,
) => Disposable | undefined;

export interface StartedScript {
  readonly terminalId: string;
  /** The exit code; null when the terminal exited or closed before the sentinel came. */
  readonly completion: Promise<number | null>;
}

/**
 * T3's `ProjectSetupScriptRunner.runForThread`: opens the thread's setup terminal
 * in the worktree and types the script into it, wrapped so that its exit code
 * comes back on a sentinel line. Output lines go to `onLine`.
 */
export async function runSetupScript(input: {
  terminals: TerminalSessions;
  follow: FollowTerminal;
  threadId: string;
  script: ProjectScript;
  projectRoot: string;
  worktreePath: string;
  shell: CompletionShell;
  onLine: (line: string) => void;
}): Promise<StartedScript> {
  const terminalId = `setup-${input.script.id}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  const token = Crypto.randomUUID().replaceAll("-", "");
  const sentinel = completionSentinel(token);
  const pattern = completionSentinelPattern(token);
  const commandLine = wrapCommandForCompletion(input.script.command, input.shell, sentinel, {
    JHIN_PROJECT_ROOT: input.projectRoot,
    JHIN_WORKTREE_PATH: input.worktreePath,
    // Setup can run before a client attaches: truecolor probes would wait for replies nobody sends.
    COLORTERM: "",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  /** The shell echoes typed input; lines ending with these are the wrapper, not output. */
  const echoed = commandLine.split("\r").filter((line) => line.length > 0);

  await input.terminals.open({ threadId: input.threadId, terminalId, cwd: input.worktreePath });

  let settle: (code: number | null) => void = () => undefined;
  const completion = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let buffer = "";
  const done = (code: number | null) => {
    if (settled) return;
    settled = true;
    subscription?.dispose();
    settle(code);
  };
  const handleLine = (raw: string) => {
    const found = pattern.exec(raw);
    if (found !== null) {
      const parsed = Number(found[1]);
      done(Number.isFinite(parsed) ? parsed : null);
      return;
    }
    const cleaned = stripTerminalControl(raw).trimEnd();
    if (
      cleaned.length === 0 ||
      cleaned.includes(sentinel) ||
      echoed.some((line) => cleaned.endsWith(line))
    ) {
      return;
    }
    input.onLine(cleaned.slice(0, OUTPUT_LINE_MAX_LENGTH));
  };
  // Subscribed before writing, so the sentinel cannot race past the listener.
  const subscription = input.follow(input.threadId, terminalId, (event) => {
    if (settled) return;
    if (event.type === TerminalEvents.output) {
      buffer += (event.payload as { data: string }).data;
      // A bare carriage return redraws a progress line: each redraw is a line of its own.
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      // A script that never prints a newline must not grow this forever.
      if (buffer.length > PARTIAL_LINE_MAX_LENGTH) buffer = buffer.slice(-PARTIAL_LINE_MAX_LENGTH);
      for (const line of lines) {
        handleLine(line);
        if (settled) return;
      }
    } else if (event.type === TerminalEvents.exited || event.type === TerminalEvents.closed) {
      done(null);
    }
  });
  if (subscription === undefined) done(null);
  try {
    input.terminals.write({ threadId: input.threadId, terminalId, data: `${commandLine}\r` });
  } catch (error) {
    done(null);
    throw error;
  }
  return { terminalId, completion };
}
