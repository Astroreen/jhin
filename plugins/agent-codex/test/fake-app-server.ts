// A stand-in for `codex app-server` (D324): it speaks the app-server's JSON-RPC over stdio and
// plays the steps a test's scenario file names for each `turn/start`. Every message it gets
// (and every answer to its own requests) goes to the log file before it acts on it, so a
// test reads what Jhin sent once the turn's events are recorded.
//
//   node fake-app-server.ts app-server [args…]
//   FAKE_CODEX_SCENARIO: the scenario (JSON, see `Scenario`)
//   FAKE_CODEX_LOG: the log (one JSON object per line), shared by every process of a test
import * as Fs from "node:fs";
import * as Readline from "node:readline";

/** One thing the fake does during a turn; `$thread` and `$turn` in params name the ids. */
export type Step =
  | { readonly notify: string; readonly params?: unknown }
  /** Sends a server request and waits for Jhin's answer (logged as `answer`). */
  | { readonly request: string; readonly params?: unknown }
  /** Waits until `count` (default 1) requests or notifications of `method` came. */
  | { readonly waitFor: string; readonly count?: number }
  /** Waits until `turn/interrupt` comes. */
  | { readonly waitForInterrupt: true }
  /** Answers `turn/start` here instead of before the first step. */
  | { readonly reply: true }
  /** Ends the turn with `turn/completed`. */
  | { readonly complete: "completed" | "failed" | "interrupted"; readonly error?: unknown }
  /** Exits the process. */
  | { readonly exit: number }
  /** Stops playing: the turn never ends. */
  | { readonly hang: true };

export interface Scenario {
  /** `account/read`'s answer; a ChatGPT account when absent. */
  readonly account?: unknown;
  /** How a sign-in ends right after `account/login/start`; it never ends when absent. */
  readonly login?: { readonly success: boolean; readonly error?: string };
  /** `account/rateLimits/read`'s answer; the method is unknown when absent. */
  readonly rateLimits?: unknown;
  /** `skills/list`'s entries, one per folder. */
  readonly skills?: readonly unknown[];
  /** Pages of `model/list`. */
  readonly models?: readonly unknown[][];
  /** Errors for the nth call of a method (null: answered normally). */
  readonly errors?: Readonly<
    Record<string, readonly ({ code?: number; message: string } | null)[]>
  >;
  /** Steps of each `turn/start`, counted over every process of the test. */
  readonly turns?: readonly (readonly Step[])[];
  /** Methods the fake never answers. */
  readonly hangOn?: readonly string[];
  /** `initialize` never answers. */
  readonly hangOnInitialize?: boolean;
  /** SIGTERM does not end the process, as a Codex stuck in a tool would not. */
  readonly ignoreSigterm?: boolean;
}

const scenario = JSON.parse(
  Fs.readFileSync(process.env["FAKE_CODEX_SCENARIO"]!, "utf8"),
) as Scenario;
const logPath = process.env["FAKE_CODEX_LOG"]!;

const log = (entry: Record<string, unknown>) =>
  Fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const logged = (): Record<string, unknown>[] =>
  Fs.existsSync(logPath)
    ? Fs.readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
/** How often `method` came before, over every process. */
const calls = (method: string) =>
  logged().filter(
    (entry) => entry["in"] !== undefined && (entry["in"] as { method?: unknown }).method === method,
  ).length;

if (scenario.ignoreSigterm) {
  process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));
  // Stays up after stdin closes too, as a Codex busy in a tool would.
  setInterval(() => {}, 2 ** 30);
}

log({
  started: process.argv.slice(2),
  cwd: process.cwd(),
  home: process.env["CODEX_HOME"] ?? null,
  sawSecret: process.env["JHIN_NODE_SECRET"] !== undefined,
  sawBearer: Object.values(process.env).some((value) => value?.includes("Bearer ") === true),
});

const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);

let nextId = 1;
/** The thread's goal (`thread/goal/*`). */
let goal: Record<string, unknown> | null = null;
const waiting = new Map<number, (value: unknown) => void>();
let interrupted: (() => void) | undefined;
let interruptCame = false;
/** Steps waiting for a method to come, by method. */
const waiters = new Map<string, () => void>();

const substitute = (value: unknown, ids: { thread: string; turn: string }): unknown => {
  if (value === "$thread") return ids.thread;
  if (value === "$turn") return ids.turn;
  if (Array.isArray(value)) return value.map((item) => substitute(item, ids));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, ids)]),
    );
  }
  return value;
};

async function play(
  steps: readonly Step[],
  ids: { thread: string; turn: string },
  reply: () => void,
) {
  let replied = false;
  if (!steps.some((step) => "reply" in step)) {
    reply();
    replied = true;
  }
  for (const step of steps) {
    if ("reply" in step) {
      reply();
      replied = true;
    } else if ("notify" in step) {
      send({ method: step.notify, params: substitute(step.params ?? {}, ids) });
    } else if ("request" in step) {
      const id = nextId++;
      const answered = new Promise((resolve) => waiting.set(id, resolve));
      send({ id, method: step.request, params: substitute(step.params ?? {}, ids) });
      await answered;
    } else if ("waitFor" in step) {
      while (calls(step.waitFor) < (step.count ?? 1)) {
        await new Promise<void>((resolve) => waiters.set(step.waitFor, resolve));
      }
    } else if ("waitForInterrupt" in step) {
      if (!interruptCame) await new Promise<void>((resolve) => (interrupted = resolve));
    } else if ("complete" in step) {
      send({
        method: "turn/completed",
        params: {
          threadId: ids.thread,
          turn: {
            id: ids.turn,
            status: step.complete,
            items: [],
            ...(step.error === undefined ? {} : { error: step.error }),
          },
        },
      });
    } else if ("exit" in step) {
      process.exit(step.exit);
    } else if ("hang" in step) {
      return;
    }
  }
  if (!replied) reply();
}

