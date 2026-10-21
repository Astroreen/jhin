// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// packages/contracts/src/scheduledTask.ts and apps/server/src/scheduledTasks/Schedule.ts at
// v0.1.1-nightly.20261020.3411: the task and trigger schemas, the one-minute interval floor,
// the next run of a schedule, when a fixed-time run counts as missed and how a schedule reads.
import { INTERACTION_MODES, RUNTIME_MODES } from "@jhin/agent-api";
import { z } from "@jhin/sdk";

/** `scheduler.tasks@1`: a node's scheduled tasks (docs/plans/orchestration.md, D380). */
export const SCHEDULER_CAPABILITY = "scheduler.tasks";

/**
 * The node's scheduled tasks: one event per change. Clients read
 * `scheduler.tasks.list` and follow this stream after the `head` it returns.
 */
export const SCHEDULER_STREAM = "scheduler";

export const SchedulerEvents = {
  /** A `ScheduledTask` after a change (created, edited, run). */
  taskUpdated: "scheduler.task.updated",
  /** `{ id }`: the task was deleted. */
  taskDeleted: "scheduler.task.deleted",
} as const;

/** Where webhook requests go: `<prefix>/<taskId>/<token>` on the node's HTTP server. */
export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";

export const MIN_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const TimeOfDay = z
  .string()
  .trim()
  .regex(TIME_OF_DAY, "must be HH:MM")
  .describe("Local wall-clock time in 24-hour HH:MM form, such as 09:30.");

const IntervalSchedule = z
  .object({
    type: z.literal("interval"),
    everyMs: z
      .number()
      .int()
      .min(MIN_INTERVAL_MS)
      .describe("Interval in milliseconds, with a minimum of 60000 (one minute)."),
  })
  .describe("Run repeatedly after a fixed number of milliseconds.");

const FixedTimeSchedule = z
  .object({
    type: z.literal("fixed_time"),
    timeOfDay: TimeOfDay,
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .optional()
      .describe("Weekday numbers where 0 is Sunday and 6 is Saturday; omit to run every day."),
  })
  .describe("Run at a fixed local wall-clock time on selected weekdays.");

const SignatureFields = {
  header: z
    .string()
    .trim()
    .min(1)
    .describe("Request header carrying the signature, such as x-hub-signature-256."),
  encoding: z
    .enum(["hex", "base64"])
    .describe("How the HMAC-SHA256 digest is encoded in the header."),
  prefix: z
    .string()
    .describe("Text before the digest in the header value, such as 'sha256='. Empty for none."),
};

export const WebhookSignature = z
  .object(SignatureFields)
  .describe("Optional HMAC-SHA256 signature check over the raw request body.");
export type WebhookSignature = z.output<typeof WebhookSignature>;

const WEBHOOK_DESCRIPTION =
  "Run on each request to the task's webhook URL. The prompt may use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}} placeholders.";

/** A task's trigger as stored and returned. */
export const Schedule = z
  .discriminatedUnion("type", [
    IntervalSchedule,
    FixedTimeSchedule,
    z
      .object({ type: z.literal("webhook"), signature: WebhookSignature.nullable() })
      .describe(WEBHOOK_DESCRIPTION),
  ])
  .describe("Structured trigger: an object with type 'interval', 'fixed_time' or 'webhook'.");
export type Schedule = z.output<typeof Schedule>;

/** A trigger as given to create or update: a webhook's signature may carry its secret. */
export const ScheduleInput = z
  .discriminatedUnion("type", [
    IntervalSchedule,
    FixedTimeSchedule,
    z
      .object({
        type: z.literal("webhook"),
        signature: z
          .object({
            ...SignatureFields,
            secret: z
              .string()
              .min(1)
              .optional()
              .describe("Shared signing secret. Omit to keep the stored secret."),
          })
          .nullable()
          .optional()
          .describe("Signature check; omit or null to accept requests by URL token only."),
      })
      .describe(WEBHOOK_DESCRIPTION),
  ])
  .describe("Structured trigger: an object with type 'interval', 'fixed_time' or 'webhook'.");
export type ScheduleInput = z.output<typeof ScheduleInput>;

export const RUN_STATUSES = ["never", "running", "succeeded", "failed"] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.output<typeof RunStatus>;

export const WebhookEndpoint = z.object({
  /**
   * `/api/hooks/<taskId>/<token>`. The token lets anyone run the task, so only
   * a caller that may change tasks (`scheduler.write`) sees it: null for the
   * others and on the `scheduler` stream.
   */
  path: z.string().nullable(),
  /** The node's own URL plus the path; null without an HTTP server or without the path. */
  url: z.string().nullable(),
  hasSecret: z.boolean(),
});
export type WebhookEndpoint = z.output<typeof WebhookEndpoint>;

/**
 * Where a run's new thread works (T3's launch workspace strategies,
 * orchestration.md D983): the project checkout, a new worktree, or a given
 * checkout. Absent: the project checkout.
 */
export const WorkspaceStrategy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("root"), branch: z.string().min(1).optional() }),
  z.object({
    type: z.literal("worktree"),
    baseRef: z.string().min(1),
    branch: z.string().min(1).optional(),
    startFromOrigin: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("existing_worktree"),
    worktreePath: z.string().min(1),
    branch: z.string().min(1).optional(),
  }),
]);
export type WorkspaceStrategy = z.output<typeof WorkspaceStrategy>;

