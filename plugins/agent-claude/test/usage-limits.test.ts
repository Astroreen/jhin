import { UsageLimitError, turnFailureOf, type TurnRequest } from "@jhin/agent-api";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { Config, createClaudeRuntime, type QueryFunction } from "../src/index.ts";
import { claudeTurn } from "../src/turn.ts";
import { claudeUsageResponseToLimits } from "../src/usage-limits.ts";
import { drain, init, memorySessions, result, scriptedQuery, type Script } from "./support.ts";

const THREAD = "0b6c5e5e-0000-4000-8000-000000000001";
// Epoch seconds, as Claude Code sends them in a rate-limit event.
const IN_TWO_HOURS = Math.floor(Date.parse("2030-01-01T02:00:00Z") / 1000);
const IN_FIVE_DAYS = Math.floor(Date.parse("2030-01-05T00:00:00Z") / 1000);

const request: TurnRequest = {
  threadId: THREAD,
  turnId: "turn-1",
  input: { text: "hello" },
  history: [],
  cwd: "/work",
};

const rateLimitEvent = (info: Record<string, unknown>) =>
  ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" }) as SDKMessage;

const maxPlan = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42.4, resets_at: "2030-01-01T02:00:00Z" },
    seven_day: { utilization: 10, resets_at: "2030-01-05T00:00:00Z" },
    model_scoped: [{ display_name: "Opus", utilization: 70, resets_at: null }],
  },
};

describe("jhin.agent-claude: usage limits (D1301)", () => {
  it("reads the session, weekly and model-scoped windows as T3 Code does", () => {
    const { limits, names } = claudeUsageResponseToLimits(maxPlan, "2030-01-01T00:00:00.000Z");
    expect(limits).toEqual({
      checkedAt: "2030-01-01T00:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 42.4,
          windowDurationMins: 300,
          resetsAt: "2030-01-01T02:00:00.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          windowDurationMins: 10_080,
          resetsAt: "2030-01-05T00:00:00.000Z",
        },
        {
          id: "seven_day_opus",
          kind: "weekly",
          label: "Weekly · Opus",
          usedPercent: 70,
          windowDurationMins: 10_080,
        },
      ],
    });
    expect(names).toEqual({ overageIncluded: "Opus" });
  });

  it("has none for an API key", () => {
    expect(
      claudeUsageResponseToLimits({ rate_limits_available: false, rate_limits: null }, "now")
        .limits,
    ).toEqual({ checkedAt: "now", windows: [], unavailable: { reason: "unsupported" } });
  });
});

describe("jhin.agent-claude: the runtime's usage limits (D1301, D1302, D1304)", () => {
  /** A query that initializes as a signed-in Claude Code and answers the usage read. */
  const probing = (usage: () => Promise<unknown>, account = { email: "ada@example.com" }) => {
    let reads = 0;
    const query = (() => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => undefined,
      close: () => undefined,
      initializationResult: async () => ({ account, models: [] }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts: unknown) => {
        reads++;
        expect(opts).toEqual({ skipBehaviors: true });
        return usage();
      },
    })) as unknown as QueryFunction;
    return { query, reads: () => reads };
  };
  const runtime = (query: QueryFunction) =>
    createClaudeRuntime({ query, sessions: memorySessions(), config: () => Config.parse({}) });

  it("reads them with the status probe and answers from it within a minute", async () => {
    const probe = probing(async () => maxPlan);
    const claude = runtime(probe.query);
    const limits = await claude.usageLimits!();
    expect(limits?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 42.4],
      ["seven_day", 10],
      ["seven_day_opus", 70],
    ]);
    await claude.usageLimits!();
    expect(probe.reads()).toBe(1);
  });

  it("says a failed read failed, and reads again on the next look", async () => {
    const probe = probing(async () => {
      throw new Error("Unsupported control request");
    });
    const claude = runtime(probe.query);
    expect(await claude.usageLimits!()).toEqual({
      checkedAt: expect.any(String),
      windows: [],
      unavailable: { reason: "probeFailed", message: "Unsupported control request" },
    });
    await claude.usageLimits!();
    expect(probe.reads()).toBe(2);
  });

  it("cannot tell for a Claude Code that is signed out", async () => {
    const probe = probing(async () => maxPlan, { tokenSource: "none" } as never);
    const claude = runtime(probe.query);
    expect(await claude.usageLimits!()).toBeUndefined();
    expect(probe.reads()).toBe(0);
  });

  it("merges a turn's rate-limit events onto the read, by window", async () => {
    const usage = probing(async () => maxPlan);
    const turns = scriptedQuery(async function* () {
      yield init();
      yield rateLimitEvent({
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.91,
        resetsAt: IN_TWO_HOURS,
      });
      // Named by type: it lands on the read's "Weekly · Opus" row.
      yield rateLimitEvent({
        status: "allowed",
        rateLimitType: "seven_day_overage_included",
        utilization: 0.8,
      });
      yield result();
    });
    let calls = 0;
    const query: QueryFunction = (input) =>
      calls++ === 0 ? usage.query(input) : turns.query(input);
    const claude = runtime(query);
    await claude.usageLimits!();
    await drain(claude.startTurn(request));
    const limits = await claude.usageLimits!();
    expect(limits?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 91],
      ["seven_day", 10],
      ["seven_day_opus", 80],
    ]);
    expect(limits?.windows[0]?.resetsAt).toBe("2030-01-01T02:00:00.000Z");
    expect(usage.reads()).toBe(1);
  });
});

