// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/scheduledTasks/ScheduledTaskService.ts and webhookRoute.ts at
// v0.1.1-nightly.20261020.3411: what a run re-checks before it fires, its bookkeeping, the
// recovery of runs a restart cut short, missed fixed-time runs, keeping the pending run on
// edits that leave the schedule alone, webhook tokens, rate limits, the per-task delivery
// queue and log, and the answers of the webhook route.
import * as Crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { THREADS_STREAM, ThreadEvents, ceilingOf } from "@jhin/agent-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import {
  CreateTaskInput,
  Delivery,
  DeliverySummary,
  SCHEDULER_CAPABILITY,
  SCHEDULER_STREAM,
  ScheduledTask,
  SchedulerEvents,
  UpdateTaskInput,
  WEBHOOK_ROUTE_PREFIX,
  isMissedFixedTimeRun,
  isSameSchedule,
  nextRunAfter,
  type DeliveryOutcome,
  type Schedule,
  type ScheduleInput,
  type SchedulerService,
  type WorkspaceStrategy,
} from "@jhin/scheduler-api";
import {
  definePlugin,
  holdsPermission,
  z,
  type Invocation,
  type PluginContext,
  describePermissions,
} from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";
import { SECRETS_STORE_CAPABILITY, SecretsError, type SecretStore } from "@jhin/secrets-api";

import { constantTimeEquals, verifyWebhookSignature } from "./signature.ts";
import { redactHeaders, redactQuery, renderWebhookPrompt } from "./template.ts";

const NAMESPACE = "jhin.scheduler";

/** The project a task without one runs in (D51). */
const SCRATCH_PROJECT = "scratch";

/** The scheduler looks again at least this often, so a clock that jumped is caught up. */
const MAX_TIMER_MS = 60_000;

const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const WEBHOOK_DELIVERY_RETENTION = 50;
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
/** Accepted deliveries per task per minute. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

const DEFAULT_TITLE = "Scheduled task";

export class SchedulerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** A task as kept: the public record without its endpoint, plus the webhook's credentials. */
type StoredTask = Omit<ScheduledTask, "webhook"> & {
  readonly webhookToken?: string;
  readonly webhookSecret?: string;
};

type Trigger = "scheduled" | "manual" | "webhook";

interface RunResult {
  readonly task: ScheduledTask;
  readonly threadId: string | null;
}

const iso = (time: number | Date) => new Date(time).toISOString();

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const notFound = (id: string) =>
  new SchedulerError("TASK_NOT_FOUND", `No scheduled task ${id}`, { id });

function titleFrom(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine.slice(0, 80) : DEFAULT_TITLE;
}

function nextRunAt(task: Pick<StoredTask, "enabled" | "schedule">, from: number): string | null {
  if (!task.enabled) return null;
  const next = nextRunAfter(task.schedule, new Date(from));
  return next === null || !Number.isFinite(next.getTime()) ? null : iso(next);
}

/** A stored schedule: a webhook's signature without its secret. */
function storedSchedule(input: ScheduleInput): Schedule {
  if (input.type !== "webhook") return input;
  const signature = input.signature ?? null;
  return {
    type: "webhook",
    signature:
      signature === null
        ? null
        : {
            header: signature.header.toLowerCase(),
            encoding: signature.encoding,
            prefix: signature.prefix,
          },
  };
}

/**
 * The webhook credentials a save keeps: a token kept from before or a new one,
 * and the secret given now, else the one kept (D386).
 */
function webhookCredentials(
  input: ScheduleInput,
  existing: StoredTask | undefined,
): Pick<StoredTask, "webhookToken" | "webhookSecret"> {
  if (input.type !== "webhook") return {};
  const token = existing?.webhookToken ?? Crypto.randomBytes(32).toString("hex");
  const signature = input.signature ?? null;
  if (signature === null) return { webhookToken: token };
  const secret = signature.secret ?? existing?.webhookSecret;
  if (secret === undefined) {
    throw new SchedulerError(
      "SECRET_REQUIRED",
      "A webhook signature check needs a signing secret.",
    );
  }
  return { webhookToken: token, webhookSecret: secret };
}

export default definePlugin({
  activate(context) {
    activateScheduler(context);
  },
});

