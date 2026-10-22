import { execFileSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { spawn } from "node:child_process";

import {
  LIVE_STREAMS_CAPABILITY,
  createLiveStreams,
  createMemoryStreams,
  type LiveStreams,
  type RpcClient,
} from "@jhin/rpc";
import {
  TERMINAL_SESSIONS_CAPABILITY,
  TERMINAL_STREAM_PREFIX,
  TerminalEvents,
  terminalStream,
  type OpenTerminalInput,
  type TerminalSessions,
} from "@jhin/terminal-api";
import {
  SOURCE_CONTROL_STREAM,
  type ProjectStatus,
  type StatusSnapshot,
  type ThreadBranch,
} from "@jhin/source-control-api";
import type { Logger } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
} from "@jhin/testing";
import { afterEach } from "vite-plus/test";

import agent from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import sourceControl from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

export const temp = (prefix: string) => {
  const dir = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix)));
  cleanups.push(() => Fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** Runs git in `cwd` and returns its output. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

export const write = (dir: string, file: string, content: string) => {
  Fs.mkdirSync(Path.dirname(Path.join(dir, file)), { recursive: true });
  Fs.writeFileSync(Path.join(dir, file), content);
};

/** A repository on `main` with one commit of `README.md` (three lines). */
export function repository(): string {
  const dir = temp("jhin-sc-repo-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  // The node commits too (git actions), with whatever identity the repository has.
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  write(dir, "README.md", "one\ntwo\nthree\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

/**
 * A `gh` on PATH answering from files: `pr-<branch>.json` is what
 * `gh pr list --head <branch>` prints (`[]` when absent); with `exit` present
 * it prints `stderr` and exits with that code. Every call is logged to `calls`.
 */
export function fakeGh(): {
  dir: string;
  pullRequest(branch: string, value: unknown[]): void;
  fail(code: number, stderr: string): void;
  /** Answers again after `fail`. */
  recover(): void;
  /** What `gh pr view <url ending in number>` prints. */
  view(number: number, value: unknown): void;
  /** What `gh pr list --search` prints: the repository's pull requests. */
  list(value: unknown[]): void;
  /** The checks `gh pr checks --required` names (it exits 8 while some are pending). */
  required(names: string[]): void;
  /** Makes `gh pr create` print `stderr` and exit with `code`. */
  failCreate(code: number, stderr: string): void;
  /** The body file `gh pr create` was given for `head`. */
  body(head: string): string | undefined;
  calls(): string[];
} {
  const dir = temp("jhin-fake-gh-");
  const script = `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ -f "${dir}/exit" ]; then cat "${dir}/stderr" >&2; exit "$(cat "${dir}/exit")"; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ -f "${dir}/create-exit" ]; then cat "${dir}/create-stderr" >&2; exit "$(cat "${dir}/create-exit")"; fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) base="$2"; shift 2;;
      --head) head="$2"; shift 2;;
      --title) title="$2"; shift 2;;
      --body-file) cp "$2" "${dir}/body-$head.md"; shift 2;;
      *) shift;;
    esac
  done
  printf '[{"number":42,"title":"%s","url":"https://github.com/acme/demo/pull/42","state":"OPEN","isDraft":false,"headRefName":"%s","baseRefName":"%s","statusCheckRollup":[]}]' "$title" "$head" "$base" > "${dir}/pr-$head.json"
  echo "https://github.com/acme/demo/pull/42"
  exit 0
fi
if [ "$1" = "api" ] && [ "$4" = "user" ]; then echo '{"login":"jhin-bot"}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  if [ -f "${dir}/required.json" ]; then cat "${dir}/required.json"; exit 8; fi
  echo "no required checks reported on the 'feature' branch" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  number="$(basename "$3")"
  for arg in "$@"; do last="$arg"; done
  if [ "$3" = "--json" ]; then number="$(basename "$last")"; fi
  if [ -f "${dir}/view-$number.json" ]; then cat "${dir}/view-$number.json"; exit 0; fi
  echo "no pull requests found" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$3" = "--head" ]; then
  if [ -f "${dir}/pr-$4.json" ]; then cat "${dir}/pr-$4.json"; else echo "[]"; fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$3" = "--state" ]; then
  if [ -f "${dir}/list.json" ]; then cat "${dir}/list.json"; else echo "[]"; fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
  Fs.writeFileSync(Path.join(dir, "gh"), script, { mode: 0o755 });
  const previous = process.env["PATH"];
  process.env["PATH"] = `${dir}${Path.delimiter}${previous ?? ""}`;
  cleanups.push(() => {
    process.env["PATH"] = previous;
  });
  return {
    dir,
    required: (names) =>
      Fs.writeFileSync(
        Path.join(dir, "required.json"),
        JSON.stringify(names.map((name) => ({ name }))),
      ),
    pullRequest: (branch, value) =>
      Fs.writeFileSync(Path.join(dir, `pr-${branch}.json`), JSON.stringify(value)),
    fail(code, stderr) {
      Fs.writeFileSync(Path.join(dir, "stderr"), stderr);
      Fs.writeFileSync(Path.join(dir, "exit"), String(code));
    },
    recover: () => Fs.rmSync(Path.join(dir, "exit")),
    view: (number, value) =>
      Fs.writeFileSync(Path.join(dir, `view-${number}.json`), JSON.stringify(value)),
    list: (value) => Fs.writeFileSync(Path.join(dir, "list.json"), JSON.stringify(value)),
    failCreate(code, stderr) {
      Fs.writeFileSync(Path.join(dir, "create-stderr"), stderr);
      Fs.writeFileSync(Path.join(dir, "create-exit"), String(code));
    },
    body: (head) =>
      Fs.existsSync(Path.join(dir, `body-${head}.md`))
        ? Fs.readFileSync(Path.join(dir, `body-${head}.md`), "utf8")
        : undefined,
    calls: () =>
      Fs.existsSync(Path.join(dir, "calls"))
        ? Fs.readFileSync(Path.join(dir, "calls"), "utf8").trim().split("\n")
        : [],
  };
}

export interface Node {
  readonly client: RpcClient;
  /** Stops the node, so another can start on its data and storage. */
  stop(): Promise<void>;
  /** A client of the node holding only `permissions` (a narrow device token). */
  as(permissions: string[]): RpcClient;
  /** The fake terminals, when the node has them. */
  readonly terminals?: FakeTerminals;
  /** Every event of the `source-control` stream from now on. */
  readonly events: StoredEvent[];
  /** Resolves with the first event (from now on, or already seen) that `match` accepts. */
  until(match: (event: StoredEvent) => boolean): Promise<StoredEvent>;
  /** Resolves with the first event of `stream` from now on that `match` accepts. */
  next(stream: string, match: (event: StoredEvent) => boolean): Promise<StoredEvent>;
  status(projectId?: string, refresh?: boolean): Promise<StatusSnapshot>;
  project(path: string): Promise<string>;
  /** Sets the node's `jhin.source-control` config while it runs. */
  configure(values: Record<string, unknown>): void;
  /** Resolves when the node next logs `message` (at any level). */
  logged(message: string): Promise<void>;
  /** Resolves once the node has logged `message`, now or since it started. */
  loggedSinceStart(message: string): Promise<void>;
}

/** A logger that tells `listen` every message, at any level and from any child. */
function recordingLogger(listen: (message: string) => void): Logger {
  const log = (message: string) => listen(message);
  const logger: Logger = {
    debug: log,
    info: log,
    warn: log,
    error: log,
    child: () => logger,
  };
  return logger;
}

/** What a fake terminal saw: its open and the lines typed into it. */
interface FakeTerminals {
  readonly opened: OpenTerminalInput[];
  readonly closed: string[];
  /** What was typed into each terminal, by id. */
  readonly typedInto: string[];
  /** Holds every open until the returned function is called; resolves once one waits. */
  holdOpens(): { waiting: Promise<void>; release(): void };
  /** Makes every open fail with `error`. */
  failOpens(error: Error): void;
  /** Resolves once something was typed into `terminalId`. */
  typed(terminalId: string): Promise<void>;
}

/**
 * `terminal.sessions@1` whose terminals run what is typed into them with `sh`
 * (no PTY, no echo) and serve its output as the terminal plugin does: the
 * setup script's wrapper and sentinel go through a real shell.
 */
function fakeTerminals(live: LiveStreams): { sessions: TerminalSessions; seen: FakeTerminals } {
  const streams = createMemoryStreams();
  live.serve(TERMINAL_STREAM_PREFIX, streams);
  const opened: OpenTerminalInput[] = [];
  const closed: string[] = [];
  const typedInto: string[] = [];
  let gate: { reached: () => void; open: Promise<void> } | undefined;
  let failure: Error | undefined;
  const running = new Map<string, ReturnType<typeof spawn>>();
  const typedWaiters = new Map<string, (() => void)[]>();
  const sessions: TerminalSessions = {
    open: async (input) => {
      if (failure !== undefined) throw failure;
      opened.push(input);
      if (gate !== undefined) {
        gate.reached();
        await gate.open;
      }
      return {
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        status: "running",
        pid: null,
        exitCode: null,
        signal: null,
        cols: 80,
        rows: 24,
        hasRunningSubprocess: false,
        label: "",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    write: ({ threadId, terminalId, data }) => {
      const input = opened.findLast((entry) => entry.terminalId === terminalId)!;
      const stream = terminalStream(threadId, terminalId);
      // Its errors go to its output, in order, as a terminal shows them.
      const child = spawn("sh", ["-c", `exec 2>&1\n${data.replaceAll("\r", "\n")}`], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
      });
      running.set(terminalId, child);
      typedInto.push(terminalId);
      const out = (chunk: Buffer) =>
        streams.append(stream, TerminalEvents.output, { data: chunk.toString("utf8") });
      child.stdout.on("data", out);
      for (const resolve of typedWaiters.get(terminalId)?.splice(0) ?? []) resolve();
    },
    resize: () => undefined,
    close: async ({ threadId, terminalId }) => {
      if (terminalId === undefined) return 0;
      closed.push(terminalId);
      running.get(terminalId)?.kill();
      running.delete(terminalId);
      streams.append(terminalStream(threadId, terminalId), TerminalEvents.closed, {});
      return 1;
    },
    list: () => [],
    get: () => undefined,
  };
  cleanups.push(() => {
    for (const child of running.values()) child.kill();
  });
  return {
    sessions,
    seen: {
      opened,
      closed,
      typedInto,
      holdOpens: () => {
        const reached = Promise.withResolvers<void>();
        const open = Promise.withResolvers<void>();
        gate = { reached: reached.resolve, open: open.promise };
        return {
          waiting: reached.promise,
          release: () => {
            gate = undefined;
            open.resolve();
          },
        };
      },
      failOpens: (error) => {
        failure = error;
      },
      typed: (terminalId) =>
        new Promise((resolve) => {
          if (running.has(terminalId)) return resolve();
          const list = typedWaiters.get(terminalId) ?? [];
          list.push(resolve);
          typedWaiters.set(terminalId, list);
        }),
    },
  };
}

export async function node(
  config: Record<string, unknown> = {},
  options: {
    data?: string;
    storage?: ReturnType<typeof memoryStoragePlugin>;
    /** Gives the node fake terminals (`Node.terminals`). */
    terminals?: boolean;
  } = {},
): Promise<Node> {
  const data = options.data ?? temp("jhin-sc-node-");
  const storage = options.storage ?? memoryStoragePlugin();
  const live = createLiveStreams();
  const terminals = options.terminals === true ? fakeTerminals(live) : undefined;
  const logWaiters = new Map<string, (() => void)[]>();
  const loggedMessages = new Set<string>();
  const logger = recordingLogger((message) => {
    loggedMessages.add(message);
    for (const resolve of logWaiters.get(message)?.splice(0) ?? []) resolve();
  });
  const kernel = await createTestKernel({
    logger,
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      storage,
      mockCapability(LIVE_STREAMS_CAPABILITY, live),
      ...(terminals === undefined
        ? []
        : [mockCapability(TERMINAL_SESSIONS_CAPABILITY, terminals.sessions)]),
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: agent },
      { manifest: manifest("source-control"), definition: sourceControl },
    ],
    config: { node: { "jhin.source-control": config } },
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log, streams: live });
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      client.close();
      await kernel.stop();
    })());
  cleanups.push(stop);
  const events: StoredEvent[] = [];
  const waiters = new Set<{
    match: (event: StoredEvent) => boolean;
    resolve(event: StoredEvent): void;
  }>();
  storage.storage.log.subscribe(SOURCE_CONTROL_STREAM, (event) => {
    events.push(event);
    for (const waiter of waiters) {
      if (waiter.match(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  });
  return {
    client,
    stop,
    events,
    as: (permissions) => {
      const narrow = connectInMemory(kernel, {
        log: storage.storage.log,
        streams: live,
        caller: { id: "narrow", permissions },
      }).client;
      cleanups.push(() => narrow.close());
      return narrow;
    },
    ...(terminals === undefined ? {} : { terminals: terminals.seen }),
    /** Resolves with the first event of `stream` from now on that `match` accepts. */
    next: (stream, match) =>
      new Promise((resolve) => {
        const subscription = storage.storage.log.subscribe(stream, (event) => {
          if (!match(event)) return;
          subscription.dispose();
          resolve(event);
        });
      }),
    configure: (values) =>
      kernel.config.setLayer("node", { "jhin.source-control": { ...config, ...values } }),
    logged: (message) =>
      new Promise((resolve) => {
        const list = logWaiters.get(message) ?? [];
        list.push(resolve);
        logWaiters.set(message, list);
      }),
    loggedSinceStart: (message) =>
      loggedMessages.has(message)
        ? Promise.resolve()
        : new Promise((resolve) => {
            const list = logWaiters.get(message) ?? [];
            list.push(resolve);
            logWaiters.set(message, list);
          }),
    until: (match) =>
      new Promise((resolve) => {
        const seen = events.find(match);
        if (seen !== undefined) resolve(seen);
        else waiters.add({ match, resolve });
      }),
    status: (projectId, refresh) =>
      client.call<StatusSnapshot>("git.status", {
        ...(projectId === undefined ? {} : { projectId }),
        ...(refresh === undefined ? {} : { refresh }),
      }),
    project: async (path) => (await client.call<{ id: string }>("projects.create", { path })).id,
  };
}

/** A `status.changed` event of `projectId` whose status `match` accepts. */
export const statusEvent =
  (projectId: string, match: (status: ProjectStatus) => boolean) => (event: StoredEvent) =>
    event.type === "source-control.status.changed" &&
    (event.payload as ProjectStatus).projectId === projectId &&
    match(event.payload as ProjectStatus);

/** A `thread.changed` event of `threadId` whose record `match` accepts. */
export const threadEvent =
  (threadId: string, match: (thread: ThreadBranch) => boolean) => (event: StoredEvent) =>
    event.type === "source-control.thread.changed" &&
    (event.payload as ThreadBranch).threadId === threadId &&
    match(event.payload as ThreadBranch);

/** A pull request as `gh pr list --json` prints it. */
export const ghPullRequest = (fields: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Add the thing",
  url: "https://github.com/acme/demo/pull/7",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature",
  baseRefName: "main",
  updatedAt: "2026-10-19T10:00:00Z",
  statusCheckRollup: [],
  ...fields,
});

/**
 * A fake CLI `name` on PATH: each call is logged to `calls`; `answer(args, value)`
 * makes a call whose arguments start with `args` print `value` as JSON.
 */
export function fakeCli(name: string): {
  answer(args: string, value: unknown): void;
  calls(): string[];
} {
  const dir = temp(`jhin-fake-${name}-`);
  let answers = 0;
  const script = () => {
    const cases = Fs.readdirSync(dir)
      .filter((file) => file.startsWith("answer-"))
      .toSorted()
      .toReversed()
      .map((file) => {
        const args = Fs.readFileSync(Path.join(dir, file, "args"), "utf8");
        return `  "${args.replaceAll('"', '\\\\"')}"*) cat "${Path.join(dir, file, "out")}"; exit 0;;`;
      })
      .join("\n");
    Fs.writeFileSync(
      Path.join(dir, name),
      `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$*" in\n${cases}\nesac\necho "unexpected ${name} call: $*" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
  };
  script();
  const previous = process.env["PATH"];
  process.env["PATH"] = `${dir}${Path.delimiter}${previous ?? ""}`;
  cleanups.push(() => {
    process.env["PATH"] = previous;
  });
  return {
    answer(args, value) {
      const folder = Path.join(dir, `answer-${String(answers++).padStart(4, "0")}`);
      Fs.mkdirSync(folder);
      Fs.writeFileSync(Path.join(folder, "args"), args);
      Fs.writeFileSync(Path.join(folder, "out"), JSON.stringify(value));
      script();
    },
    calls: () =>
      Fs.existsSync(Path.join(dir, "calls"))
        ? Fs.readFileSync(Path.join(dir, "calls"), "utf8").trim().split("\n")
        : [],
  };
}
