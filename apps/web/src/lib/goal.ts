// The goal banner's wording (providers.md D1150). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/client-runtime/src/state/threadExecution.ts
// (presentProviderGoal, PROVIDER_GOAL_TITLES, formatGoalTokens).
import type { AgentGoal } from "@jhin/agent-api";

import { formatDuration } from "./format.ts";

export interface GoalPresentation {
  readonly title: string;
  readonly objective: string;
  readonly usage: string | null;
  readonly canResume: boolean;
}

const TITLES: Record<AgentGoal["status"], string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal hit a usage limit",
  budget_limited: "Goal reached its token budget",
  complete: "Goal complete",
};

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function presentGoal(goal: AgentGoal, working: boolean): GoalPresentation {
  const usage: string[] = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) {
    usage.push(
      goal.tokenBudget === undefined
        ? `${formatGoalTokens(goal.tokensUsed)} tokens`
        : `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(goal.tokenBudget)} tokens`,
    );
  }
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) {
    usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  return {
    title: goal.status === "active" && !working ? "Goal set" : TITLES[goal.status],
    objective: goal.objective,
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}