function activateScheduler(context: PluginContext): void {
  const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
  const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
  const http = context.services.tryGet<HttpServer>(HTTP_SERVER_CAPABILITY);
  // Its events are the tasks, prompts included: reading them takes scheduler.read (security.md D415).
  const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
  if (live?.guard !== undefined) {
    context.subscriptions.add(live.guard(SCHEDULER_STREAM, ["scheduler.read"]));
  }
  let stopped = false;

  /** Accepted webhook requests of each task's last minute (D388). */
  const rateWindows = new Map<string, { accepted: number[]; rejectedLogged: boolean }>();
  /** When each task last logged a request with a bad signature. */
  const forgedLogged = new Map<string, number>();

  // --- Storage -------------------------------------------------------------

  const taskKey = (id: string) => `task/${id}`;
  const deliveryPrefix = (taskId: string) => `delivery/${taskId}/`;

  const webhookEndpoint = (task: StoredTask, withToken: boolean): ScheduledTask["webhook"] => {
    if (task.schedule.type !== "webhook" || task.webhookToken === undefined) return undefined;
    const path = withToken
      ? `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(task.id)}/${task.webhookToken}`
      : null;
    return {
      path,
      url: http === undefined || path === null ? null : `${http.url.replace(/\/+$/, "")}${path}`,
      hasSecret: task.webhookSecret !== undefined,
    };
  };

  /**
   * A task as callers see it. The webhook's URL token is a right to run the
   * task, so it goes only to callers that may change tasks (`withToken`).
   */
  const toPublic = (task: StoredTask, withToken = true): ScheduledTask => {
    const { webhookToken: _token, webhookSecret: _secret, ...rest } = task;
    const webhook = webhookEndpoint(task, withToken);
    return ScheduledTask.parse(webhook === undefined ? rest : { ...rest, webhook });
  };

  const load = async (id: string): Promise<StoredTask | undefined> =>
    (await kv.get(NAMESPACE, taskKey(id))) as StoredTask | undefined;

  const loadAll = async (): Promise<StoredTask[]> =>
    (await kv.list(NAMESPACE, { prefix: "task/" })).map(({ value }) => value as StoredTask);

  /** Writes a task and tells clients; the timer is re-armed. */
  const save = async (task: StoredTask): Promise<ScheduledTask> => {
    await kv.set(NAMESPACE, taskKey(task.id), task as unknown as Json);
    // Whoever may read the stream may not run the task: no URL token in it.
    await log.append(SCHEDULER_STREAM, [
      { type: SchedulerEvents.taskUpdated, payload: toPublic(task, false) as unknown as Json },
    ]);
    arm();
    return toPublic(task);
  };

  /** Changes to one task run one at a time, so none writes over another. */
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    locks.set(id, tail);
    void tail.then(() => {
      if (locks.get(id) === tail) locks.delete(id);
    });
    return next;
  };

  /** Applies `change` to the task as it is now; undefined from `change` writes nothing. */
  const mutate = (
    id: string,
    change: (task: StoredTask) => StoredTask | undefined | Promise<StoredTask | undefined>,
  ): Promise<StoredTask | undefined> =>
    locked(id, async () => {
      const current = await load(id);
      if (current === undefined) return undefined;
      const next = await change(current);
      if (next === undefined) return current;
      await save(next);
      return next;
    });

  const removeTask = (id: string, guard?: Guard): Promise<boolean> =>
    locked(id, async () => {
      if (guard !== undefined) {
        const current = await load(id);
        if (current !== undefined) await guard(current);
      }
      const removed = await kv.delete(NAMESPACE, taskKey(id));
      if (!removed) return false;
      for (const { key } of await kv.list(NAMESPACE, { prefix: deliveryPrefix(id) })) {
        await kv.delete(NAMESPACE, key);
      }
      rateWindows.delete(id);
      forgedLogged.delete(id);
      retries.delete(id);
      await log.append(SCHEDULER_STREAM, [{ type: SchedulerEvents.taskDeleted, payload: { id } }]);
      arm();
      return true;
    });

  /**
   * Accepted deliveries whose run has not started yet carry `pending` in
   * storage (never shown): a node that stops before the run marks them
   * failed on its next start, as it does with runs.
   */
  type KeptDelivery = Delivery & { readonly pending?: true };
  /** Deliveries this activation accepted: the recovery leaves them alone. */
  const ownDeliveries = new Set<string>();
  /** Once the recovery is done it needs no list of this activation's deliveries. */
  let recoveringDeliveries = true;

  const markDeliveryFailed = async (key: string, error: string) => {
    const delivery = (await kv.get(NAMESPACE, key)) as KeptDelivery | undefined;
    if (delivery === undefined) return;
    const { pending: _pending, ...rest } = delivery;
    await kv.set(NAMESPACE, key, {
      ...rest,
      outcome: "dispatch_failed",
      error,
    } as unknown as Json);
  };

  // --- Threads -------------------------------------------------------------

  context.subscriptions.add(
    log.subscribe(THREADS_STREAM, (event) => {
      if (event.type !== ThreadEvents.threadDeleted) return;
      const threadId = (event.payload as { id?: unknown } | null)?.id;
      if (typeof threadId === "string") void deleteForThread(threadId);
    }),
  );

  /** A thread's tasks go with it (T3 #22070). */
  const deleteForThread = async (threadId: string) => {
    try {
      for (const task of await loadAll()) {
        if (task.threadId === threadId) await removeTask(task.id);
      }
    } catch (error) {
      context.log.warn("could not delete the tasks of a deleted thread", {
        threadId,
        error: messageOf(error),
      });
    }
  };

  const execute = <T>(name: string, input: unknown): Promise<T> =>
    context.commands.execute(name, input) as Promise<T>;

  /**
   * Where a run goes (D383). `onThread` hears the thread as soon as it is
   * known, so a new thread whose first message failed is still reported.
   */
  const dispatch = async (
    task: StoredTask,
    prompt: string,
    messageId: string,
    onThread: (threadId: string) => void,
  ): Promise<void> => {
    // A bound run goes into the thread's queue (W1, D201), as T3 sends in
    // `queue` mode: it starts at once on a free thread, else after the turns
    // queued before it. The message id is the run's, so a retry queues it once.
    if (task.threadId !== null) {
      onThread(task.threadId);
      await execute("threads.queue.add", { threadId: task.threadId, text: prompt, messageId });
      return;
    }
    const settings = {
      ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
      ...(task.model === undefined ? {} : { model: task.model }),
      ...(task.modelOptions === undefined ? {} : { modelOptions: task.modelOptions }),
      ...(task.runtimeMode === undefined ? {} : { runtimeMode: task.runtimeMode }),
      ...(task.interactionMode === undefined ? {} : { interactionMode: task.interactionMode }),
    };
    // A plain project checkout is the default; anything else is the run's own workspace (D983).
    const strategy = task.workspaceStrategy;
    const plainRoot =
      strategy === undefined || (strategy.type === "root" && strategy.branch === undefined);
    const thread = await execute<{ id: string }>("threads.create", {
      projectId: task.projectId,
      title: task.title,
      ...settings,
      ...(plainRoot ? {} : { workspace: strategy }),
    });
    onThread(thread.id);
    await execute("threads.send", { threadId: thread.id, text: prompt, ...settings });
  };

  // --- Runs ----------------------------------------------------------------

  const activeRuns = new Map<string, Promise<unknown>>();
  /** Numbers this activation's runs, for their message ids. */
  let runSequence = 0;

  /**
   * Runs a task once. The task is read again first: deleted, paused or
   * postponed since it came due, it does not fire (T3's runTask).
   */
  const runTask = (
    id: string,
    trigger: Trigger,
    webhook?: { readonly prompt: string; readonly createdAt: string },
    guard?: Guard,
  ): Promise<RunResult | undefined> => {
    if (activeRuns.has(id)) {
      if (trigger === "scheduled") return Promise.resolve(undefined);
      return Promise.reject(
        new SchedulerError("RUN_IN_PROGRESS", "The scheduled task is already running.", { id }),
      );
    }
    const run = (async (): Promise<RunResult | undefined> => {
      // Runs left by a previous start are recovered first, so none of ours is taken for one.
      await recovered;
      const startedAt = Date.now();
      const startedAtIso = iso(startedAt);
      let skipped: SchedulerError | undefined;
      const started = await mutate(id, async (task) => {
        await guard?.(task);
        if (trigger === "scheduled") {
          const due = task.nextRunAt === null ? undefined : Date.parse(task.nextRunAt);
          if (!task.enabled || due === undefined || due > startedAt) {
            skipped = new SchedulerError("NOT_DUE", "The task is not due.");
            return undefined;
          }
        }
        // A queued delivery must not run a task that was replaced, switched to
        // another trigger or paused while it waited.
        if (webhook !== undefined) {
          const reason =
            task.createdAt !== webhook.createdAt
              ? "The task was replaced before this delivery ran."
              : task.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
                : !task.enabled
                  ? "The task was paused before this delivery ran."
                  : undefined;
          if (reason !== undefined) {
            skipped = new SchedulerError("DELIVERY_SKIPPED", reason);
            return undefined;
          }
        }
        return {
          ...task,
          lastRunStatus: "running",
          lastRunAt: startedAtIso,
          updatedAt: startedAtIso,
        };
      });
      if (started === undefined) {
        if (trigger === "manual") throw notFound(id);
        if (webhook !== undefined) {
          throw new SchedulerError(
            "DELIVERY_SKIPPED",
            "The task was deleted before this delivery ran.",
          );
        }
        return undefined;
      }
      if (skipped !== undefined) {
        if (trigger === "scheduled") return undefined;
        throw skipped;
      }

      let threadId: string | null = null;
      let error: string | null = null;
      try {
        // Unique per run, even for two runs in one millisecond.
        const messageId = `scheduled:${id.slice(0, 64)}:${startedAt}-${++runSequence}`;
        await dispatch(started, webhook?.prompt ?? started.prompt, messageId, (thread) => {
          threadId = thread;
        });
      } catch (cause) {
        error = messageOf(cause);
        context.log.warn("a scheduled task's run failed", { taskId: id, trigger, error });
      }
      const completedAt = Date.now();
      // Only the run this one marked: a task deleted and recreated meanwhile is not stamped.
      let stamped = false;
      const completed = await mutate(id, (current) => {
        stamped = current.lastRunStatus === "running" && current.lastRunAt === startedAtIso;
        return stamped
          ? {
              ...current,
              updatedAt: iso(completedAt),
              nextRunAt: nextRunAt(current, completedAt),
              lastRunStatus: error === null ? "succeeded" : "failed",
              lastRunError: error,
              lastRunThreadId: threadId,
              runCount: current.runCount + 1,
            }
          : undefined;
      });
      // Deleted (or deleted and made again) meanwhile: this run's own outcome.
      const shown: StoredTask = (stamped ? completed : undefined) ?? {
        ...started,
        lastRunStatus: error === null ? "succeeded" : "failed",
        lastRunError: error,
        lastRunThreadId: threadId,
        runCount: started.runCount + 1,
      };
      return { task: toPublic(shown), threadId: error === null ? threadId : null };
    })();
    activeRuns.set(id, run);
    void run
      .finally(() => {
        if (activeRuns.get(id) === run) activeRuns.delete(id);
        arm();
      })
      .catch(() => undefined);
    return run;
  };

  /** Only the run judged missed: an update, pause or run since then wins. */
  const rescheduleMissed = (id: string, now: number, missedRunAt: string) =>
    mutate(id, (task) => {
      if (!task.enabled || task.lastRunStatus === "running" || task.nextRunAt !== missedRunAt) {
        return undefined;
      }
      context.log.info("skipping a missed scheduled task run", {
        taskId: id,
        missedRunAt: task.nextRunAt,
      });
      return { ...task, nextRunAt: nextRunAt(task, now), updatedAt: iso(now) };
    });

  // --- The timer (D382) ----------------------------------------------------

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> | undefined;
  let tickAgain = false;

  /**
   * Tasks whose run could not even start (storage failing): tried again after
   * a wait that doubles up to a minute, not on every tick.
   */
  const retries = new Map<string, { failures: number; at: number }>();

  /** When a task is next due, counting a wait after failed starts. */
  const dueTime = (task: StoredTask): number =>
    Math.max(Date.parse(task.nextRunAt ?? ""), retries.get(task.id)?.at ?? 0);

  const tick = async () => {
    const now = Date.now();
    for (const task of await loadAll()) {
      if (!task.enabled || task.nextRunAt === null || task.lastRunStatus === "running") continue;
      const dueAt = Date.parse(task.nextRunAt);
      if (!(dueTime(task) <= now)) continue;
      if (isMissedFixedTimeRun(task.schedule, new Date(dueAt), new Date(now))) {
        await rescheduleMissed(task.id, now, task.nextRunAt);
        continue;
      }
      // Runs go side by side: one waiting for its thread holds no other.
      void runTask(task.id, "scheduled").then(
        () => retries.delete(task.id),
        (error: unknown) => {
          const failures = (retries.get(task.id)?.failures ?? 0) + 1;
          retries.set(task.id, {
            failures,
            at: Date.now() + Math.min(MAX_TIMER_MS, 1000 * 2 ** (failures - 1)),
          });
          context.log.warn("a scheduled task's run could not start", {
            taskId: task.id,
            failures,
            error: messageOf(error),
          });
        },
      );
    }
  };

  const runTick = () => {
    if (stopped) return;
    if (ticking !== undefined) {
      tickAgain = true;
      return;
    }
    ticking = tick()
      .catch((error: unknown) =>
        context.log.warn("could not run due scheduled tasks", { error: messageOf(error) }),
      )
      .finally(() => {
        ticking = undefined;
        if (tickAgain) {
          tickAgain = false;
          runTick();
        } else {
          arm();
        }
      });
  };

  let arming: Promise<void> | undefined;
  let armAgain = false;

  /** Sets the timer for the earliest pending run, at most a minute away. */
  function arm(): void {
    if (stopped) return;
    if (arming !== undefined) {
      armAgain = true;
      return;
    }
    arming = (async () => {
      const tasks = await loadAll();
      let earliest = Number.POSITIVE_INFINITY;
      for (const task of tasks) {
        if (!task.enabled || task.nextRunAt === null || task.lastRunStatus === "running") continue;
        earliest = Math.min(earliest, dueTime(task));
      }
      if (stopped) return;
      clearTimeout(timer);
      timer = undefined;
      if (!Number.isFinite(earliest)) return;
      const delay = Math.min(Math.max(0, earliest - Date.now()), MAX_TIMER_MS);
      timer = setTimeout(() => {
        timer = undefined;
        runTick();
      }, delay);
      timer.unref?.();
    })()
      .catch((error: unknown) =>
        context.log.warn("could not set the scheduler's timer", { error: messageOf(error) }),
      )
      .finally(() => {
        arming = undefined;
        if (armAgain) {
          armAgain = false;
          arm();
        }
      });
  }

  // Runs a restart cut short: recorded as failed and rescheduled (T3).
  const recovered = (async () => {
    const now = Date.now();
    // Deliveries answered 202 whose run never started: the sender is told nothing
    // more, but the log says so.
    for (const { key, value } of await kv.list(NAMESPACE, { prefix: "delivery/" })) {
      if ((value as unknown as KeptDelivery).pending !== true || ownDeliveries.has(key)) continue;
      await markDeliveryFailed(key, "The node stopped before this delivery ran.");
    }
    recoveringDeliveries = false;
    ownDeliveries.clear();
    for (const task of await loadAll()) {
      if (task.lastRunStatus !== "running") continue;
      await mutate(task.id, (current) =>
        current.lastRunStatus === "running" && !activeRuns.has(current.id)
          ? {
              ...current,
              lastRunStatus: "failed",
              lastRunError: "Run was interrupted by a node restart.",
              nextRunAt: nextRunAt(current, now),
              updatedAt: iso(now),
              runCount: current.runCount + 1,
            }
          : undefined,
      );
    }
  })()
    .catch((error: unknown) =>
      context.log.warn("could not recover interrupted scheduled task runs", {
        error: messageOf(error),
      }),
    )
    .finally(() => arm());

  context.onDeactivate(async () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    await recovered;
    await Promise.allSettled([...activeRuns.values(), ticking, arming]);
    // Deliveries still queued are marked failed, not run.
    await Promise.allSettled([...webhookQueues.values()].map((queue) => queue.tail));
  });

  // --- Operations ----------------------------------------------------------

  const getTask = async (id: string): Promise<StoredTask> => {
    const task = await load(id);
    if (task === undefined) throw notFound(id);
    return task;
  };

  /** What a task takes from the thread an agent calls from (D1177). */
  interface CallingThread {
    readonly id: string;
    readonly projectId: string;
    readonly agentId?: string;
    readonly model?: string;
    readonly modelOptions?: { id: string; value: string | boolean }[];
    readonly runtimeMode?: CreateTaskInput["runtimeMode"];
    readonly interactionMode?: CreateTaskInput["interactionMode"];
  }
  const callingThread = async (threadId: string): Promise<CallingThread> =>
    (await execute<{ thread: CallingThread }>("threads.get", { threadId })).thread;
  const invalid = (message: string) => new SchedulerError("INVALID_REQUEST", message, {});
  const NEEDS_THREAD = "bindToCurrentThread needs an agent running inside a Jhin thread.";
  const OTHER_PROJECT =
    "bindToCurrentThread binds to this thread, which belongs to a different project.";
  /** T3's scheduledTaskWorkspaceStrategy: the checkout when bound, else a worktree of main. */
  const workspaceFor = (bound: boolean): WorkspaceStrategy =>
    bound ? { type: "root" } : { type: "worktree", baseRef: "main", startFromOrigin: true };

  /**
   * A create from an agent's thread (D1177): the thread's project, bound to it
   * by default, with T3's workspace and the thread's agent settings for what the
   * call leaves out. Without a calling thread only `threadId` binds.
   */
  const bindToCaller = async (
    given: CreateTaskInput,
    raw: z.input<typeof CreateTaskInput>,
    callerThreadId: string | undefined,
  ): Promise<CreateTaskInput> => {
    let input = given;
    const namedThread = typeof raw.threadId === "string";
    // `threadId: null` asks for a fresh thread per run: from a thread, unbound.
    if (raw.threadId === null && input.bindToCurrentThread === undefined) {
      input = { ...input, bindToCurrentThread: false };
    }
    if (input.bindToCurrentThread !== undefined && namedThread) {
      throw invalid("Give threadId or bindToCurrentThread, not both.");
    }
    if (callerThreadId === undefined) {
      if (input.bindToCurrentThread === true) throw invalid(NEEDS_THREAD);
      return input;
    }
    if (namedThread) {
      // Posting into another thread, it still runs at the caller's modes for what it leaves
      // out (D1352): the ceiling is the caller's.
      const caller = await callingThread(callerThreadId);
      return {
        ...input,
        ...(input.runtimeMode === undefined && caller.runtimeMode !== undefined
          ? { runtimeMode: caller.runtimeMode }
          : {}),
        ...(input.interactionMode === undefined && caller.interactionMode !== undefined
          ? { interactionMode: caller.interactionMode }
          : {}),
      };
    }
    const caller = await callingThread(callerThreadId);
    const projectId = input.projectId ?? caller.projectId;
    const bound = input.bindToCurrentThread ?? projectId === caller.projectId;
    if (bound && projectId !== caller.projectId) throw invalid(OTHER_PROJECT);
    const sameAgent = input.agentId === undefined || input.agentId === caller.agentId;
    return {
      ...input,
      projectId,
      threadId: bound ? caller.id : null,
      workspaceStrategy: input.workspaceStrategy ?? workspaceFor(bound),
      ...(input.agentId === undefined && caller.agentId !== undefined
        ? { agentId: caller.agentId }
        : {}),
      ...(input.model === undefined && sameAgent && caller.model !== undefined
        ? { model: caller.model }
        : {}),
      ...(input.modelOptions === undefined &&
      sameAgent &&
      (input.model === undefined || input.model === caller.model) &&
      caller.modelOptions !== undefined
        ? { modelOptions: caller.modelOptions }
        : {}),
      ...(input.runtimeMode === undefined && caller.runtimeMode !== undefined
        ? { runtimeMode: caller.runtimeMode }
        : {}),
      ...(input.interactionMode === undefined && caller.interactionMode !== undefined
        ? { interactionMode: caller.interactionMode }
        : {}),
    };
  };

  // --- The calling thread's ceiling (D1352) -----------------------------------

  type RuntimeModeName = NonNullable<CreateTaskInput["runtimeMode"]>;
  type InteractionModeName = NonNullable<CreateTaskInput["interactionMode"]>;
  /** T3's ranks; a mode left out runs at the node's default, the broadest. */
  const RUNTIME_RANK: Record<RuntimeModeName, number> = {
    "approval-required": 0,
    "auto-accept-edits": 1,
    "full-access": 2,
  };
  const INTERACTION_RANK: Record<InteractionModeName, number> = { plan: 0, default: 1 };
  interface Modes {
    readonly runtimeMode?: RuntimeModeName | undefined;
    readonly interactionMode?: InteractionModeName | undefined;
  }
  const runtimeRank = (mode: RuntimeModeName | undefined) =>
    mode === undefined ? RUNTIME_RANK["full-access"] : RUNTIME_RANK[mode];
  const interactionRank = (mode: InteractionModeName | undefined) =>
    mode === undefined ? INTERACTION_RANK.default : INTERACTION_RANK[mode];

  /**
   * The modes of the thread an agent calls from, and the runtime mode ceiling
   * its grants name (security.md D1370): no task of its may run broader.
   */
  const callerLimits = async (
    callerThreadId: string | undefined,
    grants?: readonly string[],
  ): Promise<Modes | undefined> => {
    const thread = callerThreadId === undefined ? undefined : await callingThread(callerThreadId);
    const ceiling = ceilingOf(grants);
    if (ceiling === undefined) return thread;
    const runtimeMode =
      thread === undefined || runtimeRank(thread.runtimeMode) > RUNTIME_RANK[ceiling]
        ? ceiling
        : thread.runtimeMode;
    return { ...thread, runtimeMode };
  };

  /** What a task's runs execute at: its own modes, and its bound thread's (T3's run modes). */
  const runModes = async (task: Modes & { readonly threadId: string | null }) => {
    const modes: Modes[] = [task];
    if (task.threadId !== null) {
      // A thread that is gone posts nothing; any other failure refuses rather than lets through.
      const bound = await callingThread(task.threadId).catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === "THREAD_NOT_FOUND") return undefined;
        throw error;
      });
      if (bound !== undefined) modes.push(bound);
    }
    return modes;
  };

  /**
   * Refuses modes broader than the calling thread's, as T3's `resolveRuntimeMode` and
   * `resolveInteractionMode` do for its MCP caller's limits.
   */
  const assertWithin = (limits: Modes | undefined, modes: readonly Modes[]) => {
    if (limits === undefined) return;
    for (const mode of modes) {
      if (runtimeRank(mode.runtimeMode) > runtimeRank(limits.runtimeMode)) {
        const requested = mode.runtimeMode ?? "full-access";
        const limit = limits.runtimeMode ?? "full-access";
        throw new SchedulerError(
          "RUNTIME_MODE_ESCALATION_DENIED",
          `Scheduled task runtime mode ${requested} is broader than this thread's mode ${limit}.`,
          { requested, limit },
        );
      }
      if (interactionRank(mode.interactionMode) > interactionRank(limits.interactionMode)) {
        const requested = mode.interactionMode ?? "default";
        const limit = limits.interactionMode ?? "default";
        throw new SchedulerError(
          "INTERACTION_MODE_ESCALATION_DENIED",
          `Scheduled task interaction mode ${requested} is broader than this thread's mode ${limit}.`,
          { requested, limit },
        );
      }
    }
  };
  const within = (limits: Modes | undefined, modes: readonly Modes[]) => {
    try {
      assertWithin(limits, modes);
      return true;
    } catch (error) {
      if (error instanceof SchedulerError && error.code.endsWith("_ESCALATION_DENIED"))
        return false;
      throw error;
    }
  };

  /**
   * Whether the calling thread sees a task's webhook URL (D1352): not when the task runs
   * broader, nor when its bound thread cannot be read, so one failed read hides one URL instead
   * of failing the whole list.
   */
  const urlShown = async (
    limits: Modes | undefined,
    task: Modes & { readonly id: string; readonly threadId: string | null },
  ) => {
    if (limits === undefined) return true;
    const modes = await runModes(task).catch((error: unknown) => {
      context.log.warn("hid a task's webhook URL: its bound thread could not be read", {
        taskId: task.id,
        threadId: task.threadId,
        error: String(error),
      });
      return undefined;
    });
    return modes !== undefined && within(limits, modes);
  };

  /** Checks a task as it is under its lock, before what changes, runs or deletes it. */
  type Guard = (task: StoredTask) => Promise<void>;
  /**
   * The calling thread's guard: a task it may change, run or delete runs no broader than it.
   * Undefined without a calling thread.
   */
  const guardFor = async (
    callerThreadId: string | undefined,
    grants?: readonly string[],
  ): Promise<Guard | undefined> => {
    const limits = await callerLimits(callerThreadId, grants);
    return limits === undefined
      ? undefined
      : async (task) => assertWithin(limits, await runModes(task));
  };

  const threadProject = async (threadId: string): Promise<string> => {
    const { thread } = await execute<{ thread: { projectId: string } }>("threads.get", {
      threadId,
    });
    return thread.projectId;
  };

  /**
   * A webhook signature's `secretRef` consumed for `projectId` (D1034): the
   * value takes the place of `secret`, which a ref, when given, overrides.
   */
  const redeem = (schedule: ScheduleInput, projectId: string): ScheduleInput => {
    if (schedule.type !== "webhook" || schedule.signature?.secretRef === undefined) {
      return schedule;
    }
    const store = context.services.tryGet<SecretStore>(SECRETS_STORE_CAPABILITY);
    if (store === undefined) throw new SecretsError("SECRET_STORE_UNAVAILABLE");
    const { secretRef, secret: _secret, ...signature } = schedule.signature;
    return {
      ...schedule,
      signature: { ...signature, secret: store.consumeRef({ ref: secretRef, projectId }) },
    };
  };

  const create = async (
    raw: z.input<typeof CreateTaskInput>,
    callerId = "",
    callerThreadId?: string,
    grants?: readonly string[],
  ): Promise<ScheduledTask> => {
    const bound = await bindToCaller(CreateTaskInput.parse(raw), raw, callerThreadId);
    const input = { ...bound, threadId: bound.threadId ?? null };
    // From a thread, no wider than that thread runs (D1352), nor than the caller's ceiling (D1370).
    assertWithin(await callerLimits(callerThreadId, grants), await runModes(input));
    // A retried create names the task it made: its id comes from the caller
    // and the request's id, so another caller's id never finds it.
    const id =
      input.clientRequestId === undefined
        ? Crypto.randomUUID()
        : `request-${Crypto.createHash("sha256")
            .update(JSON.stringify([callerId, input.clientRequestId]))
            .digest("hex")
            .slice(0, 32)}`;
    const previous = input.clientRequestId === undefined ? undefined : await load(id);
    if (previous !== undefined) return toPublic(previous);
    let projectId = input.projectId ?? SCRATCH_PROJECT;
    if (input.threadId === null) {
      // A project that is not there would only fail at run time, after a webhook said 202.
      const projects = await execute<{ id: string }[]>("projects.list", {});
      if (!projects.some((project) => project.id === projectId)) {
        throw new SchedulerError("PROJECT_NOT_FOUND", `No project ${projectId}`, { projectId });
      }
    } else {
      const owner = await threadProject(input.threadId);
      if (input.projectId !== undefined && input.projectId !== owner) {
        throw new SchedulerError(
          "PROJECT_MISMATCH",
          `Thread ${input.threadId} belongs to project ${owner}, not ${input.projectId}`,
          { threadId: input.threadId, projectId: owner },
        );
      }
      projectId = owner;
    }
    const build = (scheduleInput: ScheduleInput): StoredTask => {
      const now = Date.now();
      const schedule = storedSchedule(scheduleInput);
      const task: StoredTask = {
        id,
        title: input.title ?? titleFrom(input.prompt),
        prompt: input.prompt,
        enabled: input.enabled,
        schedule,
        projectId,
        threadId: input.threadId,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.modelOptions === undefined ? {} : { modelOptions: input.modelOptions }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
        ...(input.workspaceStrategy === undefined
          ? {}
          : { workspaceStrategy: input.workspaceStrategy }),
        createdAt: iso(now),
        updatedAt: iso(now),
        nextRunAt: nextRunAt({ enabled: input.enabled, schedule }, now),
        lastRunAt: null,
        lastRunStatus: "never",
        lastRunError: null,
        lastRunThreadId: null,
        runCount: 0,
        ...webhookCredentials(scheduleInput, undefined),
      };
      return task;
    };
    return locked(id, async () => {
      // Two tries of one request at once create the task once, and use a
      // secretRef once: it is consumed only by the try that writes (D1034).
      const raced = await load(id);
      return raced === undefined ? save(build(redeem(input.schedule, projectId))) : toPublic(raced);
    });
  };

  const update = async (
    raw: z.input<typeof UpdateTaskInput>,
    callerThreadId?: string,
    grants?: readonly string[],
  ): Promise<ScheduledTask> => {
    let parsed = UpdateTaskInput.parse(raw);
    // From a thread: only a task no broader than it, into modes and a thread no broader (D1352),
    // checked on the task as it is under its lock.
    const limits = await callerLimits(callerThreadId, grants);
    // Moved into the calling thread, or out of any, with T3's workspace (D1177).
    if (parsed.bindToCurrentThread !== undefined) {
      if (parsed.threadId !== undefined) {
        throw invalid("Give threadId or bindToCurrentThread, not both.");
      }
      let threadId: string | null = null;
      if (parsed.bindToCurrentThread) {
        if (callerThreadId === undefined) throw invalid(NEEDS_THREAD);
        const caller = await callingThread(callerThreadId);
        if (caller.projectId !== (await getTask(parsed.id)).projectId) {
          throw invalid(OTHER_PROJECT);
        }
        threadId = caller.id;
      }
      parsed = {
        ...parsed,
        threadId,
        workspaceStrategy: parsed.workspaceStrategy ?? workspaceFor(parsed.bindToCurrentThread),
      };
    }
    const projectId =
      parsed.threadId === undefined || parsed.threadId === null
        ? undefined
        : await threadProject(parsed.threadId);
    const updated = await mutate(parsed.id, async (existing) => {
      if (limits !== undefined) {
        assertWithin(limits, await runModes(existing));
        assertWithin(limits, [
          {
            runtimeMode: parsed.runtimeMode ?? existing.runtimeMode,
            interactionMode: parsed.interactionMode ?? existing.interactionMode,
          },
        ]);
        if (typeof parsed.threadId === "string") {
          assertWithin(limits, [await callingThread(parsed.threadId)]);
        }
      }
      // A ref is consumed for the task's project after this update, under its lock (D1034).
      const input =
        parsed.schedule === undefined
          ? parsed
          : { ...parsed, schedule: redeem(parsed.schedule, projectId ?? existing.projectId) };
      const now = Date.now();
      const enabled = input.enabled ?? existing.enabled;
      // A webhook schedule sent without `signature` keeps the stored check and
      // its secret; only an explicit null removes them.
      const scheduleInput: ScheduleInput | undefined =
        input.schedule?.type === "webhook" &&
        input.schedule.signature === undefined &&
        existing.schedule.type === "webhook"
          ? { ...input.schedule, signature: existing.schedule.signature }
          : input.schedule;
      const schedule =
        scheduleInput === undefined ? existing.schedule : storedSchedule(scheduleInput);
      // Only a change of the schedule or of enabled restarts the clock: an
      // edit of the title or prompt neither postpones nor brings back a run.
      const unchanged = existing.enabled === enabled && isSameSchedule(existing.schedule, schedule);
      const { webhookToken: _token, webhookSecret: _secret, ...rest } = existing;
      const credentials =
        input.schedule === undefined
          ? {
              ...(existing.webhookToken === undefined
                ? {}
                : { webhookToken: existing.webhookToken }),
              ...(existing.webhookSecret === undefined
                ? {}
                : { webhookSecret: existing.webhookSecret }),
            }
          : webhookCredentials(scheduleInput!, existing);
      // null clears the agent (and its model) or the model alone (D984).
      const kept: Partial<typeof rest> = { ...rest };
      if (input.agentId === null) {
        delete kept.agentId;
        delete kept.model;
      }
      if (input.model === null) delete kept.model;
      // Options chosen for another agent or model do not carry over (D297, D1178).
      const otherModel =
        (input.agentId !== undefined && input.agentId !== rest.agentId) ||
        (input.model !== undefined && input.model !== rest.model);
      if (input.modelOptions === null || (otherModel && input.modelOptions === undefined)) {
        delete kept.modelOptions;
      }
      // Another agent without a model of its own takes none of the old agent's.
      if (
        typeof input.agentId === "string" &&
        input.agentId !== rest.agentId &&
        input.model === undefined
      ) {
        delete kept.model;
      }
      return {
        ...(kept as typeof rest),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.agentId === undefined || input.agentId === null
          ? {}
          : { agentId: input.agentId }),
        ...(input.model === undefined || input.model === null ? {} : { model: input.model }),
        ...(input.modelOptions === undefined || input.modelOptions === null
          ? {}
          : { modelOptions: input.modelOptions }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
        ...(input.workspaceStrategy === undefined
          ? {}
          : { workspaceStrategy: input.workspaceStrategy }),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(projectId === undefined ? {} : { projectId }),
        enabled,
        schedule,
        updatedAt: iso(now),
        nextRunAt: unchanged ? existing.nextRunAt : nextRunAt({ enabled, schedule }, now),
        ...credentials,
      };
    });
    if (updated === undefined) throw notFound(parsed.id);
    return toPublic(updated);
  };

  const runNow = async (id: string, guard?: Guard): Promise<RunResult> => {
    const task = await getTask(id);
    // Refused for what it is first; checked again on the task as it starts, under its lock.
    await guard?.(task);
    if (task.schedule.type === "webhook") {
      throw new SchedulerError(
        "WEBHOOK_TASK",
        "Webhook tasks run when their URL receives a request.",
        { id },
      );
    }
    const result = await runTask(id, "manual", undefined, guard);
    if (result === undefined) throw notFound(id);
    return result;
  };

  const rotateWebhookToken = async (id: string, guard?: Guard): Promise<ScheduledTask> => {
    const rotated = await mutate(id, async (task) => {
      await guard?.(task);
      if (task.schedule.type !== "webhook") {
        throw new SchedulerError("NOT_A_WEBHOOK", "Only webhook tasks have a URL token.", { id });
      }
      return {
        ...task,
        webhookToken: Crypto.randomBytes(32).toString("hex"),
        updatedAt: iso(Date.now()),
      };
    });
    if (rotated === undefined) throw notFound(id);
    return toPublic(rotated);
  };

  const list = async (projectId?: string): Promise<ScheduledTask[]> =>
    (await loadAll())
      .filter((task) => projectId === undefined || task.projectId === projectId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((task) => toPublic(task));

  const service: SchedulerService = {
    list,
    get: async (id) => {
      const task = await load(id);
      return task === undefined ? undefined : toPublic(task);
    },
    create: (input) => create(input),
    update,
    delete: removeTask,
    run: runNow,
  };
  context.services.provide(SCHEDULER_CAPABILITY, service);

  // --- Webhooks (D385–D388) ------------------------------------------------

  /** Takes a slot of the task's minute, or says whether this is the window's first refusal. */
  const takeRateSlot = (taskId: string, now: number): "allowed" | "first_rejected" | "rejected" => {
    const previous = rateWindows.get(taskId);
    const accepted = (previous?.accepted ?? []).filter((at) => now - at < 60_000);
    if (accepted.length < WEBHOOK_RATE_LIMIT_PER_MINUTE) {
      rateWindows.set(taskId, { accepted: [...accepted, now], rejectedLogged: false });
      return "allowed";
    }
    const first = !(previous?.rejectedLogged ?? false);
    rateWindows.set(taskId, { accepted, rejectedLogged: true });
    return first ? "first_rejected" : "rejected";
  };

  /** Deliveries waiting for or in their run, per task, and the run they wait behind. */
  const webhookQueues = new Map<
    string,
    { count: number; tail: Promise<unknown>; fullLogged: boolean }
  >();

  /** Orders deliveries of one millisecond as they came. */
  let deliverySequence = 0;
  const deliveryKey = (taskId: string, receivedAt: number, deliveryId: string) =>
    `${deliveryPrefix(taskId)}${String(receivedAt).padStart(15, "0")}-${String(
      (deliverySequence = (deliverySequence + 1) % 1e9),
    ).padStart(9, "0")}/${deliveryId}`;

  const recordDelivery = async (key: string, delivery: Delivery) => {
    await kv.set(NAMESPACE, key, delivery as unknown as Json);
    const kept = await kv.list(NAMESPACE, { prefix: deliveryPrefix(delivery.taskId) });
    for (const { key: old } of kept.slice(
      0,
      Math.max(0, kept.length - WEBHOOK_DELIVERY_RETENTION),
    )) {
      await kv.delete(NAMESPACE, old);
    }
  };

  /** The delivery's run has started: it is no longer pending. */
  const markDeliveryStarted = async (key: string) => {
    const delivery = (await kv.get(NAMESPACE, key)) as KeptDelivery | undefined;
    if (delivery?.pending !== true) return;
    const { pending: _pending, ...rest } = delivery;
    await kv.set(NAMESPACE, key, rest as unknown as Json);
  };

  interface WebhookRequest {
    readonly taskId: string;
    readonly token: string;
    readonly method: string;
    readonly query: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }

  type WebhookAnswer =
    | { readonly status: 202; readonly deliveryId: string }
    | { readonly status: 401 | 404 | 409 | 429; readonly error: string };

  /**
   * The webhook task a URL names, if its token matches. A wrong token answers
   * like an unknown task, so the URL tells nothing.
   */
  const matchHook = async (taskId: string, token: string): Promise<StoredTask | undefined> => {
    const task = await load(taskId);
    return task !== undefined &&
      task.schedule.type === "webhook" &&
      task.webhookToken !== undefined &&
      constantTimeEquals(token, task.webhookToken)
      ? task
      : undefined;
  };

  /** What a request to a task's URL does; the route turns it into an answer. */
  const deliver = async (request: WebhookRequest): Promise<WebhookAnswer> => {
    const task = await matchHook(request.taskId, request.token);
    if (task === undefined || task.schedule.type !== "webhook") {
      return { status: 404, error: "hook_not_found" };
    }
    const schedule = task.schedule;
    const now = Date.now();
    const deliveryId = `delivery:${Crypto.randomUUID()}`;
    const key = deliveryKey(task.id, now, deliveryId);
    const bodyText = new TextDecoder().decode(request.body);
    const path = `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(task.id)}`;
    const entry = (
      outcome: DeliveryOutcome,
      details: {
        signatureVerified?: boolean;
        missing?: readonly string[];
        renderedPrompt?: string;
        error?: string;
      } = {},
    ): Delivery => ({
      id: deliveryId,
      taskId: task.id,
      receivedAt: iso(now),
      method: request.method,
      contentType: request.headers["content-type"] ?? null,
      bodyBytes: request.body.byteLength,
      outcome,
      signatureVerified: details.signatureVerified ?? false,
      missingFields: [...(details.missing ?? [])],
      error: details.error ?? null,
      // The log is readable by anyone who may read tasks: credentials stay out of it.
      query: redactQuery(request.query),
      headers: redactHeaders(request.headers),
      body: bodyText.slice(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT),
      bodyTruncated: bodyText.length > WEBHOOK_DELIVERY_LOG_BODY_LIMIT,
      renderedPrompt: details.renderedPrompt ?? null,
    });

    // The signature goes first: forged requests take none of the minute's
    // slots, so they cannot crowd out signed ones. Only the first forged one
    // of a minute is logged, so a flood cannot push real deliveries out.
    const signature = schedule.signature;
    if (signature !== null) {
      const verified =
        task.webhookSecret !== undefined &&
        verifyWebhookSignature({
          signature,
          secret: task.webhookSecret,
          headers: request.headers,
          body: request.body,
        });
      if (!verified) {
        const lastLogged = forgedLogged.get(task.id);
        if (lastLogged === undefined || now - lastLogged >= 60_000) {
          forgedLogged.set(task.id, now);
          await recordDelivery(key, entry("rejected_signature"));
        }
        return { status: 401, error: "invalid_signature" };
      }
    }
    // Only the first refusal of a window is logged, so a flood cannot push
    // the real deliveries out of the log.
    const slot = takeRateSlot(task.id, now);
    if (slot !== "allowed") {
      if (slot === "first_rejected") await recordDelivery(key, entry("rate_limited"));
      return { status: 429, error: "rate_limited" };
    }
    if (!task.enabled) {
      await recordDelivery(key, entry("disabled"));
      return { status: 409, error: "hook_disabled" };
    }
    const rendered = renderWebhookPrompt(
      task.prompt,
      {
        method: request.method,
        path,
        query: request.query,
        headers: request.headers,
        bodyText,
      },
      Crypto.randomBytes(6).toString("hex"),
    );
    // A stuck task cannot pile up deliveries.
    const queue = webhookQueues.get(task.id) ?? {
      count: 0,
      tail: Promise.resolve(),
      fullLogged: false,
    };
    if (queue.count >= WEBHOOK_MAX_QUEUED_PER_TASK) {
      // Logged once until the queue moves again, like the minute's limit.
      if (!queue.fullLogged) {
        queue.fullLogged = true;
        await recordDelivery(
          key,
          entry("rate_limited", {
            signatureVerified: signature !== null,
            error: `${WEBHOOK_MAX_QUEUED_PER_TASK} deliveries are already waiting for this task.`,
          }),
        );
      }
      return { status: 429, error: "rate_limited" };
    }
    queue.count += 1;
    webhookQueues.set(task.id, queue);
    try {
      if (recoveringDeliveries) ownDeliveries.add(key);
      await recordDelivery(key, {
        ...entry("accepted", {
          signatureVerified: signature !== null,
          missing: rendered.missing,
          renderedPrompt: rendered.prompt,
        }),
        pending: true,
      } as KeptDelivery);
    } catch (error) {
      // Not recorded, so not queued: nothing of it stays behind.
      queue.count -= 1;
      ownDeliveries.delete(key);
      if (queue.count === 0 && webhookQueues.get(task.id) === queue) {
        webhookQueues.delete(task.id);
      }
      throw error;
    }
    // Deliveries of a task run one after another, each after the run before it.
    const run = queue.tail.then(async () => {
      if (stopped) {
        await markDeliveryFailed(key, "The scheduler stopped before this delivery ran.");
        return;
      }
      // A manual or scheduled run of the task goes first, and any that starts meanwhile.
      while (activeRuns.has(task.id)) await activeRuns.get(task.id)?.catch(() => undefined);
      try {
        const result = await runTask(task.id, "webhook", {
          prompt: rendered.prompt,
          createdAt: task.createdAt,
        });
        if (result?.task.lastRunStatus === "failed") {
          await markDeliveryFailed(key, "The run failed to start.");
        } else {
          await markDeliveryStarted(key);
        }
      } catch (error) {
        await markDeliveryFailed(
          key,
          error instanceof SchedulerError && error.code === "DELIVERY_SKIPPED"
            ? error.message
            : "The run failed to start.",
        );
      }
    });
    queue.tail = run.catch(() => undefined);
    void queue.tail.then(() => {
      queue.count -= 1;
      queue.fullLogged = false;
      if (queue.count === 0 && webhookQueues.get(task.id) === queue) {
        webhookQueues.delete(task.id);
      }
    });
    return { status: 202, deliveryId };
  };

  if (http !== undefined) {
    const answer = (response: ServerResponse, status: number, body: Record<string, string>) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const handler = async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://node");
      const [taskId, token, ...rest] = url.pathname
        .slice(WEBHOOK_ROUTE_PREFIX.length + 1)
        .split("/")
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return "";
          }
        });
      // The token is checked before the body is read: a wrong one costs no upload.
      let hook: StoredTask | undefined;
      try {
        hook = !taskId || !token || rest.length > 0 ? undefined : await matchHook(taskId, token);
      } catch (error) {
        context.log.warn("a webhook delivery failed", { taskId, error: messageOf(error) });
        answer(response, 500, { error: "internal_error" });
        request.resume();
        return;
      }
      if (hook === undefined) {
        answer(response, 404, { error: "hook_not_found" });
        request.resume();
        return;
      }
      const declared = request.headers["content-length"] ?? "0";
      // A length that is no whole number is a bad request, not a large one.
      if (!/^\d+$/.test(declared)) {
        answer(response, 400, { error: "bad_content_length" });
        request.resume();
        return;
      }
      if (Number(declared) > WEBHOOK_MAX_BODY_BYTES) {
        answer(response, 413, { error: "body_too_large" });
        request.resume();
        return;
      }
      // Chunked requests carry no content-length, so the reader itself is capped.
      // Past the cap the answer goes out at once and the rest is drained,
      // not read, and the connection closed after it: the request is never
      // torn down under the 413.
      const body = await new Promise<Buffer | "too_large" | "unreadable">((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const onData = (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= WEBHOOK_MAX_BODY_BYTES) {
            chunks.push(chunk);
            return;
          }
          request.off("data", onData);
          request.off("end", onEnd);
          request.resume();
          resolve("too_large");
        };
        const onEnd = () => resolve(Buffer.concat(chunks));
        request.on("data", onData);
        // A client gone mid-upload ends the wait too (a settled promise ignores the rest).
        request.once("close", () => {
          if (!request.complete) resolve("unreadable");
        });
        request.once("end", onEnd);
        request.once("error", () => resolve("unreadable"));
      });
      if (body === "too_large") {
        response.setHeader("connection", "close");
        // The rest is not read for ever: once the answer is out, the connection goes.
        response.once("finish", () => request.destroy());
        answer(response, 413, { error: "body_too_large" });
        return;
      }
      if (body === "unreadable") {
        answer(response, 400, { error: "body_unreadable" });
        return;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name.toLowerCase()] = value;
        else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
      }
      try {
        const result = await deliver({
          taskId: hook.id,
          token: token!,
          method: request.method ?? "POST",
          query: url.search.replace(/^\?/, ""),
          headers,
          body,
        });
        if (result.status === 202) answer(response, 202, { deliveryId: result.deliveryId });
        else answer(response, result.status, { error: result.error });
      } catch (error) {
        context.log.warn("a webhook delivery failed", { taskId, error: messageOf(error) });
        answer(response, 500, { error: "internal_error" });
      }
    };
    for (const method of ["GET", "POST", "PUT", "PATCH"]) {
      context.subscriptions.add(http.route(method, `${WEBHOOK_ROUTE_PREFIX}/*`, handler));
    }
  }

  // --- Commands (D384) -----------------------------------------------------

  const read = ["scheduler.read"];
  // A task sends messages to threads: changing or running one takes both rights.
  const write = ["scheduler.write", "threads.write"];
  /** In-process code, or a caller that may change and run tasks anyway (the URL token runs one). */
  const mayWrite = (invocation: Invocation) => {
    const permissions = invocation.caller?.permissions;
    // Grants may be patterns (`*`, `scheduler.*`): matched as the kernel matches them.
    return (
      permissions === undefined ||
      write.every((permission) => holdsPermission(permissions, permission))
    );
  };
  const withId = z.object({ id: z.string().describe("The task's id, from scheduler.tasks.list.") });

  // The titles of this plugin's permissions (security.md D961).
  describePermissions(context, {
    "scheduler.read": {
      title: "View scheduled tasks",
      description: "Read scheduled tasks and their runs.",
    },
    "scheduler.write": {
      title: "Manage scheduled tasks",
      description: "Create, change, run and delete scheduled tasks.",
    },
  });
  context.commands.register({
    name: "scheduler.tasks.list",
    title: "List scheduled tasks",
    description:
      "Lists the node's scheduled tasks (optionally one project's) with their schedule, prompt, enabled state, bound thread, next run time and last run status. Follow the scheduler stream after head for changes.",
    input: z.object({ projectId: z.string().optional() }),
    output: z.object({ tasks: z.array(ScheduledTask), head: z.number() }),
    permissions: read,
    handler: async ({ projectId }, invocation) => {
      const head = await log.head(SCHEDULER_STREAM);
      const withToken = mayWrite(invocation);
      // Its URL starts runs: a thread sees it only for tasks no broader than it (D1352).
      const limits = await callerLimits(invocation.threadId, invocation.caller?.permissions);
      const tasks: ScheduledTask[] = [];
      for (const task of await list(projectId)) {
        const shown = withToken && (task.webhook === undefined || (await urlShown(limits, task)));
        tasks.push(
          shown || task.webhook === undefined
            ? task
            : { ...task, webhook: { ...task.webhook, path: null, url: null } },
        );
      }
      return { tasks, head };
    },
  });

  context.commands.register({
    name: "scheduler.tasks.get",
    description: "One scheduled task",
    input: withId,
    output: ScheduledTask,
    permissions: read,
    handler: async ({ id }, invocation) => {
      const task = await getTask(id);
      const limits = await callerLimits(invocation.threadId, invocation.caller?.permissions);
      return toPublic(task, mayWrite(invocation) && (await urlShown(limits, task)));
    },
  });

  context.commands.register({
    name: "scheduler.tasks.create",
    title: "Schedule a recurring task",
    description:
      "Creates persistent work in the node's scheduler that runs even when no turn is active. Pass schedule as a structured object. Timers: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings in the node's time zone; report the returned nextRunAt. Webhooks: {type:'webhook'} runs once per request to the returned webhook.url. The run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.action}}, {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}}. Each value arrives framed as untrusted request data; without a signature, anyone with the URL can trigger a run. For a sender that signs requests, first call secrets_request so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. Omit projectId for this thread's project. In this thread's project, runs post into THIS thread by default (bindToCurrentThread=true), which suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight; use false only when the user wants a fresh top-level thread per run. Elsewhere each run launches a fresh thread. Agent, model and runtime settings inherit from this thread. Without a calling thread, threadId binds every run to that thread; without it each run starts a new thread in the project.",
    input: CreateTaskInput,
    output: ScheduledTask,
    permissions: write,
    handler: (input, invocation) =>
      create(input, invocation.caller?.id, invocation.threadId, invocation.caller?.permissions),
  });

  context.commands.register({
    name: "scheduler.tasks.update",
    title: "Update a scheduled task",
    description:
      "Updates a scheduled task. Only the fields given change. Use enabled=false to pause a task without deleting it; threadId moves it between posting into a thread and starting a new thread per run (null); from an agent's thread, set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run. A webhook signature without a secret or secretRef keeps the stored one; a secretRef from secrets_request is consumed by the update.",
    input: UpdateTaskInput,
    output: ScheduledTask,
    permissions: write,
    handler: (input, invocation) =>
      update(input, invocation.threadId, invocation.caller?.permissions),
  });

  context.commands.register({
    name: "scheduler.tasks.delete",
    title: "Delete a scheduled task",
    description:
      "Permanently deletes a scheduled task; it stops running at once. To keep it but stop its runs, update it with enabled=false instead.",
    input: withId,
    output: z.object({ id: z.string(), deleted: z.boolean() }),
    permissions: ["scheduler.write"],
    handler: async ({ id }, invocation) => ({
      id,
      deleted: await removeTask(
        id,
        await guardFor(invocation.threadId, invocation.caller?.permissions),
      ),
    }),
  });

  context.commands.register({
    name: "scheduler.tasks.run",
    title: "Run a scheduled task now",
    description:
      "Runs a scheduled task now. Returns the thread this run went to, or null if it failed. Completion means the message went out, not that the agent's turn finished. Webhook tasks run only when their URL is called.",
    input: withId,
    output: z.object({ task: ScheduledTask, threadId: z.string().nullable() }),
    permissions: write,
    handler: async ({ id }, invocation) =>
      runNow(id, await guardFor(invocation.threadId, invocation.caller?.permissions)),
  });

  context.commands.register({
    name: "scheduler.webhooks.rotate",
    title: "Rotate a webhook URL",
    description: "Gives a webhook task a new URL token; the old URL stops working.",
    input: withId,
    output: ScheduledTask,
    permissions: write,
    handler: async ({ id }, invocation) =>
      rotateWebhookToken(id, await guardFor(invocation.threadId, invocation.caller?.permissions)),
  });

  context.commands.register({
    name: "scheduler.deliveries.list",
    description: "The last 50 requests to a webhook task's URL, newest first",
    input: withId,
    output: z.object({ deliveries: z.array(DeliverySummary) }),
    permissions: read,
    handler: async ({ id }) => {
      await getTask(id);
      const kept = await kv.list(NAMESPACE, { prefix: deliveryPrefix(id) });
      return {
        deliveries: kept
          .toReversed()
          .map(({ value }) => DeliverySummary.parse(value as unknown as Delivery)),
      };
    },
  });

  context.commands.register({
    name: "scheduler.deliveries.get",
    description:
      "One request to a webhook task's URL: its query, headers (credentials redacted), body and the prompt it filled in",
    input: z.object({ id: z.string(), deliveryId: z.string() }),
    output: Delivery,
    // The body, query and prompt a sender chose may carry anything: as private as the URL.
    permissions: write,
    handler: async ({ id, deliveryId }) => {
      await getTask(id);
      const kept = await kv.list(NAMESPACE, { prefix: deliveryPrefix(id) });
      const found = kept.find(({ key }) => key.endsWith(`/${deliveryId}`));
      if (found === undefined) {
        throw new SchedulerError("DELIVERY_NOT_FOUND", `No delivery ${deliveryId}`, {
          id,
          deliveryId,
        });
      }
      return found.value as unknown as Delivery;
    },
  });
}
