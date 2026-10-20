// Finding the program a terminal runs follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts (parsePosixProcessTable, deriveSubprocessInspectResult,
// windowsProcessTableSnapshot).
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";

const MAX_LABEL_LENGTH = 128;

export interface ProcessTable {
  readonly childrenByParent: ReadonlyMap<number, readonly number[]>;
  readonly commandById: ReadonlyMap<number, string>;
}

/** What runs in a terminal besides its shell. */
export interface Subprocess {
  readonly running: boolean;
  /** The program's name, e.g. `vim`; empty when nothing runs or it has no name. */
  readonly label: string;
}

/** `ps -eo pid=,ppid=,comm=`: the command is the last column and may hold spaces. */
export function parseProcessTable(stdout: string): ProcessTable {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

/** PowerShell's `ProcessId|ParentProcessId|Name` lines (Windows). */
export function parseWindowsProcessTable(stdout: string): ProcessTable {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function commandName(raw: string): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const first = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  // Windows names may be paths with either separator, and end in `.exe`.
  const base = first.split(/[\\/]/).at(-1) ?? first;
  const name = base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return name.length > 0 ? name : null;
}

/** The program the shell `shellPid` runs, if any. */
export function subprocessOf(table: ProcessTable, shellPid: number): Subprocess {
  const name = (pid: number) => commandName(table.commandById.get(pid) ?? "");
  const shellName = name(shellPid);
  // Async prompt themes fork the shell into a helper that waits with no
  // children of its own: that copy is not a command the user started.
  const child = (table.childrenByParent.get(shellPid) ?? []).find(
    (pid) =>
      shellName === null ||
      name(pid) !== shellName ||
      (table.childrenByParent.get(pid)?.length ?? 0) > 0,
  );
  if (child === undefined) return { running: false, label: "" };
  return { running: true, label: (name(child) ?? "").slice(0, MAX_LABEL_LENGTH) };
}

/** The most output a process table read may take (D467). */
const MAX_TABLE_BYTES = 16 * 1024 * 1024;

/** Runs a program and resolves with its output; `maxBuffer` cuts it short with an error. */
export type RunProgram = (
  command: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<string>;

/** An error of `child_process` for output past `maxBuffer`. */
const cutShort = (error: unknown) =>
  (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

const runProgram: RunProgram = (command, args, options) =>
  new Promise((resolve, reject) => {
    ChildProcess.execFile(
      command,
      [...args],
      { ...options, windowsHide: true },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });

/**
 * Reads the process table: `ps` (POSIX), or PowerShell's process table on
 * Windows. Rejects when the read fails or is cut short, since a partial
 * table would make every terminal look idle; output cut short doubles the
 * buffer for the next read, up to 16 MiB, kept for the reader's life.
 */
export function createProcessTableReader(
  options: { platform?: NodeJS.Platform; run?: RunProgram } = {},
): () => Promise<ProcessTable> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProgram;
  const windows = platform === "win32";
  // An absolute path once: spawning a bare name walks every PATH entry on each poll.
  const command = windows
    ? "powershell.exe"
    : (["/bin/ps", "/usr/bin/ps"].find((candidate) => Fs.existsSync(candidate)) ?? "ps");
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }',
      ]
    : ["-eo", "pid=,ppid=,comm="];
  let maxBuffer = windows ? 256 * 1024 : 512 * 1024;
  const timeout = windows ? 1500 : 1000;
  return async () => {
    let stdout: string;
    try {
      stdout = await run(command, args, { timeout, maxBuffer });
    } catch (error) {
      if (cutShort(error) && maxBuffer < MAX_TABLE_BYTES) {
        maxBuffer = Math.min(maxBuffer * 2, MAX_TABLE_BYTES);
      }
      throw error;
    }
    return windows ? parseWindowsProcessTable(stdout) : parseProcessTable(stdout);
  };
}
