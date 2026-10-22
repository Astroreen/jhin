// An agent's usage limits and a turn that failed on one (since `agent.runtime` 1.8,
// providers.md D1141, D1143). The shapes are T3 Code's (MIT, see THIRD_PARTY_NOTICES.md) at
// eb7b35ac: packages/contracts/src/providerUsageLimits.ts (ServerProviderUsageWindow,
// ServerProviderResetCredits, ServerProviderUsageLimits) and the `usage_limit` class of
// OrchestrationV2ProviderFailure.

/**
 * One window of an allowance. `id` is stable per agent (`primary`, `five_hour`), so a sparse
 * update lands on the row a full read produced.
 */
export interface AgentUsageWindow {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  /** 0–100. */
  readonly usedPercent: number;
  /** ISO time the window resets. */
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
}

export interface AgentResetCredits {
  readonly availableCount: number;
  /** ISO time the first available credit expires. */
  readonly nextExpiresAt?: string;
}

/** What an agent's account may still spend, as the agent last reported it. */
export interface AgentUsageLimits {
  /** ISO time the agent reported it. */
  readonly checkedAt: string;
  readonly windows: readonly AgentUsageWindow[];
  readonly resetCredits?: AgentResetCredits;
  /**
   * No windows to show: `unsupported` for an account that never has them (an API key),
   * `probeFailed` when reading them failed this time.
   */
  readonly unavailable?: {
    readonly reason: "unsupported" | "probeFailed";
    readonly message?: string;
  };
}

/** Why a turn failed, when the agent says more than its message (T3's failure class). */
export interface AgentTurnFailure {
  readonly class: "usage_limit";
  /** ISO time every exhausted window has reset, when the agent knows it. */
  readonly resetAt?: string;
}

/**
 * The error a runtime's `items` throws for a turn that hit a usage limit; the threads plugin
 * records its `failure` with the turn's failure (`agent.turn.failed`).
 */
export class UsageLimitError extends Error {
  readonly failure: AgentTurnFailure;
  constructor(message: string, resetAt?: string) {
    super(message);
    this.name = "UsageLimitError";
    this.failure = { class: "usage_limit", ...(resetAt === undefined ? {} : { resetAt }) };
  }
}

/** The failure an error a turn threw carries, if any (also across copies of this package). */
export function turnFailureOf(error: unknown): AgentTurnFailure | undefined {
  const failure = (error as { failure?: unknown } | null)?.failure;
  if (typeof failure !== "object" || failure === null) return undefined;
  const { class: kind, resetAt } = failure as { class?: unknown; resetAt?: unknown };
  if (kind !== "usage_limit") return undefined;
  return { class: kind, ...(typeof resetAt === "string" ? { resetAt } : {}) };
}

/** T3's built-in `/usage-limits` (USAGE_LIMITS_COMMAND): answered by the client, never sent. */
export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} as const;
