// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md),
// apps/web/src/components/settings/ScheduledTasksSettings.tsx and scheduledTasksSettings.logic.ts
// at v0.1.1-nightly.20261020.3411: how a schedule, an upcoming run and a delivery read, and the
// editor's draft of a task.
import {
  MIN_INTERVAL_MS,
  type DeliveryOutcome,
  type RunStatus,
  type ScheduledTask,
  type ScheduleInput,
  type WorkspaceStrategy,
} from "@jhin/scheduler-api";

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export const DEFAULT_WEBHOOK_PROMPT = "Handle this webhook:\n{{body}}";

export function scheduleLabel(schedule: ScheduledTask["schedule"]): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/** "in 5m" for an upcoming run, "3m ago" for a past one. */
export function relativeLabel(value: string | null, nowMs: number): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const minutes = Math.floor(-diffMs / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export const DELIVERY_OUTCOME_LABELS: Record<DeliveryOutcome, string> = {
  accepted: "Ran",
  dispatch_failed: "Run failed",
  rejected_signature: "Bad signature",
  disabled: "Task paused",
  rate_limited: "Rate limited",
};

export function deliveryOutcomeVariant(outcome: DeliveryOutcome) {
  if (outcome === "accepted") return "success" as const;
  if (outcome === "disabled" || outcome === "rate_limited") return "warning" as const;
  return "error" as const;
}

export function statusVariant(status: RunStatus) {
  if (status === "failed") return "error" as const;
  if (status === "succeeded") return "success" as const;
  if (status === "running") return "info" as const;
  return "outline" as const;
}

export type ScheduleMode = "fixed" | "interval" | "webhook";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  /** Empty: a new thread for every run. */
  readonly threadId: string;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the node. */
  readonly signatureSecret: string;
  /** Where a run's new thread works (D983). */
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  /** A strategy's `branch`, kept through an edit (the editor does not show it). */
  readonly workspaceBranch: string;
  /** `<agentId>\0<model>`; empty: the node's default agent and model (D984). */
  readonly modelKey: string;
}

export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

/** T3's names for the workspace a run works in. */
export const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

export const modelKey = (agentId: string, model: string) => `${agentId}\u0000${model}`;

/** The agent and model a draft runs with; none: the node's defaults. */
export function agentFromDraft(draft: DraftState): { agentId?: string; model?: string } {
  if (draft.modelKey === "") return {};
  const [agentId = "", model = ""] = draft.modelKey.split("\u0000");
  return { agentId, ...(model === "" ? {} : { model }) };
}

/** T3's workspace strategy of a draft. */
export function workspaceFromDraft(draft: DraftState): WorkspaceStrategy {
  const branch = draft.workspaceBranch === "" ? {} : { branch: draft.workspaceBranch };
  return draft.workspaceMode === "root"
    ? { type: "root", ...branch }
    : draft.workspaceMode === "existing_worktree"
      ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim(), ...branch }
      : {
          type: "worktree",
          baseRef: draft.baseRef.trim() || "main",
          startFromOrigin: draft.startFromOrigin,
          ...branch,
        };
}

const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

export const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  // T3's defaults for a new task.
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  workspaceBranch: "",
  modelKey: "",
};

export function scheduleFromDraft(draft: DraftState): ScheduleInput {
  if (draft.scheduleMode === "webhook") {
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
    };
  }
  if (draft.scheduleMode === "interval") {
    return { type: "interval", everyMs: Math.round(Number(draft.intervalMinutes) * 60_000) };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const workspace = task.workspaceStrategy;
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode:
      schedule.type === "interval" ? "interval" : schedule.type === "webhook" ? "webhook" : "fixed",
    intervalMinutes:
      // The real value, even under a minute: saving it is refused, never silently changed.
      schedule.type === "interval" ? String(schedule.everyMs / 60_000) : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays:
      schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
        ? new Set(schedule.weekdays)
        : new Set([0, 1, 2, 3, 4, 5, 6]),
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    // A task from before D983 works in the project checkout.
    workspaceMode: workspace?.type ?? "root",
    baseRef: workspace?.type === "worktree" ? workspace.baseRef : "main",
    startFromOrigin: workspace?.type === "worktree" ? (workspace.startFromOrigin ?? false) : true,
    existingWorktreePath: workspace?.type === "existing_worktree" ? workspace.worktreePath : "",
    workspaceBranch: workspace?.branch ?? "",
    modelKey: task.agentId === undefined ? "" : modelKey(task.agentId, task.model ?? ""),
  };
}

/**
 * Why the editor cannot save a draft, as a toast's title and text; null when
 * it can. `hasProject`: a new task's project is listed; an edit keeps its
 * project (the update sends none). `hasSecret`: the node keeps a secret.
 */
export function draftProblem(
  draft: DraftState,
  context: { readonly hasProject: boolean; readonly hasSecret: boolean },
): { readonly title: string; readonly description: string } | null {
  if (
    !draft.title.trim() ||
    !draft.prompt.trim() ||
    (draft.editingId === null && !context.hasProject)
  ) {
    return {
      title: "Scheduled task is incomplete",
      description: "Add a title, prompt and project.",
    };
  }
  if (
    draft.threadId === "" &&
    draft.workspaceMode === "existing_worktree" &&
    !draft.existingWorktreePath.trim()
  ) {
    return {
      title: "Checkout path is required",
      description: "Enter the path of the checkout to run in.",
    };
  }
  const schedule = scheduleFromDraft(draft);
  if (
    schedule.type === "webhook" &&
    schedule.signature &&
    (!schedule.signature.header || (!schedule.signature.secret && !context.hasSecret))
  ) {
    return {
      title: "Signing secret is required",
      description: "Enter the signature header and secret.",
    };
  }
  // The node refuses anything shorter (MIN_INTERVAL_MS); no task can have one.
  if (
    schedule.type === "interval" &&
    (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_INTERVAL_MS)
  ) {
    return { title: "Invalid interval", description: "Enter an interval of at least one minute." };
  }
  return null;
}
