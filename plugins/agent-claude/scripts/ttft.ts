// Time to the first token of a thread's second turn on the real Claude Code, with
// `session: "keep-alive"` against `"per-turn"` (docs/plans/providers.md, D98). It drives the
// plugin's runtime with the SDK's own `query`, so it needs a signed-in Claude Code and spends
// a few cents: two short turns per thread on the given model.
//
//   node plugins/agent-claude/scripts/ttft.ts [threads per mode = 10] [model = claude-haiku-5-5]
import { randomUUID } from "node:crypto";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { Config, createClaudeRuntime, type QueryFunction } from "../src/index.ts";

const runs = Number(process.argv[2] ?? 10);
const model = process.argv[3] ?? "claude-haiku-5-5";

/** When the current turn's `system/init` and first `message_start` came, from its start. */
let turnStart = 0;
const marks: { init?: number; messageStart?: number } = {};
let opened = 0;
const query: QueryFunction = (params) => {
  opened++;
  const running = (sdkQuery as unknown as QueryFunction)(params);
  const iterate = running[Symbol.asyncIterator].bind(running);
  return Object.assign(running, {
    [Symbol.asyncIterator]: () => {
      const inner = iterate();
      return {
        next: async () => {
          const next = await inner.next();
          if (next.done !== true) {
            const message = next.value;
            const at = performance.now() - turnStart;
            if (message.type === "system" && message.subtype === "init") marks.init ??= at;
            if (message.type === "stream_event" && message.event.type === "message_start") {
              marks.messageStart ??= at;
            }
          }
          return next;
        },
      };
    },
  });
};

const recorded = new Set<string>();
const sessions = {
  has: async (threadId: string) => recorded.has(threadId),
  set: async (threadId: string) => void recorded.add(threadId),
  delete: async (threadId: string) => void recorded.delete(threadId),
};

type Claude = ReturnType<typeof createClaudeRuntime>;

async function turn(claude: Claude, threadId: string, turnId: string, text: string) {
  turnStart = performance.now();
  delete marks.init;
  delete marks.messageStart;
  let firstText: number | undefined;
  const running = claude.startTurn({
    threadId,
    turnId,
    input: { text },
    history: [],
    cwd: process.cwd(),
    model,
    runtimeMode: "approval-required",
  });
  for await (const item of running.items) {
    if (firstText === undefined && item.kind === "message.delta") {
      firstText = performance.now() - turnStart;
    }
  }
  return { firstText: firstText ?? Number.NaN, ...marks };
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const summary = (values: readonly number[]) =>
  `median ${Math.round(median(values))} (${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))})`;

for (const session of ["per-turn", "keep-alive"] as const) {
  const claude = createClaudeRuntime({
    query,
    sessions,
    config: () => Config.parse({ session }),
  });
  const before = opened;
  const second: { init: number[]; messageStart: number[]; firstText: number[] } = {
    init: [],
    messageStart: [],
    firstText: [],
  };
  for (let run = 0; run < runs; run++) {
    const threadId = randomUUID();
    await turn(claude, threadId, "t1", "Reply with just the word: one");
    const measured = await turn(claude, threadId, "t2", "Reply with just the word: two");
    second.init.push(measured.init ?? Number.NaN);
    second.messageStart.push(measured.messageStart ?? Number.NaN);
    second.firstText.push(measured.firstText);
    console.error(
      `${session} ${run}: init ${Math.round(measured.init ?? Number.NaN)} ms, message_start ${Math.round(measured.messageStart ?? Number.NaN)} ms, first text ${Math.round(measured.firstText)} ms`,
    );
  }
  claude.dispose();
  console.log(
    `${session.padEnd(10)} turn 2, ms: init ${summary(second.init)} | message_start ${summary(second.messageStart)} | first text ${summary(second.firstText)} | Claude Code started ${opened - before} times for ${runs} threads`,
  );
}
process.exit(0);
