// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/timestampFormat.ts and
// packages/shared/src/orchestrationTiming.ts.

/** How clock times are shown: the locale's way, or forced to 12 or 24 hours. */
export type TimestampFormat = "locale" | "12-hour" | "24-hour";

const formatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(format: TimestampFormat, seconds: boolean): Intl.DateTimeFormat {
  const key = `${format}:${seconds}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      ...(format === "locale" ? {} : { hour12: format === "12-hour" }),
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatShortTimestamp(isoDate: string, format: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  return date === null ? "" : timeFormatter(format, false).format(date);
}

const numericDate = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const numericDateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/** "12:34 PM" today, "yesterday at 12:34 PM", otherwise "8/13 12:34 PM" (with the year when not this year). */
export function formatDayAwareTimestamp(
  isoDate: string,
  format: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (date === null) return "";
  const time = timeFormatter(format, false).format(date);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const dateFormatter =
    date.getFullYear() === now.getFullYear() ? numericDate : numericDateWithYear;
  return `${dateFormatter.format(date)} ${time}`;
}

const monthName = new Intl.DateTimeFormat("en-US", { month: "long" });

function ordinalSuffix(day: number): string {
  const lastTwo = day % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** "12:34 PM, 13th August 2026": the tooltip of a message time. */
export function formatFullTimestamp(isoDate: string, format: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (date === null) return "";
  const day = date.getDate();
  return `${formatShortTimestamp(isoDate, format)}, ${day}${ordinalSuffix(day)} ${monthName.format(date)} ${date.getFullYear()}`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatRelativeTimeLabel(isoDate: string, nowMs: number = Date.now()): string {
  const date = parseTimestampDate(isoDate);
  if (date === null) return "";
  const seconds = Math.floor((nowMs - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The compact form for dense rows: "now", "5m", "3h", "2d". */
export function formatCompactRelativeTime(isoDate: string, nowMs: number = Date.now()): string {
  const label = formatRelativeTimeLabel(isoDate, nowMs);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** "850ms", "4.2s", "42s", "1m 5s", "2h 3m". */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** The running timer of a working turn: "12s" under a minute, then `formatDuration`. */
export function formatWorkingTimer(startIso: string, nowMs: number = Date.now()): string {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "0s";
  const seconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1_000);
}

/** "76k", "1.2k", "1.2m": token counts. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 999_500) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
