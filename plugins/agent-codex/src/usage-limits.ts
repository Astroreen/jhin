// Codex's usage limits (providers.md D1142). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/server/src/provider/codexUsageLimits.ts and
// clampPercent/makeUsageLimits of packages/provider-core/src/server/usageLimits.ts.
import type { AgentResetCredits, AgentUsageLimits, AgentUsageWindow } from "@jhin/agent-api";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

export interface CodexResetCreditsSummary {
  readonly availableCount: number;
  readonly credits?: ReadonlyArray<{
    readonly status: string;
    readonly expiresAt?: number | null;
  }> | null;
}

/** `account/rateLimits/read`'s answer. */
export interface CodexRateLimitsRead {
  readonly rateLimits?: CodexRateLimitSnapshot | null;
  readonly rateLimitsByLimitId?: Readonly<Record<string, CodexRateLimitSnapshot>> | null;
  readonly rateLimitResetCredits?: CodexResetCreditsSummary | null;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;
const KIND_ORDER: Record<AgentUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function kindForDuration(mins: number): AgentUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function labelForKind(kind: AgentUsageWindow["kind"]): string {
  return kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly";
}

/**
 * `primary` / `secondary` are positions, not durations. Codex usually sends
 * `windowDurationMins`; when it does not, paid plans expose the 5-hour and
 * weekly pair and Free/Go expose one monthly allowance.
 */
export function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): readonly AgentUsageWindow[] {
  // Show the main allowance only. Model-specific notifications (such as Spark)
  // must not replace its primary/secondary rows. Older CLIs omit the limit id.
  if (snapshot.limitId && snapshot.limitId !== "codex") return [];
  const isMonthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
  const positions = [
    ["primary", snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: AgentUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent))
      continue;
    const windowDurationMins =
      typeof window.windowDurationMins === "number" ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.toSorted((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

export function codexResetCreditsToLimits(
  summary: CodexResetCreditsSummary | null | undefined,
): AgentResetCredits | undefined {
  if (!summary || typeof summary.availableCount !== "number") return undefined;
  const expiries = (summary.credits ?? [])
    .filter((credit) => credit.status === "available")
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => typeof value === "number");
  const nextExpiresAt =
    expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined;
  return {
    availableCount: Math.max(0, summary.availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
}

export function codexRateLimitsToLimits(input: {
  readonly snapshot: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId?:
    | Readonly<Record<string, CodexRateLimitSnapshot>>
    | null
    | undefined;
  readonly resetCredits?: CodexResetCreditsSummary | null | undefined;
  readonly checkedAt: string;
}): AgentUsageLimits {
  const resetCredits = codexResetCreditsToLimits(input.resetCredits);
  const windows = codexRateLimitsToWindows(input.rateLimitsByLimitId?.["codex"] ?? input.snapshot);
  return {
    checkedAt: input.checkedAt,
    windows,
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/** T3's wording when Codex did not answer the usage request. */
export const RATE_LIMITS_FAILURE = "Codex did not answer the usage request.";

/** A snapshot read field by field from what Codex sent; undefined when it is none. */
export function readRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const window = (raw: unknown): CodexRateLimitWindow | null | undefined => {
    if (raw === null) return null;
    if (!isRecord(raw) || typeof raw["usedPercent"] !== "number") return undefined;
    return {
      usedPercent: raw["usedPercent"],
      ...(typeof raw["resetsAt"] === "number" ? { resetsAt: raw["resetsAt"] } : {}),
      ...(typeof raw["windowDurationMins"] === "number"
        ? { windowDurationMins: raw["windowDurationMins"] }
        : {}),
    };
  };
  const text = (raw: unknown) => (typeof raw === "string" || raw === null ? raw : undefined);
  const snapshot: {
    -readonly [K in keyof CodexRateLimitSnapshot]: CodexRateLimitSnapshot[K];
  } = {};
  for (const key of ["limitId", "planType", "rateLimitReachedType"] as const) {
    const read = text(value[key]);
    if (read !== undefined) snapshot[key] = read;
  }
  for (const key of ["primary", "secondary"] as const) {
    if (!(key in value)) continue;
    const read = window(value[key]);
    if (read !== undefined) snapshot[key] = read;
  }
  return snapshot;
}

/**
 * Codex sends `account/rateLimits/updated` as a partial view of the snapshot: a
 * field the update omits keeps the value observed earlier in the session, so a
 * later notification that only names the limit it reached must not drop the
 * windows an earlier one carried.
 */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots (such as Spark) describe a different allowance
  // and must not overwrite the main one, the same rule the usage rows apply.
  if (update.limitId && update.limitId !== "codex") return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: update.rateLimitReachedType }
      : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
  };
}

/** All exhausted windows must reset before a continuation can run. */
export function codexUsageLimitResetAt(
  snapshot: CodexRateLimitSnapshot | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const windows = codexRateLimitsToWindows(snapshot).filter((window) => window.usedPercent >= 100);
  if (windows.length === 0 || windows.some((window) => !window.resetsAt)) return undefined;
  return windows.reduce<string | undefined>(
    (latest, window) =>
      latest === undefined || Date.parse(window.resetsAt!) > Date.parse(latest)
        ? window.resetsAt!
        : latest,
    undefined,
  );
}

/** T3's codexErrorInfoCode: Codex's error info is a name, or an object keyed by it. */
export function codexErrorInfoCode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return Object.keys(value)[0];
}

/** The error codes T3 classes as a usage limit. */
export const isUsageLimitCode = (code: string | undefined) =>
  code === "usageLimitExceeded" || code === "rateLimitExceeded";
