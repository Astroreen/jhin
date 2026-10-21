import { execFileSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { LIVE_STREAMS_CAPABILITY, createLiveStreams, type RpcClient } from "@jhin/rpc";
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
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  number="$(basename "$3")"
  if [ -f "${dir}/view-$number.json" ]; then cat "${dir}/view-$number.json"; exit 0; fi
  echo "no pull requests found" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$3" = "--head" ]; then
  if [ -f "${dir}/pr-$4.json" ]; then cat "${dir}/pr-$4.json"; else echo "[]"; fi
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
    pullRequest: (branch, value) =>
      Fs.writeFileSync(Path.join(dir, `pr-${branch}.json`), JSON.stringify(value)),
    fail(code, stderr) {
      Fs.writeFileSync(Path.join(dir, "stderr"), stderr);
      Fs.writeFileSync(Path.join(dir, "exit"), String(code));
    },
    recover: () => Fs.rmSync(Path.join(dir, "exit")),
    view: (number, value) =>
      Fs.writeFileSync(Path.join(dir, `view-${number}.json`), JSON.stringify(value)),
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

export async function node(
  config: Record<string, unknown> = {},
  options: { data?: string } = {},
): Promise<Node> {
  const data = options.data ?? temp("jhin-sc-node-");
  const storage = memoryStoragePlugin();
  const live = createLiveStreams();
  const logWaiters = new Map<string, (() => void)[]>();
  const logger = recordingLogger((message) => {
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
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: agent },
      { manifest: manifest("source-control"), definition: sourceControl },
    ],
    config: { node: { "jhin.source-control": config } },
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log, streams: live });
  cleanups.push(async () => {
    client.close();
    await kernel.stop();
  });
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
    events,
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
