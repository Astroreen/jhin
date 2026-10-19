// Finding the program a terminal runs follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts (parsePosixProcessTable, deriveSubprocessInspectResult).
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
  const base = first.split("/").at(-1) ?? first;
  return base.length > 0 ? base : null;
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

// An absolute path once: spawning a bare name walks every PATH entry on each poll.
const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) => Fs.existsSync(candidate)) ?? "ps";

/**
 * Reads the process table; rejects when `ps` fails or is cut short, since a
 * partial table would make every terminal look idle.
 */
export function readProcessTable(): Promise<ProcessTable> {
  return new Promise((resolve, reject) => {
    ChildProcess.execFile(
      ps,
      ["-eo", "pid=,ppid=,comm="],
      { timeout: 1000, maxBuffer: 512 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(parseProcessTable(stdout));
      },
    );
  });
}
