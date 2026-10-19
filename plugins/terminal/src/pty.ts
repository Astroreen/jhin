// Loading node-pty follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/NodePtyAdapter.ts.
import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

interface PtyExit {
  readonly exitCode: number;
  readonly signal: number | null;
}

/** One process on a pseudo terminal. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): () => void;
  /** Called once; at once when the process already exited. */
  onExit(listener: (exit: PtyExit) => void): () => void;
}

interface PtySpawnOptions {
  readonly shell: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface PtySpawner {
  spawn(options: PtySpawnOptions): PtyProcess;
}

type NodePty = typeof import("node-pty");

// node-pty loads a native addon; `require` resolves it and its spawn-helper on disk.
const require = Module.createRequire(import.meta.url);

/**
 * The macOS prebuilds start shells through `spawn-helper`, which some
 * package managers unpack without its executable bit.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  let dir: string;
  try {
    dir = Path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return;
  }
  for (const candidate of [
    Path.join(dir, "build", "Release", "spawn-helper"),
    Path.join(dir, "build", "Debug", "spawn-helper"),
    Path.join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ]) {
    if (!Fs.existsSync(candidate)) continue;
    try {
      Fs.chmodSync(candidate, 0o755);
    } catch {
      // A read-only install keeps whatever mode it has.
    }
    return;
  }
}

class NodePtyProcess implements PtyProcess {
  private readonly native: import("node-pty").IPty;
  private exit: PtyExit | undefined;
  private readonly exitListeners = new Set<(exit: PtyExit) => void>();

  constructor(native: import("node-pty").IPty) {
    this.native = native;
    const subscription = native.onExit((event) => {
      if (this.exit !== undefined) return;
      this.exit = { exitCode: event.exitCode, signal: event.signal ?? null };
      subscription.dispose();
      for (const listener of Array.from(this.exitListeners)) listener(this.exit);
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.native.pid;
  }

  write(data: string): void {
    this.native.write(data);
  }

  resize(cols: number, rows: number): void {
    this.native.resize(cols, rows);
  }

  kill(signal?: string): void {
    // node-pty ends the Windows process tree without a POSIX signal.
    this.native.kill(process.platform === "win32" ? undefined : signal);
  }

  onData(listener: (data: string) => void): () => void {
    const subscription = this.native.onData(listener);
    return () => subscription.dispose();
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    if (this.exit !== undefined) {
      listener(this.exit);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

/** Loads node-pty; rejects with why when this platform has no working build of it. */
export async function loadNodePty(): Promise<PtySpawner> {
  const pty = require("node-pty") as NodePty;
  ensureSpawnHelperExecutable();
  return {
    spawn(options) {
      // node-pty sets TERM from `name` on Unix only; ConPTY children need it in env.
      const env =
        process.platform === "win32" && options.env["TERM"] === undefined
          ? { ...options.env, TERM: "xterm-256color" }
          : options.env;
      const native = pty.spawn(options.shell, [...options.args], {
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        env,
        name: "xterm-256color",
      });
      return new NodePtyProcess(native);
    },
  };
}
