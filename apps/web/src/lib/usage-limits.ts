// An agent's usage limits as the composer shows them (providers.md D1144). Derived from T3 Code
// (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/shared/src/usageLimits.ts
// (limitsNotice, remainingPercent, elapsedShare, paceOf, formatDuration, formatResetsIn,
// isUsageLimitsCommand), apps/web/src/timestampFormat.ts (formatUpcomingTimestamp) and
// apps/web/src/components/usage/UsageLimits.tsx (resetCreditsSummary).
import type { AgentResetCredits, AgentUsageLimits, AgentUsageWindow } from "@jhin/agent-api";

import { formatDayAwareTimestamp, formatShortTimestamp, type TimestampFormat } from "./format.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `/usage-limits` sent on its own is answered by the client, never sent to the agent. */
export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function limitsNotice(limits: AgentUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: AgentUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: AgentUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: AgentUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: AgentUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(window: AgentUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

/** An account's banked reset credits (t3-parity.md D1655), T3's `resetCreditsSummary`. */
export function resetCreditsSummary(credits: AgentResetCredits, now: number): string {
  if (credits.availableCount === 0) return "No reset credits banked";
  const expires =
    credits.nextExpiresAt === undefined ? Number.NaN : Date.parse(credits.nextExpiresAt);
  const expiresIn = Number.isFinite(expires) ? formatDuration(expires - now) : null;
  return `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${
    expiresIn ? ` · next expires in ${expiresIn}` : ""
  }`;
}

const numericDate = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const numericDateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/** "12:34 PM" today, "tomorrow at 12:34 PM", otherwise "8/13 12:34 PM"; past times as day-aware. */
export function formatUpcomingTimestamp(
  isoDate: string,
  format: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  const time = formatShortTimestamp(isoDate, format);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTargetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfTargetDay - startOfToday) / 86_400_000);
  if (dayDiff < 0) return formatDayAwareTimestamp(isoDate, format, nowMs);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  const dateFormatter =
    date.getFullYear() === now.getFullYear() ? numericDate : numericDateWithYear;
  return `${dateFormatter.format(date)} ${time}`;
}

/** T3's row for a turn that failed on a usage limit (MessagesTimeline's failure item). */
export function usageLimitFailureLabel(
  resetAt: string | undefined,
  format: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const resetTime = resetAt ? formatUpcomingTimestamp(resetAt, format, nowMs) : null;
  return `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`;
}
