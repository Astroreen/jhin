// The machine an import reads, as T3 Code's HostProcess references give it (MIT, see
// THIRD_PARTY_NOTICES.md): packages/shared/src/HostProcess.ts. docs/plans/preview.md, D1204.
import * as ChildProcess from "node:child_process";
import * as Dns from "node:dns";
import * as Os from "node:os";
import * as Path from "node:path";

export interface RunOptions {
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

/** Whether a run failed because its signal aborted it (a timeout included). */
export const isAborted = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "AbortError";

export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** The node's machine, as the import sees it; tests give their own. */
export interface ImportHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  hostname(): string;
  /** Every address of this machine (its interfaces and what its hostname resolves to). */
  addresses(): Promise<ReadonlySet<string>>;
  /**
   * Runs a program to its end; rejects when it cannot be started, or when
   * `signal` aborts it (the program is killed, the error is an `AbortError`).
   */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Signal 0: only ESRCH proves the process is gone. */
  isProcessAlive(pid: number): boolean;
}

export const pathFor = (platform: NodeJS.Platform): Path.PlatformPath =>
  platform === "win32" ? Path.win32 : Path.posix;

/** Signal 0 to a pid; anything but ESRCH stays "alive", so a lock is never mistaken for stale. */
export function processIsAlive(
  pid: number,
  signalProcess: (pid: number, signal: 0) => unknown = process.kill.bind(process),
): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "ESRCH"
    );
  }
}

export function runProgram(
  command: string,
  args: readonly string[],
  options: RunOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, args, {
      env: options.env ?? process.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      // An aborted run kills the program and fails with an AbortError.
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // Both drained at once: a full stderr pipe must not stall the program's stdout.
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    // A program that exits before reading its input fails the write with EPIPE: its
    // exit code reports that, and an unhandled stream error would end the node.
    child.stdin?.on("error", () => undefined);
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

const abortError = (reason: unknown): Error =>
  Object.assign(new Error("The operation was aborted", { cause: reason }), { name: "AbortError" });

/**
 * The host with identical runs going on at once shared: a second import while a
 * Keychain prompt is open waits for the same `security`, it does not start
 * another prompt. Each caller waits under its own signal; the program is killed
 * only once every caller waiting for it has given up. A run with input on stdin
 * (DPAPI's wrapped key) is never shared, so no secret is kept as a key.
 */
export function sharingRuns(host: ImportHost): ImportHost {
  const running = new Map<
    string,
    { readonly result: Promise<RunResult>; readonly stop: AbortController; waiting: number }
  >();
  return {
    ...host,
    run(command, args, options) {
      if (options?.stdin !== undefined) return host.run(command, args, options);
      const key = JSON.stringify([command, args]);
      let entry = running.get(key);
      if (entry === undefined) {
        const stop = new AbortController();
        const result = host.run(command, args, { signal: stop.signal });
        const started = { result, stop, waiting: 0 };
        running.set(key, started);
        const forget = () => {
          if (running.get(key) === started) running.delete(key);
        };
        result.then(forget, forget);
        entry = started;
      }
      const shared = entry;
      shared.waiting += 1;
      const signal = options?.signal;
      return new Promise<RunResult>((resolve, reject) => {
        let left = false;
        const leave = () => {
          if (left) return;
          left = true;
          signal?.removeEventListener("abort", onAbort);
          shared.waiting -= 1;
        };
        const onAbort = () => {
          leave();
          // Nobody waits any more: the prompt goes too.
          if (shared.waiting === 0) {
            if (running.get(key) === shared) running.delete(key);
            shared.stop.abort(signal?.reason);
          }
          reject(abortError(signal?.reason));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        shared.result.then(
          (value) => {
            if (left) return;
            leave();
            resolve(value);
          },
          (error: unknown) => {
            if (left) return;
            leave();
            reject(error);
          },
        );
      });
    },
  };
}

/** The node's own machine. */
export const nodeImportHost: ImportHost = {
  platform: process.platform,
  env: process.env,
  hostname: () => Os.hostname(),
  async addresses() {
    const interfaces = Object.values(Os.networkInterfaces())
      .flat()
      .flatMap((entry) => (entry ? [entry.address] : []));
    const resolved = await Dns.promises
      .lookup(Os.hostname(), { all: true })
      .then((entries) => entries.map((entry) => entry.address))
      .catch(() => [] as string[]);
    return new Set([...interfaces, ...resolved]);
  },
  run: (command, args, options) => runProgram(command, args, { ...options, env: process.env }),
  isProcessAlive: (pid) => processIsAlive(pid),
};