const error = (method: string): { code?: number; message: string } | null | undefined =>
  scenario.errors?.[method]?.[calls(method) - 1];

Readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };
  if (message.method === undefined) {
    log({ answer: message });
    waiting.get(message.id!)?.(message.result ?? message.error);
    waiting.delete(message.id!);
    return;
  }
  log({ in: message });
  waiters.get(message.method)?.();
  waiters.delete(message.method);
  const { id, method } = message;
  const params = message.params ?? {};
  if (id === undefined) return;
  if (scenario.hangOn?.includes(method)) return;
  const failure = error(method);
  if (failure) {
    send({ id, error: { code: failure.code ?? -32600, message: failure.message } });
    return;
  }
  switch (method) {
    case "initialize":
      if (scenario.hangOnInitialize) return;
      send({ id, result: { userAgent: "codex_cli_rs/0.200.0 (fake)", codexHome: "/fake/home" } });
      return;
    case "account/read":
      send({
        id,
        result: scenario.account ?? {
          account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
          requiresOpenaiAuth: true,
        },
      });
      return;
    case "account/login/start": {
      const loginId = `login-${calls("account/login/start")}`;
      send({
        id,
        result:
          params["type"] === "chatgptDeviceCode"
            ? {
                type: "chatgptDeviceCode",
                loginId,
                userCode: "ABCD-1234",
                verificationUrl: "https://auth.openai.com/codex/device",
              }
            : { type: "chatgpt", loginId, authUrl: `https://auth.openai.com/oauth/${loginId}` },
      });
      if (scenario.login !== undefined) {
        send({ method: "account/login/completed", params: { loginId, ...scenario.login } });
      }
      return;
    }
    case "account/logout":
      send({ id, result: {} });
      return;
    case "account/rateLimits/read":
      if (scenario.rateLimits === undefined) break;
      send({ id, result: scenario.rateLimits });
      return;
    case "skills/list":
      send({ id, result: { data: scenario.skills ?? [] } });
      return;
    case "model/list": {
      const pages = scenario.models ?? [[]];
      const index = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
      send({
        id,
        result: {
          data: pages[index] ?? [],
          nextCursor: index + 1 < pages.length ? String(index + 1) : null,
        },
      });
      return;
    }
    case "thread/start":
      send({ id, result: { thread: { id: `codex-thread-${calls("thread/start")}` } } });
      return;
    case "thread/resume":
      send({ id, result: { thread: { id: params["threadId"], updatedAt: 0 } } });
      return;
    // The thread's goal, kept by this process as Codex keeps it.
    case "thread/goal/get":
      send({ id, result: { goal } });
      return;
    case "thread/goal/set":
      goal = {
        ...(goal ?? { tokensUsed: 0, timeUsedSeconds: 0 }),
        threadId: params["threadId"],
        ...(typeof params["objective"] === "string" ? { objective: params["objective"] } : {}),
        ...(typeof params["status"] === "string" ? { status: params["status"] } : {}),
      };
      send({ id, result: { goal } });
      return;
    case "thread/goal/clear":
      send({ id, result: { cleared: goal !== null } });
      goal = null;
      return;
    case "thread/fork":
      send({ id, result: { thread: { id: `codex-fork-${calls("thread/fork")}` } } });
      return;
    case "thread/revert":
      send({ id, result: { thread: { id: params["threadId"] } } });
      return;
    case "thread/unarchive":
      send({ id, result: {} });
      return;
    case "turn/steer":
      send({ id, result: { turnId: params["expectedTurnId"] } });
      return;
    case "turn/interrupt":
      interruptCame = true;
      send({ id, result: {} });
      interrupted?.();
      return;
    case "thread/compact/start": {
      // A compaction is a turn of Codex's own: its steps come from `turns` too, and name it
      // in a `turn/started` the scenario sends.
      const index = calls("turn/start") + calls("thread/compact/start") - 1;
      const ids = { thread: String(params["threadId"]), turn: `turn-${index + 1}` };
      interruptCame = false;
      interrupted = undefined;
      const steps = scenario.turns?.[index] ?? [{ complete: "completed" }];
      void play(steps, ids, () => send({ id, result: {} }));
      return;
    }
    case "turn/start": {
      const index = calls("turn/start") + calls("thread/compact/start") - 1;
      const ids = { thread: String(params["threadId"]), turn: `turn-${index + 1}` };
      interruptCame = false;
      interrupted = undefined;
      const steps = scenario.turns?.[index] ?? [{ complete: "completed" }];
      void play(steps, ids, () =>
        send({ id, result: { turn: { id: ids.turn, status: "inProgress", items: [] } } }),
      );
      return;
    }
    default:
      break;
  }
  send({ id, error: { code: -32601, message: `fake: no ${method}` } });
});
