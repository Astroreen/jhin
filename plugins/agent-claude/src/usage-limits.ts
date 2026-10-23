// Claude Code's usage limits (providers.md D1301–D1303). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/server/src/provider/claudeUsageLimits.ts,
// applyUsageLimitsUpdate/makeUsageLimits of packages/provider-core/src/server/usageLimits.ts,
// and the usage-limit classification of a result (providerFailureFromResult,
// rejectedRateLimitTypes) in apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts.
import type { AgentUsageLimits, AgentUsageWindow } from "@jhin/agent-api";
import type { SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Readonly<
  Record<string, Pick<AgentUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

const KIND_ORDER: Record<AgentUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while the usage read names it by the model's
 * `display_name`. The read records the name it saw and the event reuses it, so the
 * mid-turn update lands on the row the read drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

/** The names of the model-scoped windows the last read saw. */
export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

/** The `get_usage` answer, as far as the limits need it. */
export interface ClaudeUsageResponse {
  readonly rate_limits_available: boolean;
  readonly rate_limits?: object | null;
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(windows: Iterable<AgentUsageWindow>): AgentUsageWindow[] {
  return [...windows].toSorted(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.id.localeCompare(right.id),
  );
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): AgentUsageWindow {
  return {
    id: `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function makeWindow(id: string, usedPercent: number, resetsAt: string | undefined) {
  return {
    id,
    ...WINDOWS[id]!,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  } satisfies AgentUsageWindow;
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value * 1000 >= 8.64e15) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

function isoFromString(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

interface UsageWindowRead {
  readonly utilization?: unknown;
  readonly resets_at?: unknown;
}

/** `model_scoped` is newer than the SDK's typings: read structurally, as T3 does. */
function readModelScoped(rateLimits: object) {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is UsageWindowRead & { display_name: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { display_name?: unknown }).display_name === "string",
  );
}

/** The limits a usage read reports; its percentages are already 0–100. */
export function claudeUsageResponseToLimits(
  response: ClaudeUsageResponse,
  checkedAt: string,
): { readonly limits: AgentUsageLimits; readonly names: ClaudeScopedLimitNames } {
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      names: { overageIncluded: undefined },
    };
  }
  const rateLimits = response.rate_limits as Record<string, UsageWindowRead | null | undefined>;
  const windows: AgentUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = rateLimits[id];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // Claude Code filters `model_scoped` to the overage-included allowlist, which holds one
  // model today; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    overageIncluded ??= entry.display_name;
  }
  return { limits: { checkedAt, windows: sortWindows(windows) }, names: { overageIncluded } };
}

/**
 * The window a `rate_limit_event` updates; its utilization is a 0–1 fraction. An
 * overage-included event before any read named the bucket is dropped: a guessed name would
 * draw a row the next read cannot reconcile.
 */
export function claudeRateLimitEventToWindow(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): AgentUsageWindow | undefined {
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") return undefined;
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) return makeWindow(type, usedPercent, resetsAt);
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return scopedWindow(names.overageIncluded, usedPercent, resetsAt);
  }
  return undefined;
}

/**
 * The limits with one window updated (T3's applyUsageLimitsUpdate): the row of the same id
 * is replaced, keeping its reset time and duration when the update names none. An account
 * without limits stays without, and a read that failed stays failed: one window is not the
 * account's limits, and the next look reads them again (D1304).
 */
export function applyUsageWindow(
  previous: AgentUsageLimits | undefined,
  window: AgentUsageWindow,
  checkedAt: string,
): AgentUsageLimits | undefined {
  if (previous?.unavailable !== undefined) return previous;
  const merged = new Map(previous?.windows.map((entry) => [entry.id, entry] as const));
  const existing = merged.get(window.id);
  merged.set(window.id, {
    ...window,
    ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
      ? { resetsAt: existing.resetsAt }
      : {}),
    ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
      ? { windowDurationMins: existing.windowDurationMins }
      : {}),
  });
  return {
    checkedAt,
    windows: sortWindows(merged.values()),
    ...(previous?.resetCredits === undefined ? {} : { resetCredits: previous.resetCredits }),
  };
}

/** T3's text for a turn a usage limit stopped. */
export const USAGE_LIMIT_MESSAGE =
  "Claude usage limit reached. Send the message again once the limit resets.";

/** What a turn learnt of the limits it ran into, from its rate-limit events and messages. */
export class TurnLimits {
  /** The rejected limits by type, with their reset time when Claude Code sent one. */
  readonly #rejected = new Map<string, string | undefined>();
  /** The last top-level assistant message was Claude Code's `rate_limit` error. */
  assistantRateLimited = false;

  /** Takes a `rate_limit_event`: a rejection without overage to fall back on blocks. */
  event(info: SDKRateLimitInfo): void {
    const overageAllowed =
      info.overageStatus === "allowed" ||
      info.overageStatus === "allowed_warning" ||
      info.isUsingOverage === true ||
      info.overageInUse === true;
    const type = info.rateLimitType ?? "unknown";
    if (info.status === "rejected" && !overageAllowed) {
      this.#rejected.set(type, isoFromEpochSeconds(info.resetsAt));
    } else if (info.status === "allowed" || info.status === "allowed_warning" || overageAllowed) {
      this.#rejected.delete(type);
    }
  }

  /**
   * Whether the failed result is the usage limit's, T3's rule: a limit was rejected (or the
   * last answer was the limit's error), and the result is no other API error or stop.
   */
  limited(result: SDKResultMessage): boolean {
    if (result.subtype === "success" && result.api_error_status === 429) return true;
    if (this.#rejected.size === 0 && !this.assistantRateLimited) return false;
    const status = result.subtype === "success" ? result.api_error_status : undefined;
    const reason = result.terminal_reason;
    return (
      (status == null || status === 429) &&
      (reason == null || reason === "api_error" || reason === "blocking_limit")
    );
  }

  /** The latest reset of the rejected limits, when every one of them names its reset. */
  resetAt(): string | undefined {
    const times = [...this.#rejected.values()];
    if (times.length === 0 || times.some((time) => time === undefined)) return undefined;
    return times.reduce((latest, time) => (time! > latest! ? time : latest));
  }
}

const GATEWAY_LIMIT =
  /^API Error: 503 \[[^\]\r\n]+\] \[429\]: \{"type":"error","error":\{"type":"rate_limit_error",[^\r\n]*\} \(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/;

/** A gateway's 503 wrapping Claude's 429 with its reset delay, as T3 reads it. */
export function gatewayLimitResetAt(result: SDKResultMessage, now: number): string | undefined {
  if (
    result.subtype !== "success" ||
    !result.is_error ||
    result.terminal_reason !== "api_error" ||
    result.api_error_status !== 503
  ) {
    return undefined;
  }
  const match = GATEWAY_LIMIT.exec(result.result);
  if (match === null) return undefined;
  const seconds =
    Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  const at = now + seconds * 1_000;
  return seconds > 0 && at < 8.64e15 ? new Date(at).toISOString() : undefined;
}
