import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CODEX_AGENT_ID,
  codexRateLimitsToWindows,
  codexUsageLimitResetAt,
  mergeCodexRateLimits,
} from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type Step } from "./support.ts";

afterEach(stopAll);

// Epoch seconds, as Codex sends them.
const IN_TWO_HOURS = Math.floor(Date.parse("2030-01-01T02:00:00Z") / 1000);
const IN_FIVE_DAYS = Math.floor(Date.parse("2030-01-05T00:00:00Z") / 1000);
const CREDIT_EXPIRES = Math.floor(Date.parse("2030-02-01T00:00:00Z") / 1000);

const plusLimits = {
  rateLimits: {
    limitId: "codex",
    planType: "plus",
    primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: IN_TWO_HOURS },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: IN_FIVE_DAYS },
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      { status: "redeemed", expiresAt: 1 },
      { status: "available", expiresAt: CREDIT_EXPIRES },
    ],
  },
};

describe("jhin.agent-codex: usage limits (D1142)", () => {
  it("reads the account's windows and reset credits and offers /usage-limits", async () => {
    const fake = fakeCodex({ rateLimits: plusLimits });
    const { client } = await node(fake);
    const { usageLimits } = await client.call<{ usageLimits: Record<string, unknown> }>(
      "agents.usage-limits",
      { agentId: CODEX_AGENT_ID },
    );
    expect(usageLimits).toEqual({
      checkedAt: expect.any(String),
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 42.4,
          windowDurationMins: 300,
          resetsAt: "2030-01-01T02:00:00.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          windowDurationMins: 10080,
          resetsAt: "2030-01-05T00:00:00.000Z",
        },
      ],
      resetCredits: { availableCount: 2, nextExpiresAt: "2030-02-01T00:00:00.000Z" },
    });
    expect(fake.received("account/rateLimits/read")).toHaveLength(1);

    const agents = await client.call<{ agentId: string; usageLimits: boolean }[]>(
      "agents.list",
      {},
    );
    expect(agents.find((agent) => agent.agentId === CODEX_AGENT_ID)?.usageLimits).toBe(true);
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-codex-usage-"));
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const offered = await client.call<{ commands: { name: string }[] }>("agents.commands", {
      projectId: project.id,
      agentId: CODEX_AGENT_ID,
    });
    // T3's server lists it first for a provider with limits; the client answers it.
    expect(offered.commands.map((command) => command.name)).toEqual(["usage-limits", "compact"]);
  });

  it("has none to show for an API key, and says when Codex could not read them", async () => {
    const apiKey = await node(
      fakeCodex({ account: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }),
    );
    expect(
      await apiKey.client.call("agents.usage-limits", { agentId: CODEX_AGENT_ID }),
    ).toMatchObject({
      usageLimits: { windows: [], unavailable: { reason: "unsupported" } },
    });
    // The fake knows no account/rateLimits/read without a scenario for it.
    const unread = await node(fakeCodex({}));
    expect(
      await unread.client.call("agents.usage-limits", { agentId: CODEX_AGENT_ID }),
    ).toMatchObject({
      usageLimits: {
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Codex could not read usage (JSON-RPC -32601).",
        },
      },
    });
    const signedOut = await node(
      fakeCodex({ account: { account: null, requiresOpenaiAuth: true } }),
    );
    expect(await signedOut.client.call("agents.usage-limits", { agentId: CODEX_AGENT_ID })).toEqual(
      { usageLimits: null },
    );
  });

  it("fails a turn on a usage limit with when it resets, and shows Codex's update", async () => {
    const reached: Step = {
      notify: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: IN_TWO_HOURS },
        },
      },
    };
    const fake = fakeCodex({
      rateLimits: plusLimits,
      turns: [
        [
          reached,
          {
            notify: "error",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              willRetry: false,
              error: {
                message: "You've hit your usage limit.",
                codexErrorInfo: "usageLimitExceeded",
              },
            },
          },
          { complete: "failed" },
        ],
      ],
    });
    const { client } = await node(fake);
    // The probe first, so the update merges onto its windows.
    await client.call("agents.usage-limits", { agentId: CODEX_AGENT_ID });
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    expect(payloads(await failed, "agent.turn.failed")[0]).toMatchObject({
      error: expect.stringContaining("You've hit your usage limit."),
      failure: { class: "usage_limit", resetAt: "2030-01-01T02:00:00.000Z" },
    });
    const { usageLimits } = await client.call<{
      usageLimits: { windows: { id: string; usedPercent: number }[] };
    }>("agents.usage-limits", { agentId: CODEX_AGENT_ID });
    // The update named only the session window: the weekly one stays as read.
    expect(usageLimits.windows.map(({ id, usedPercent }) => ({ id, usedPercent }))).toEqual([
      { id: "primary", usedPercent: 100 },
      { id: "secondary", usedPercent: 10 },
    ]);
  });

  it("follows T3's window rules", () => {
    // Free and Go plans have one monthly allowance when Codex names no duration.
    expect(codexRateLimitsToWindows({ planType: "free", primary: { usedPercent: 5 } })).toEqual([
      {
        id: "primary",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 5,
        windowDurationMins: 43200,
      },
    ]);
    // A model's own allowance (Spark) neither shows nor replaces the main one.
    const main = { limitId: "codex", primary: { usedPercent: 20 } };
    expect(
      codexRateLimitsToWindows({ limitId: "codex_spark", primary: { usedPercent: 99 } }),
    ).toEqual([]);
    expect(
      mergeCodexRateLimits(main, { limitId: "codex_spark", primary: { usedPercent: 99 } }),
    ).toBe(main);
    // Every exhausted window must reset; one without a reset time gives none.
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: IN_TWO_HOURS },
        secondary: { usedPercent: 100, resetsAt: IN_FIVE_DAYS },
      }),
    ).toBe("2030-01-05T00:00:00.000Z");
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: IN_TWO_HOURS },
        secondary: { usedPercent: 100 },
      }),
    ).toBeUndefined();
  });
});
