// Snooze presets, custom times and wake labels follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): packages/client-runtime/src/state/threadSettled.ts and
// apps/web/src/components/Sidebar.snooze.ts.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** When it wakes, as the menu shows it next to the label. */
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

const timeOfDay = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function atHour(base: Date, hour: number): Date {
  const next = new Date(base.getTime());
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar days, not 24 hours: across a DST change a day is 23 or 25 hours long.
function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** T3's presets: in an hour, in three, this evening (while more than an hour away), tomorrow, next week. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDay(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeOfDay(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDay(evening),
      snoozedUntil: evening.toISOString(),
    });
  }
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDay(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDay(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    });
  }
  return presets;
}

/** How long until a snoozed thread wakes, as its row shows it: "5m", "3h", "2d". */
export function snoozeWakeLabel(snoozedUntil: string, nowMs: number): string {
  const wakeMs = Date.parse(snoozedUntil);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remaining = wakeMs - nowMs;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

/** The wake time a custom snooze asks for, if it is valid and in the future. */
export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: DAY_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Rolled-over dates and local times a DST change skips are refused.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export const localSnoozeDate = (date: Date) =>
  `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const localSnoozeTime = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