/** Agent settings of the threads an unbound task creates. */
const AgentSettings = {
  agentId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimeMode: z.enum(RUNTIME_MODES).optional(),
  interactionMode: z.enum(INTERACTION_MODES).optional(),
  /** Where a run's new thread works (D983); a bound thread keeps its own. */
  workspaceStrategy: WorkspaceStrategy.optional(),
};

export const ScheduledTask = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  schedule: Schedule,
  projectId: z.string(),
  /** The thread every run goes to; null creates a new thread per run. */
  threadId: z.string().nullable(),
  ...AgentSettings,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: RunStatus,
  lastRunError: z.string().nullable(),
  /** The thread the last run went to. */
  lastRunThreadId: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  /** Webhook tasks only. */
  webhook: WebhookEndpoint.optional(),
});
export type ScheduledTask = z.output<typeof ScheduledTask>;

const Title = z.string().trim().min(1).max(200);
const Prompt = z.string().trim().min(1);

export const CreateTaskInput = z.object({
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The project the task's threads belong to; omit for the bound thread's project, or the scratch project.",
    ),
  prompt: Prompt.describe("Prompt executed on every run."),
  schedule: ScheduleInput,
  title: Title.optional().describe(
    "Defaults to the prompt's first line (80 characters), else 'Scheduled task'.",
  ),
  enabled: z.boolean().default(true).describe("Whether the schedule starts enabled."),
  threadId: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe("Post every run into this thread; null creates a fresh thread per run."),
  ...AgentSettings,
  clientRequestId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Reuse when retrying a call that lost its result; the same id returns its task."),
});
export type CreateTaskInput = z.output<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  id: z.string(),
  title: Title.optional(),
  prompt: Prompt.optional(),
  schedule: ScheduleInput.optional(),
  enabled: z.boolean().optional().describe("false pauses the task without deleting it."),
  threadId: z.string().min(1).nullable().optional(),
  ...AgentSettings,
  /** null clears it: the task's runs take the node's default agent and model again (D984). */
  agentId: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
});
export type UpdateTaskInput = z.output<typeof UpdateTaskInput>;

export const DELIVERY_OUTCOMES = [
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
] as const;
export const DeliveryOutcome = z.enum(DELIVERY_OUTCOMES);
export type DeliveryOutcome = z.output<typeof DeliveryOutcome>;

export const DeliverySummary = z.object({
  id: z.string(),
  taskId: z.string(),
  receivedAt: z.string(),
  method: z.string(),
  contentType: z.string().nullable(),
  bodyBytes: z.number().int().nonnegative(),
  outcome: DeliveryOutcome,
  signatureVerified: z.boolean(),
  /** Placeholders of the prompt the request had no value for. */
  missingFields: z.array(z.string()),
  error: z.string().nullable(),
});
export type DeliverySummary = z.output<typeof DeliverySummary>;

export const Delivery = DeliverySummary.extend({
  query: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  bodyTruncated: z.boolean(),
  renderedPrompt: z.string().nullable(),
});
export type Delivery = z.output<typeof Delivery>;

/** `scheduler.tasks@1`: what the commands do, for plugins on the same node. */
export interface SchedulerService {
  list(projectId?: string): Promise<ScheduledTask[]>;
  get(id: string): Promise<ScheduledTask | undefined>;
  create(input: z.input<typeof CreateTaskInput>): Promise<ScheduledTask>;
  update(input: z.input<typeof UpdateTaskInput>): Promise<ScheduledTask>;
  delete(id: string): Promise<boolean>;
  /** Runs a task now; resolves once its message went out (or failed). */
  run(id: string): Promise<{ task: ScheduledTask; threadId: string | null }>;
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = TIME_OF_DAY.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The next run after `from`, in the node's local time zone; null for a webhook.
 * An interval counts elapsed time, across daylight saving changes.
 */
export function nextRunAfter(schedule: Schedule, from: Date): Date | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") {
    return new Date(from.getTime() + Math.max(schedule.everyMs, MIN_INTERVAL_MS));
  }
  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + offset,
      time.hour,
      time.minute,
    );
    if (candidate.getTime() <= from.getTime()) continue;
    if (weekdays !== null && !weekdays.has(candidate.getDay())) continue;
    return candidate;
  }
  return null;
}

function weekdayKey(weekdays: readonly number[] | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

/** Whether two schedules fire at the same times (a webhook's signature does not count). */
export function isSameSchedule(a: Schedule, b: Schedule): boolean {
  if (a.type === "interval") return b.type === "interval" && a.everyMs === b.everyMs;
  if (a.type === "webhook") return b.type === "webhook";
  if (b.type !== "fixed_time") return false;
  // "9:00" and "09:00" are one time: a format-only edit is no schedule change.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

/** How late a fixed-time run may start; later it is skipped (the node was down or asleep). */
export const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedFixedTimeRun(schedule: Schedule, dueAt: Date, now: Date): boolean {
  if (schedule.type !== "fixed_time") return false;
  return now.getTime() - dueAt.getTime() > MISSED_FIXED_TIME_GRACE_MS;
}

/** "Every 5 minutes", "At 09:00 every weekday", "On webhook". */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / MINUTE_MS;
    if (Number.isInteger(minutes)) {
      return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
    }
    return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
  }
  const weekdayCount = schedule.weekdays?.length ?? 0;
  const days =
    weekdayCount === 0
      ? "day"
      : weekdayCount === 5 && schedule.weekdays?.every((day) => day >= 1 && day <= 5)
        ? "weekday"
        : "selected day";
  return `At ${schedule.timeOfDay} every ${days}`;
}
