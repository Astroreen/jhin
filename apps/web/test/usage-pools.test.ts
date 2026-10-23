import type { AgentUsageWindow } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitPools, limitNotices, type LimitAccount } from "../src/lib/usage-pools.ts";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const HOUR = 3_600_000;

const window = (
  id: string,
  kind: AgentUsageWindow["kind"],
  usedPercent: number,
  resetsInHours?: number,
): AgentUsageWindow => ({
  id,
  kind,
  label: kind === "session" ? "Session" : "Weekly",
  usedPercent,
  windowDurationMins: kind === "session" ? 300 : 10_080,
  ...(resetsInHours === undefined
    ? {}
    : { resetsAt: new Date(NOW + resetsInHours * HOUR).toISOString() }),
});

const account = (
  nodeLabel: string,
  agentId: string,
  windows: AgentUsageWindow[],
  unavailable?: LimitAccount["limits"]["unavailable"],
): LimitAccount => ({
  key: `${nodeLabel}|${agentId}`,
  agentId,
  agentName: agentId === "jhin.agent-codex" ? "Codex" : "Claude Code",
  nodeLabel,
  limits: { checkedAt: "now", windows, ...(unavailable === undefined ? {} : { unavailable }) },
});

describe("the Usage page's pools (D1309)", () => {
  it("pools an agent's accounts per window, ordered by their next reset", () => {
    const pools = collectLimitPools(
      [
        account("laptop", "jhin.agent-claude", [
          window("five_hour", "session", 80, 4),
          window("seven_day", "weekly", 20, 100),
        ]),
        account("server", "jhin.agent-claude", [window("five_hour", "session", 40, 1)]),
        account("laptop", "jhin.agent-codex", [window("secondary", "weekly", 10, 50)]),
      ],
      NOW,
    );
    expect(pools.map((pool) => [pool.agentName, pool.accounts.map((a) => a.nodeLabel)])).toEqual([
      ["Claude Code", ["server", "laptop"]],
      ["Codex", ["laptop"]],
    ]);
    const [session, weekly] = pools[0]!.windows;
    // The pool's figure is the mean of its members: (80 + 40) / 2 used.
    expect(session).toMatchObject({ label: "Session", usedPercent: 60, remainingPercent: 40 });
    expect(session!.columns.map((column) => column.window?.usedPercent ?? null)).toEqual([40, 80]);
    // A window only one account has leaves the other's column empty.
    expect(weekly!.columns.map((column) => column.window?.usedPercent ?? null)).toEqual([null, 20]);
    // Codex's ids are slots: its windows pool by kind.
    expect(pools[1]!.windows[0]!.id).toBe("weekly");
  });

  it("judges the pace over the members with a clock", () => {
    // 1 h into a 5 h window (20 % elapsed) with 80 % spent: ahead.
    const [pool] = collectLimitPools(
      [account("laptop", "jhin.agent-claude", [window("five_hour", "session", 80, 4)])],
      NOW,
    );
    expect(pool!.windows[0]!.pace).toBe("ahead");
    const [unclocked] = collectLimitPools(
      [account("laptop", "jhin.agent-claude", [window("five_hour", "session", 80)])],
      NOW,
    );
    expect(unclocked!.windows[0]!.pace).toBeNull();
  });

  it("names what could not be shown, and leaves an account without limits out", () => {
    const accounts = [
      account("laptop", "jhin.agent-claude", [], { reason: "probeFailed", message: "Timed out" }),
      account("server", "jhin.agent-codex", [], { reason: "unsupported" }),
      account("server", "jhin.agent-claude", []),
    ];
    expect(collectLimitPools(accounts, NOW)).toEqual([]);
    expect(limitNotices(accounts, true)).toEqual([
      "laptop · Claude Code: Timed out",
      "server · Claude Code: No limits reported.",
    ]);
    expect(limitNotices(accounts.slice(0, 1), false)).toEqual(["Claude Code: Timed out"]);
  });
});
