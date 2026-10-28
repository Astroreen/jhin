// The Usage page's limits, pooled per agent across nodes (t3-parity.md D1309). Derived from
// T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/shared/src/usageLimits.ts
// (collectLimitPools, poolWindows, collectLimitNotices, paceOfShares).
import type { AgentUsageLimits, AgentUsageWindow } from "@jhin/agent-api";
import { targetKey, type AgentInfo, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";

import type { ShownNode } from "./nodes.ts";
import { elapsedShare, limitsNotice, type LimitPace } from "./usage-limits.ts";

/** One agent's limits on one node: a column of its agent's pool. */
export interface LimitAccount {
  /** Unique across nodes and agents. */
  readonly key: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly nodeLabel: string;
  /** The node it was read from, where its reset credit is redeemed (t3-parity.md D1656). */
  readonly target: NodeTarget;
  readonly limits: AgentUsageLimits;
}

interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: AgentUsageWindow;
}

/** One window of an agent, over every account that reports it. */
export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: AgentUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  /** Every account of the agent, in the pool's order; `window` is null where it has none. */
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window: AgentUsageWindow | null;
  }>;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
}

export interface LimitPool {
  readonly agentId: string;
  readonly agentName: string;
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

const KIND_ORDER: Record<AgentUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

const resetMillis = (window: AgentUsageWindow): number | null => {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
};

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/**
 * The agents whose window ids are slots, not allowances: Codex's (a weekly-only plan reports
 * its weekly window as `primary`, providers.md D1142). Their windows pool by kind; other
 * agents' ids name distinct allowances. T3 decides this by its driver as well.
 */
const SLOT_WINDOW_AGENTS: ReadonlySet<string> = new Set(["jhin.agent-codex"]);

function poolKey(agentId: string, window: AgentUsageWindow): string {
  return SLOT_WINDOW_AGENTS.has(agentId) ? window.kind : `${window.kind}:${window.id}`;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const window of account.limits.windows) {
      const pooled = poolKey(account.agentId, window);
      // Two windows of one account under one key stay apart.
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push({ account, window });
      else byKey.set(key, [{ account, window }]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const usedPercent =
      members.reduce((sum, member) => sum + member.window.usedPercent, 0) / members.length;
    // Pace compares spend against the clock, so only members with a clock count.
    const timed = members.flatMap((member) => {
      const share = elapsedShare(member.window, now);
      return share === null ? [] : [{ used: member.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, entry) => sum + entry.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, entry) => sum + entry.elapsed, 0) / timed.length : null;
    return {
      // A slot agent's pool is named by its kind, unless two windows of one account split it.
      id:
        SLOT_WINDOW_AGENTS.has(members[0]!.account.agentId) && key === first.kind ? key : first.id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
    };
  });
  return pools.toSorted((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

/**
 * The accounts with limits to show, pooled per agent: the accounts ordered by the reset of
 * their first window, then by node. An account whose limits carry a notice is left out
 * (`limitNotices` names it).
 */
export function collectLimitPools(accounts: readonly LimitAccount[], now: number): LimitPool[] {
  const byAgent = new Map<string, LimitAccount[]>();
  for (const account of accounts) {
    if (limitsNotice(account.limits) !== null) continue;
    const list = byAgent.get(account.agentId);
    if (list) list.push(account);
    else byAgent.set(account.agentId, [account]);
  }
  return [...byAgent].map(([agentId, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .toSorted((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (candidate) =>
          orderWindow !== undefined &&
          poolKey(agentId, candidate) === poolKey(agentId, orderWindow),
      );
      return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY;
    };
    const sorted = members.toSorted(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        left.nodeLabel.toLowerCase().localeCompare(right.nodeLabel.toLowerCase()) ||
        left.key.localeCompare(right.key),
    );
    return {
      agentId,
      agentName: members[0]!.agentName,
      accounts: sorted,
      windows: poolWindows(sorted, now),
    };
  });
}

/**
 * What could not be shown, T3's collectLimitNotices: a read that failed or reported no
 * windows. An account without subscription limits is no notice. With several nodes each
 * names its node.
 */
export function limitNotices(accounts: readonly LimitAccount[], severalNodes: boolean): string[] {
  return accounts.flatMap((account) => {
    if (account.limits.unavailable?.reason === "unsupported") return [];
    const notice = limitsNotice(account.limits);
    if (notice === null) return [];
    const subject = severalNodes
      ? `${account.nodeLabel} · ${account.agentName}`
      : account.agentName;
    return [`${subject}: ${notice}`];
  });
}

/** What the page read: every node's agents with limits, as of `now`. */
export interface UsageRead {
  readonly accounts: readonly LimitAccount[];
  readonly severalNodes: boolean;
  /** How many open nodes were asked. */
  readonly nodes: number;
  readonly now: number;
  /** Nodes whose agents could not be listed. */
  readonly failures: readonly string[];
}

/** Reads the limits of every agent that has them, on every open node. */
export async function readUsage(
  threads: ThreadsCatalog,
  nodes: readonly ShownNode[],
): Promise<UsageRead> {
  // One clock for the read: when it was asked, and what its bars are as of.
  const now = Date.now();
  const open = nodes.filter((node) => node.state === "open");
  const failures: string[] = [];
  const perNode = await Promise.all(
    open.map(async (node): Promise<LimitAccount[]> => {
      let agents: AgentInfo[];
      try {
        agents = await threads.call<AgentInfo[]>(node.target, "agents.list");
      } catch (error) {
        failures.push(`${node.label}: ${(error as Error).message}`);
        return [];
      }
      const read = await Promise.all(
        agents
          .filter((agent) => agent.usageLimits === true && agent.available)
          .map(async (agent): Promise<LimitAccount | undefined> => {
            const key = `${targetKey(node.target)}|${agent.agentId}`;
            try {
              const { usageLimits } = await threads.call<{
                usageLimits: AgentUsageLimits | null;
              }>(node.target, "agents.usage-limits", { agentId: agent.agentId });
              if (usageLimits === null) return undefined;
              return {
                key,
                agentId: agent.agentId,
                agentName: agent.name,
                nodeLabel: node.label,
                target: node.target,
                limits: usageLimits,
              };
            } catch (error) {
              return {
                key,
                agentId: agent.agentId,
                agentName: agent.name,
                nodeLabel: node.label,
                target: node.target,
                limits: {
                  checkedAt: new Date(now).toISOString(),
                  windows: [],
                  unavailable: { reason: "probeFailed", message: (error as Error).message },
                },
              };
            }
          }),
      );
      return read.filter((account): account is LimitAccount => account !== undefined);
    }),
  );
  return {
    accounts: perNode.flat(),
    severalNodes: open.length > 1,
    nodes: open.length,
    now,
    failures,
  };
}
