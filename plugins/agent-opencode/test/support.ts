import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { AgentItem, AgentTurn, TurnRequest } from "@jhin/agent-api";

import { Config, createOpenCodeRuntime } from "../src/index.ts";
import type { Clock } from "../src/client.ts";
import { createServerOwner } from "../src/server.ts";
import type { SessionRecord, SessionStore } from "../src/turn.ts";
import { fakeOpenCode, type FakeOpenCode } from "./fake-server.ts";

export const PASSWORD = "secret";

export function memorySessions(initial: Record<string, string> = {}) {
  const records = new Map<string, SessionRecord>(
    Object.entries(initial).map(([threadId, id]) => [threadId, { id }]),
  );
  const store: SessionStore = {
    get: async (threadId) => records.get(threadId),
    set: async (threadId, record) => void records.set(threadId, record),
    delete: async (threadId) => void records.delete(threadId),
  };
  return { records, store };
}

/** A runtime on a fake OpenCode server it reaches as a configured server (`serverUrl`). */
export async function connected(
  options: Parameters<typeof fakeOpenCode>[0] = {},
  sessionIds: Record<string, string> = {},
  clock?: Clock,
) {
  const fake = await fakeOpenCode({ password: PASSWORD, ...options });
  const sessions = memorySessions(sessionIds);
  const attachmentsDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-opencode-test-"));
  const config = Config.parse({ enabled: true, serverUrl: fake.url, serverPassword: PASSWORD });
  const server = createServerOwner({
    settings: () => config,
    env: () => process.env,
    idleMs: () => 0,
    ...(clock === undefined ? {} : { clock }),
  });
  const runtime = createOpenCodeRuntime({
    server,
    sessions: sessions.store,
    config: () => config,
    attachmentsDir,
    ...(clock === undefined ? {} : { clock }),
  });
  return { fake, runtime, sessions, attachmentsDir, cleanup: () => stop(runtime, fake) };
}

async function stop(runtime: { dispose(): void }, fake: FakeOpenCode) {
  runtime.dispose();
  await fake.close();
}

export const THREAD = "0b6c5e5e-0000-4000-8000-000000000001";

/**
 * A turn of the thread. Unless a history is given, `turn-<n>` comes after `turn-1` …
 * `turn-<n-1>` of OpenCode, as the threads plugin would hand it.
 */
export function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  const turnId = overrides.turnId ?? "turn-1";
  const number = /^turn-(\d+)$/.exec(turnId)?.[1];
  const earlier =
    number === undefined
      ? []
      : Array.from({ length: Number(number) - 1 }, (_, index) => ({
          type: "agent.turn.started",
          payload: {
            turnId: `turn-${index + 1}`,
            agentId: "jhin.agent-opencode",
            input: { text: "earlier" },
          },
        }));
  return {
    threadId: THREAD,
    turnId,
    input: { text: "hello" },
    history: earlier as unknown as TurnRequest["history"],
    cwd: "/work",
    model: "anthropic/claude-sonnet-5-5",
    ...overrides,
  };
}

/** Every item of a turn, answering requests with `answer` as they open. */
export async function drain(
  turn: AgentTurn,
  answer?: (
    item: Extract<AgentItem, { kind: "request.opened" }>,
  ) => Parameters<NonNullable<AgentTurn["respond"]>>[1],
): Promise<AgentItem[]> {
  const items: AgentItem[] = [];
  for await (const item of turn.items) {
    items.push(item);
    if (item.kind === "request.opened" && answer !== undefined) {
      turn.respond!(item.requestId, answer(item));
    }
  }
  return items;
}

/** Drains a turn that should fail and resolves with its error. */
export async function failure(turn: AgentTurn): Promise<Error> {
  try {
    await drain(turn);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the turn did not fail");
}

/** A clock whose timers run only when the test fires them. */
export function manualClock() {
  const timers = new Set<{ ms: number; run: () => void }>();
  const armedWaiters: { ms: number; resolve: () => void }[] = [];
  const clock: Clock = {
    after(ms, run) {
      const timer = { ms, run };
      timers.add(timer);
      for (const waiter of armedWaiters.filter((entry) => entry.ms === ms)) {
        armedWaiters.splice(armedWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      return () => timers.delete(timer);
    },
  };
  return {
    clock,
    /** Resolves once a timer of `ms` is pending. */
    armed(ms: number) {
      if ([...timers].some((timer) => timer.ms === ms)) return Promise.resolve();
      return new Promise<void>((resolve) => armedWaiters.push({ ms, resolve }));
    },
    /** Runs every pending timer of `ms`. */
    fire(ms: number) {
      for (const timer of [...timers].filter((entry) => entry.ms === ms)) {
        timers.delete(timer);
        timer.run();
      }
    },
  };
}
