import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { createMemoryStreams, type MemoryStreams } from "@jhin/rpc";
import type { Logger } from "@jhin/sdk";
import {
  TERMINALS_STREAM,
  TerminalEvents,
  terminalStream,
  type TerminalSummary,
} from "@jhin/terminal-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { envKey, shellEnv } from "../src/env.ts";
import { createHistoryFiles } from "../src/history.ts";
import {
  createProcessTableReader,
  parseWindowsProcessTable,
  subprocessOf,
  type RunProgram,
} from "../src/processes.ts";
import type { PtyProcess, PtySpawner } from "../src/pty.ts";
import { boundHistory, planTrim } from "../src/scrollback.ts";
import { createSessions } from "../src/sessions.ts";

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function tempDir(): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
  cleanups.push(() => Fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A shell the test drives: it prints what the test says and exits when told or killed. */
class FakeProcess implements PtyProcess {
  readonly pid: number;
  readonly env: Readonly<Record<string, string>>;
  readonly written: string[] = [];
  readonly signals: string[] = [];
  /** The PTY is gone but node-pty has not said so yet: writes and resizes fail. */
  dead = false;
  private exit: { exitCode: number; signal: number | null } | undefined;
  private readonly data = new Set<(data: string) => void>();
  private readonly exits = new Set<(exit: { exitCode: number; signal: number | null }) => void>();

  constructor(pid: number, env: Readonly<Record<string, string>>) {
    this.pid = pid;
    this.env = env;
  }
  write(data: string): void {
    if (this.dead) throw new Error("EBADF: bad file descriptor");
    this.written.push(data);
  }
  resize(): void {
    if (this.dead) throw new Error("ioctl(2) failed, EBADF");
  }
  kill(signal?: string): void {
    this.signals.push(signal ?? "SIGHUP");
    this.exitWith(0, 1);
  }
  print(data: string): void {
    for (const listener of Array.from(this.data)) listener(data);
  }
  exitWith(exitCode: number, signal: number | null = null): void {
    if (this.exit !== undefined) return;
    this.exit = { exitCode, signal };
    for (const listener of Array.from(this.exits)) listener(this.exit);
  }
  onData(listener: (data: string) => void): () => void {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }
  onExit(listener: (exit: { exitCode: number; signal: number | null }) => void): () => void {
    if (this.exit !== undefined) {
      listener(this.exit);
      return () => undefined;
    }
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
}

function fakePty() {
  const spawned: FakeProcess[] = [];
  const pty: PtySpawner = {
    spawn(options) {
      const child = new FakeProcess(1000 + spawned.length, options.env);
      spawned.push(child);
      return child;
    },
  };
  return { pty, spawned };
}

function setup(
  options: {
    streams?: MemoryStreams;
    history?: ReturnType<typeof createHistoryFiles>;
    maxExited?: number;
    env?: Record<string, string>;
    config?: { strip?: string[]; keep?: string[] };
    scrollback?: number;
  } = {},
) {
  const cwd = tempDir();
  const streams = options.streams ?? createMemoryStreams();
  const { pty, spawned } = fakePty();
  const sessions = createSessions({
    streams,
    pty: async () => pty,
    config: () => ({
      shell: "/bin/sh",
      scrollback: options.scrollback ?? 5000,
      ...(options.config === undefined ? {} : { env: options.config }),
    }),
    log: quiet,
    env: options.env ?? { PATH: "/usr/bin", HOME: "/home/someone" },
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.maxExited === undefined ? {} : { maxExited: options.maxExited }),
  });
  cleanups.push(() => sessions.dispose());
  return { cwd, streams, sessions, spawned };
}

describe("review follow-ups (D460)", () => {
  it("answers TERMINAL_NOT_RUNNING for a PTY that died before its exit was reported", async () => {
    const { cwd, sessions, spawned } = setup();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await sessions.open(input);
    spawned[0]!.dead = true;

    expect(() => sessions.write({ ...input, data: "ls\r" })).toThrow(
      expect.objectContaining({
        code: "TERMINAL_NOT_RUNNING",
        details: expect.objectContaining({ error: expect.stringContaining("EBADF") }),
      }),
    );
    expect(() => sessions.resize({ ...input, cols: 90, rows: 20 })).toThrow(
      expect.objectContaining({
        code: "TERMINAL_NOT_RUNNING",
        details: expect.objectContaining({ error: expect.stringContaining("ioctl") }),
      }),
    );
    // The size it could not take is not reported as taken.
    expect(sessions.list()[0]).toMatchObject({ cols: 120, rows: 30 });
  });

  it("closes a session once, however many closes run at once", async () => {
    const { cwd, streams, sessions, spawned } = setup();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await sessions.open(input);
    const events: string[] = [];
    streams.subscribe(terminalStream("t", "term-1"), (event) => events.push(event.type));

    const [first, second] = await Promise.all([
      sessions.close(input),
      sessions.close({ threadId: "t" }),
      sessions.dispose(),
    ]);
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(events.filter((type) => type === TerminalEvents.closed)).toHaveLength(1);
    expect(spawned[0]!.signals).toEqual(["SIGHUP"]);
  });
});

describe("resizes on the terminals stream (D469)", () => {
  it("sends one list for resizes in a row, with the last size, and answers it at once", async () => {
    const { cwd, streams, sessions } = setup();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await sessions.open(input);
    const lists: number[] = [];
    let published!: () => void;
    const next = new Promise<void>((resolve) => (published = resolve));
    streams.subscribe(TERMINALS_STREAM, (event) => {
      lists.push((event.payload as { terminals: TerminalSummary[] }).terminals[0]!.cols);
      published();
    });

    // Dragging the drawer's edge: one size after another.
    for (const cols of [81, 82, 83, 84, 85]) sessions.resize({ ...input, cols, rows: 24 });
    expect(sessions.list()[0]).toMatchObject({ cols: 85 });
    expect(lists).toEqual([]);
    await next;
    expect(lists).toEqual([85]);

    // Any other change sends the list at once, with the size waiting.
    sessions.resize({ ...input, cols: 90, rows: 24 });
    await sessions.open({ ...input, terminalId: "term-2" });
    expect(lists.slice(1, 2)).toEqual([90]);
  });
});

describe("the scrollback cut at a line (D460)", () => {
  const count = (text: string) => ({
    lineBreaks: text.split("\n").length - 1,
    bytes: Buffer.byteLength(text),
    endsWithNewline: text.endsWith("\n"),
  });

  it("keeps exactly the line limit, cutting the oldest event after a line break", () => {
    const outputs = [
      { sequence: 1, data: "a\nb\nc\n" },
      { sequence: 2, data: "d\ne\n" },
      { sequence: 3, data: "f" },
    ];
    const kept = count(outputs.map((output) => output.data).join(""));
    const plan = planTrim(outputs, kept, { lines: 2, bytes: 1000 });
    // a b c d e f is six lines: four go, so the first event goes whole and
    // the second loses "d\n".
    expect([...plan.forget]).toEqual([1]);
    expect(plan.cut).toEqual({ sequence: 2, data: "e\n" });
    expect(kept).toMatchObject({ lineBreaks: 1, bytes: 3 });
  });

  it("keeps the end of a line longer than the byte limit, never half a code point", () => {
    expect(boundHistory("x".repeat(10), { lines: 10, bytes: 4 })).toBe("xxxx");
    // "😀" is two UTF-16 units and four UTF-8 bytes: it goes whole or stays whole.
    expect(boundHistory("ab😀cd", { lines: 10, bytes: 6 })).toBe("😀cd");
    expect(boundHistory("ab😀cd", { lines: 10, bytes: 5 })).toBe("cd");
    expect(boundHistory("1\n2\n3", { lines: 2, bytes: 100 })).toBe("2\n3");
  });
});

describe("the shell's environment (D461, D462)", () => {
  it("leaves out the node's ports, JHIN_* and VITE_*, and what the owner strips", () => {
    const env = shellEnv({
      base: {
        PATH: "/usr/bin",
        PORT: "3000",
        JHIN_TOKEN: "secret",
        VITE_API: "x",
        AWS_SECRET_ACCESS_KEY: "k",
        AWS_REGION: "eu",
        ANTHROPIC_API_KEY: "a",
        COLORTERM: "24bit",
      },
      platform: "linux",
      filter: { strip: ["ANTHROPIC_API_KEY", "AWS_*"] },
    });
    expect(env).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color", COLORTERM: "24bit" });
  });

  it("passes on only what the owner keeps, with the terminal's own variables over it", () => {
    const env = shellEnv({
      base: { PATH: "/usr/bin", HOME: "/h", LC_ALL: "C", SECRET: "s" },
      platform: "linux",
      filter: { keep: ["PATH", "HOME", "LC_*"] },
      extra: { HOME: "/elsewhere", FOO: "bar" },
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/elsewhere",
      LC_ALL: "C",
      FOO: "bar",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });

  it("compares names without case on Windows", () => {
    const env = shellEnv({
      base: { Path: "C:\\Windows", ComSpec: "cmd.exe", Secret_Key: "s" },
      platform: "win32",
      filter: { strip: ["SECRET_*"] },
      extra: { PATH: "C:\\tools" },
    });
    expect(env).toEqual({
      PATH: "C:\\tools",
      ComSpec: "cmd.exe",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });

  it("scrubs an AppImage's mount from the environment", () => {
    const env = shellEnv({
      base: {
        APPIMAGE: "/a.AppImage",
        APPDIR: "/tmp/.mount_x/",
        PATH: "/tmp/.mount_x/usr/bin:/usr/bin",
        LD_LIBRARY_PATH: "/tmp/.mount_x/lib",
      },
      platform: "linux",
    });
    expect(env).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color", COLORTERM: "truecolor" });
  });

  it("starts a shell with the terminal's env and refuses another one while it runs", async () => {
    const { cwd, sessions, spawned } = setup({ config: { strip: ["HOME"] } });
    const input = { threadId: "t", terminalId: "term-1", cwd, env: { FOO: "1", BAR: "2" } };
    await sessions.open(input);
    expect(spawned[0]!.env).toMatchObject({ FOO: "1", BAR: "2", PATH: "/usr/bin" });
    expect(spawned[0]!.env["HOME"]).toBeUndefined();

    // The same variables in another order are the same environment.
    await expect(sessions.open({ ...input, env: { BAR: "2", FOO: "1" } })).resolves.toMatchObject({
      status: "running",
    });
    const refused = sessions.open({ ...input, env: { FOO: "zzz-secret" } });
    await expect(refused).rejects.toMatchObject({ code: "TERMINAL_ENV_MISMATCH" });
    // The variables are not told back.
    await refused.catch((error: { details: unknown; message: string }) => {
      expect(JSON.stringify(error.details)).not.toContain("zzz-secret");
      expect(error.message).not.toContain("zzz-secret");
    });
    await expect(sessions.open({ threadId: "t", terminalId: "term-1", cwd })).rejects.toMatchObject(
      { code: "TERMINAL_ENV_MISMATCH" },
    );
    expect(spawned).toHaveLength(1);
    expect(JSON.stringify(sessions.list())).not.toContain("FOO");

    // A shell that exited starts its next one with the env of that open.
    spawned[0]!.exitWith(0);
    await sessions.open({ ...input, env: { FOO: "zzz-secret" } });
    expect(spawned[1]!.env["FOO"]).toBe("zzz-secret");
    expect(envKey({ b: "1", a: "2" })).toBe(envKey({ a: "2", b: "1" }));
  });
});

describe("history across node restarts (D464)", () => {
  it("shows a terminal's output after the node started over, and forgets it on close", async () => {
    const dir = tempDir();
    const first = setup({ history: createHistoryFiles(dir, quiet) });
    const input = { threadId: "t", terminalId: "term-1", cwd: first.cwd };
    await first.sessions.open(input);
    first.spawned[0]!.print("before the restart\r\n");
    // The plugin stops: its sessions end, their history is written and kept.
    await first.sessions.dispose();
    const file = Path.join(dir, "t", "term-1.log");
    expect(Fs.readFileSync(file, "utf8")).toBe("before the restart\r\n");

    const streams = createMemoryStreams();
    const second = setup({ streams, history: createHistoryFiles(dir, quiet) });
    await second.sessions.open({ ...input, cwd: second.cwd });
    second.spawned[0]!.print("$ ");
    // Reading the terminal sends what waits for the next tick.
    expect(second.sessions.get("t", "term-1")?.history).toBe("before the restart\r\n$ ");
    const kept = streams.events(terminalStream("t", "term-1"));
    expect(kept.map((event) => event.type)).toEqual([
      TerminalEvents.started,
      TerminalEvents.output,
      TerminalEvents.output,
    ]);

    // A shell that exits and starts again in the same run starts empty.
    second.spawned[0]!.exitWith(0);
    await second.sessions.open({ ...input, cwd: second.cwd });
    expect(second.sessions.get("t", "term-1")?.history).toBe("");

    second.spawned[1]!.print("old\r\n");
    // Closed, and opened again under the same ids before the close is done:
    // the new terminal does not show the history its close deletes.
    const closing = second.sessions.close({ threadId: "t", terminalId: "term-1" });
    await second.sessions.open({ ...input, cwd: second.cwd });
    await closing;
    expect(second.sessions.get("t", "term-1")?.history).toBe("");
    await second.sessions.close({ threadId: "t", terminalId: "term-1" });
    expect(Fs.existsSync(file)).toBe(false);
  });

  it("reads only the tail of a long history file, within the limits, and caps the file", async () => {
    const dir = tempDir();
    const file = Path.join(dir, "t", "term-1.log");
    Fs.mkdirSync(Path.dirname(file), { recursive: true });
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}\r\n`).join("");
    // A multibyte character the byte limit cuts into.
    Fs.writeFileSync(file, `é${lines}`);
    const history = createHistoryFiles(dir, quiet);

    const read = await history.read("t", "term-1", { lines: 100, bytes: 1_000_000 });
    expect(read.startsWith("line 201\r\n")).toBe(true);
    expect(read.endsWith("line 300\r\n")).toBe(true);
    expect(Fs.readFileSync(file, "utf8")).toBe(read);

    const tail = await history.read("t", "term-1", { lines: 1000, bytes: 13 });
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(13);
    expect(tail.endsWith("line 300\r\n")).toBe(true);
  });
});

describe("exited sessions kept (D465)", () => {
  it("closes the ones that exited longest ago past the limit, never a running one", async () => {
    let clock = 0;
    const cwd = tempDir();
    const streams = createMemoryStreams();
    const { pty, spawned } = fakePty();
    const sessions = createSessions({
      streams,
      pty: async () => pty,
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: quiet,
      env: {},
      maxExited: 1,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    });
    cleanups.push(() => sessions.dispose());
    const closed: string[] = [];
    for (const id of ["term-1", "term-2", "term-3"]) {
      streams.subscribe(terminalStream("t", id), (event) => {
        if (event.type === TerminalEvents.closed) closed.push(id);
      });
      await sessions.open({ threadId: "t", terminalId: id, cwd });
    }
    spawned[0]!.exitWith(0);
    expect(closed).toEqual([]);
    spawned[1]!.exitWith(0);
    // Two exited, one allowed: the one that exited first goes.
    expect(closed).toEqual(["term-1"]);
    expect(sessions.list().map((item) => [item.terminalId, item.status])).toEqual([
      ["term-2", "exited"],
      ["term-3", "running"],
    ]);
  });
});

describe("the process table (D467, D468)", () => {
  it("grows its buffer when ps output is cut short, up to 16 MiB", async () => {
    const buffers: number[] = [];
    const run: RunProgram = async (_command, _args, options) => {
      buffers.push(options.maxBuffer);
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    };
    const read = createProcessTableReader({ platform: "linux", run });
    for (let attempt = 0; attempt < 7; attempt += 1) await expect(read()).rejects.toThrow();
    expect(buffers.map((bytes) => bytes / 1024)).toEqual([
      512, 1024, 2048, 4096, 8192, 16384, 16384,
    ]);
  });

  it("reads PowerShell's process table on Windows, names without .exe", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: RunProgram = async (command, args) => {
      calls.push({ command, args });
      return "4|0|System\r\n100|1|pwsh.exe\r\n200|100|node.exe\r\n\r\nbad line\r\n";
    };
    const table = await createProcessTableReader({ platform: "win32", run })();
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args.join(" ")).toContain("Get-CimInstance Win32_Process");
    expect(subprocessOf(table, 100)).toEqual({ running: true, label: "node" });
    expect(subprocessOf(parseWindowsProcessTable("100|1|C:\\bin\\pwsh.exe\n"), 100)).toEqual({
      running: false,
      label: "",
    });
  });
});
