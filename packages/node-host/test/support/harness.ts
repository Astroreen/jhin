import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Readline from "node:readline";

const DRIVER = Path.join(import.meta.dirname, "driver.ts");

interface Message {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A node host running in a child process, driven over JSON lines. */
export class HostProcess {
  readonly #child: ChildProcess.ChildProcessWithoutNullStreams;
  readonly #messages: Message[] = [];
  readonly #waiters = new Set<{
    match: (message: Message) => boolean;
    resolve: (message: Message) => void;
  }>();
  #nextId = 1;
  stderr = "";

  constructor(options: Record<string, unknown>) {
    this.#child = ChildProcess.spawn(process.execPath, [DRIVER, JSON.stringify(options)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.on("data", (chunk) => (this.stderr += String(chunk)));
    Readline.createInterface({ input: this.#child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Message;
      this.#messages.push(message);
      for (const waiter of this.#waiters) {
        if (waiter.match(message)) {
          this.#waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
    });
  }

  /** Every message received so far: events and results. */
  get received(): readonly Message[] {
    return this.#messages;
  }

  /** Resolves with the first message (already received or future) that matches. */
  waitFor(match: (message: Message) => boolean): Promise<Message> {
    const seen = this.#messages.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => this.#waiters.add({ match, resolve }));
  }

  /** Resolves with the next matching message received after this call. */
  next(match: (message: Message) => boolean): Promise<Message> {
    return new Promise((resolve) => this.#waiters.add({ match, resolve }));
  }

  async ready(): Promise<{ inspection: any }> {
    return (await this.waitFor((message) => message.type === "ready")) as never;
  }

  async execute(command: string, input: unknown = {}): Promise<{ value?: any; error?: any }> {
    const id = this.#nextId++;
    const result = this.waitFor((message) => message.type === "result" && message["id"] === id);
    this.#child.stdin.write(`${JSON.stringify({ id, command, input })}\n`);
    return (await result) as never;
  }

  async stop(): Promise<void> {
    const id = this.#nextId++;
    const exited = new Promise((resolve) => this.#child.once("exit", resolve));
    this.#child.stdin.write(`${JSON.stringify({ id, stop: true })}\n`);
    await exited;
  }
}

export function tempDir(prefix: string): string {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-${prefix}-`));
}

/** Writes a plugin package: `files` maps relative paths to contents. */
export function writePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): string {
  Fs.mkdirSync(dir, { recursive: true });
  Fs.writeFileSync(
    Path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: String(manifest["id"]),
        type: "module",
        jhin: { version: "1.0.0", apiVersion: 1, side: "server", entry: "index.ts", ...manifest },
      },
      null,
      2,
    ),
  );
  for (const [file, content] of Object.entries(files)) {
    Fs.mkdirSync(Path.dirname(Path.join(dir, file)), { recursive: true });
    Fs.writeFileSync(Path.join(dir, file), content);
  }
  return dir;
}