describe("jhin.agent-claude: a turn stopped by a usage limit (D1303)", () => {
  const run = (script: Script) => {
    const { query } = scriptedQuery(script);
    return drain(
      claudeTurn(request, {
        query,
        sessions: memorySessions(),
        settings: {},
        defaultModel: "claude-fable-5-1",
      }),
    );
  };
  const failure = async (items: Promise<unknown>) => {
    const error = await items.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(UsageLimitError);
    return { message: (error as Error).message, failure: turnFailureOf(error) };
  };

  it("fails as a usage limit with the latest reset of every rejected window", async () => {
    expect(
      await failure(
        run(async function* () {
          yield init();
          yield rateLimitEvent({
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: IN_TWO_HOURS,
          });
          yield rateLimitEvent({
            status: "rejected",
            rateLimitType: "seven_day",
            resetsAt: IN_FIVE_DAYS,
          });
          yield result({ is_error: true, terminal_reason: "blocking_limit", result: "" });
        }),
      ),
    ).toEqual({
      message: "Claude usage limit reached. Send the message again once the limit resets.",
      failure: { class: "usage_limit", resetAt: "2030-01-05T00:00:00.000Z" },
    });
  });

  it("knows no reset when a rejected window names none, and none once overage covers it", async () => {
    expect(
      (
        await failure(
          run(async function* () {
            yield init();
            yield rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" });
            yield {
              type: "assistant",
              parent_tool_use_id: null,
              error: "rate_limit",
              message: { id: "m1", content: [] },
            } as unknown as SDKMessage;
            yield result({ is_error: true, terminal_reason: "api_error", result: "" });
          }),
        )
      ).failure,
    ).toEqual({ class: "usage_limit" });
    // Rejected, but overage pays for the turn: a context window that is full stays one.
    await expect(
      run(async function* () {
        yield init();
        yield rateLimitEvent({
          status: "rejected",
          rateLimitType: "five_hour",
          overageStatus: "allowed",
        });
        yield result({ is_error: true, terminal_reason: "blocking_limit", result: "" });
      }),
    ).rejects.toThrow("Claude stopped: the prompt exceeds the model's context window.");
  });

  it("takes Claude's 429 and a gateway's wrapped 429 for usage limits", async () => {
    expect(
      await failure(
        run(async function* () {
          yield init();
          yield result({ is_error: true, api_error_status: 429, result: "" });
        }),
      ),
    ).toEqual({
      message: "Claude API rate limit reached. Try again later.",
      failure: { class: "usage_limit" },
    });
    const gateway = await failure(
      run(async function* () {
        yield init();
        yield result({
          is_error: true,
          api_error_status: 503,
          terminal_reason: "api_error",
          result:
            'API Error: 503 [proxy] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"x"}} (reset after 1h 30m)',
        });
      }),
    );
    expect(gateway.message).toBe("Claude API rate limit reached. Try again later.");
    const resetAt = Date.parse(gateway.failure!.resetAt!);
    expect(resetAt - Date.now()).toBeGreaterThan(89 * 60_000);
    expect(resetAt - Date.now()).toBeLessThanOrEqual(90 * 60_000);
  });
});
