// Codex's thread goals and `/goal` (providers.md D1149). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
// (parseCodexGoalCommand, providerGoalFromCodex, describeCodexGoal, runGoalCommand's replies)
// and apps/server/src/provider/CodexProvider.ts (the `/goal` slash command).
import type { AgentGoal, AgentSlashCommand } from "@jhin/agent-api";

export const GOAL_COMMAND: AgentSlashCommand = {
  name: "goal",
  description: "Set a goal Codex keeps working toward until it is done",
  input: { hint: "Objective, or pause, resume, clear" },
};

/** T3's `/feedback` of Codex (providers.md D1317): the client sends it, never Codex. */
export const FEEDBACK_COMMAND: AgentSlashCommand = {
  name: "feedback",
  description: "Send this thread and Codex logs to OpenAI",
  input: { hint: "Describe the issue (optional)" },
};

export type GoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

export function parseGoalCommand(text: string): GoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

const STATUSES: Record<string, AgentGoal["status"]> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;

/** Codex's goal as Jhin's; `null` for none or one without an objective. */
export function goalFromCodex(value: unknown): AgentGoal | null {
  if (!isRecord(value) || typeof value["objective"] !== "string") return null;
  const objective = value["objective"].trim();
  const status = STATUSES[String(value["status"])];
  if (objective.length === 0 || status === undefined) return null;
  const tokensUsed = count(value["tokensUsed"]);
  const tokenBudget = count(value["tokenBudget"]);
  const timeUsedSeconds = count(value["timeUsedSeconds"]);
  return {
    objective,
    status,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeUsedSeconds === undefined ? {} : { timeUsedSeconds }),
  };
}

export function describeGoal(goal: AgentGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}
