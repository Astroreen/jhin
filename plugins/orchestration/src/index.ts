// Delegated tasks, launches and their contracts follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/server/src/mcp/OrchestratorMcpService.ts
// (resolveTarget, the mode ranks, readTask, task_cancel), the tool
// descriptions of apps/server/src/mcp/toolkits/orchestrator/tools.ts,
// packages/contracts/src/orchestratorMcp.ts and the child-thread title and
// result rules of packages/provider-core/src/server/subagentProjection.ts.
// Decisions: docs/plans/orchestration.md (D360–D376).
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
  DEFAULT_RUNTIME_MODE,
  capRuntimeMode,
  ceilingOf,
  INTERACTION_MODES,
  ORCHESTRATION_STREAM,
  OrchestrationEvents,
  OrchestrationThreadEvents,
  RUNTIME_MODES,
  THREADS_STREAM,
  ThreadEvents,
  threadStream,
  WorkspaceStrategy,
  type InteractionMode,
  type RuntimeMode,
} from "@jhin/agent-api";
import {
  definePlugin,
  describePermissions,
  z,
  type CancelSignal,
  type Invocation,
} from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
  type StoredEvent,
} from "@jhin/storage-api";

import { parseWorkflow, runWorkflow, WorkflowError, type AgentOptions } from "./workflow.ts";

const NAMESPACE = "jhin.orchestration";
const CONFIG_SECTION = "jhin.orchestration";
const MAX_TASK_LENGTH = 120_000;
const MAX_TITLE_LENGTH = 512;
const CHILD_TITLE_LENGTH = 72;
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_AGENTS_PER_WORKFLOW = 1000;
const MAX_ITEMS_PER_CALL = 4096;
/**
 * Running a script is running code on the node (D375), so it takes a permission
 * of its own. The node's owner token holds it; a thread's agent does not
 * (`AGENT_PERMISSIONS` of `@jhin/mcp-api`), until scoped grants (W13).
 */
export const WORKFLOWS_RUN_PERMISSION = "workflows.run";
/** How long a workflow body may run before its first `await` (D374). */
const SCRIPT_SYNC_TIMEOUT_MS = 1000;
const MAX_WORKFLOW_LOGS = 200;
/** How often a workflow agent's answer is sent back for not matching its schema. */
const SCHEMA_RETRIES = 2;
/** A saved workflow's name: the file `.jhin/workflows/<name>.js` of the project (D875). */
const SAVED_NAME = /^[\w][\w.-]*$/;
const SAVED_DIR = Path.join(".jhin", "workflows");

const Config = z
  .object({
    maxConcurrentAgents: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({
        title: "Agents at once per workflow",
        description:
          "How many agents of one workflow run at the same time; min(16, CPUs − 2) when unset.",
        examples: [4],
      }),
  })
  .meta({
    title: "Orchestration",
    description: "Delegated tasks, launched threads and workflows of several agents.",
  });

// --- Thread records, as jhin.threads returns them ---------------------------

const TurnStatus = z.enum(["running", "waiting", "completed", "interrupted", "failed"]);
const ENDED_TURN = new Set(["completed", "interrupted", "failed"]);
const ThreadRecord = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    archivedAt: z.string().optional(),
    agentId: z.string().optional(),
    model: z.string().optional(),
    runtimeMode: z.enum(RUNTIME_MODES).optional(),
    interactionMode: z.enum(INTERACTION_MODES).optional(),
    parentThreadId: z.string().optional(),
    modelOptions: z
      .array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) }))
      .optional(),
    lastTurn: z
      .object({
        turnId: z.string(),
        status: TurnStatus,
        agentId: z.string(),
        waitingFor: z.enum(["approval", "user-input"]).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
type ThreadRecord = z.infer<typeof ThreadRecord>;

const AgentInfo = z
  .object({
    agentId: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() }).loose()),
    defaultModel: z.string().optional(),
    runtimeModes: z.array(z.enum(RUNTIME_MODES)),
    interactionModes: z.array(z.enum(INTERACTION_MODES)),
    available: z.boolean(),
    message: z.string().optional(),
    default: z.boolean(),
  })
  .loose();
type AgentInfo = z.infer<typeof AgentInfo>;

// --- Records -------------------------------------------------------------------

/** A model option chosen for a turn (D297). */
type ModelOption = { readonly id: string; readonly value: string | boolean };
const OptionValue = z.union([z.string(), z.boolean()]);
/** T3's target options: a list of selections, or a record of them by id (D870). */
const TargetOptions = z
  .union([
    // The input is bounded as given, before the ids are counted.
    z.array(z.object({ id: z.string().min(1).max(256), value: OptionValue })).max(100),
    z
      .record(z.string().min(1).max(256), OptionValue)
      .refine((record) => Object.keys(record).length <= 100, "At most 100 entries."),
  ])
  .transform((options): ModelOption[] =>
    Array.isArray(options)
      ? options
      : Object.entries(options).map(([id, value]) => ({ id, value })),
  )
  // One value per option, the last given winning; as many as a turn takes.
  .transform((options) => [...new Map(options.map((option) => [option.id, option])).values()])
  .refine((options) => options.length <= 20, "At most 20 model options.");

/** `chosen` over `base`, by option id. */
const layerOptions = (
  base: readonly ModelOption[] | undefined,
  chosen: readonly ModelOption[] | undefined,
): ModelOption[] | undefined =>
  chosen === undefined
    ? base?.slice()
    : [...new Map([...(base ?? []), ...chosen].map((option) => [option.id, option])).values()];

const TaskStatus = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
type TaskStatus = z.infer<typeof TaskStatus>;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "interrupted", "cancelled"]);
const Delivery = z.enum(["none", "pending", "delivered", "acknowledged", "disposed"]);
const Roles = ["implementation", "research", "review", "design", "test", "general"] as const;

const Task = z.object({
  taskId: z.string(),
  parentThreadId: z.string(),
  childThreadId: z.string(),
  /** The child's first turn: the task's own run. */
  childTurnId: z.string().optional(),
  clientRequestId: z.string().optional(),
  title: z.string(),
  role: z.enum(Roles).optional(),
  agentId: z.string(),
  model: z.string().optional(),
  runtimeMode: z.enum(RUNTIME_MODES),
  interactionMode: z.enum(INTERACTION_MODES),
  status: TaskStatus,
  summary: z.string().optional(),
  hasPendingQuestion: z.boolean(),
  /** Whether its end wakes the parent (D368): async tasks, and waited ones whose wait gave up. */
  wake: z.enum(["always", "none"]),
  delivery: Delivery,
  workflowId: z.string().optional(),
  cancelReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
});
type Task = z.infer<typeof Task>;

const WorkflowStatus = z.enum(["running", "completed", "failed", "stopped"]);
const WorkflowAgent = z.object({
  index: z.number(),
  taskId: z.string().optional(),
  /** The task's thread, once it exists (D863). */
  childThreadId: z.string().optional(),
  label: z.string().optional(),
  phase: z.string().optional(),
  status: z.union([TaskStatus, z.literal("starting")]),
  /** Its result came from the run it resumed (D872). */
  cached: z.boolean().optional(),
});
const Workflow = z.object({
  workflowId: z.string(),
  parentThreadId: z.string(),
  name: z.string(),
  description: z.string(),
  phases: z.array(z.object({ title: z.string(), detail: z.string().optional() })),
  /** The run it resumed (D872). */
  resumedFrom: z.string().optional(),
  /** Its token target, and the output tokens its agents spent (D873). */
  budget: z.number().optional(),
  spent: z.number().optional(),
  currentPhase: z.string().optional(),
  status: WorkflowStatus,
  agents: z.array(WorkflowAgent),
  logs: z.array(z.string()),
  result: z.json().optional(),
  error: z.string().optional(),
  wake: z.enum(["always", "none"]),
  delivery: Delivery,
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
});
type Workflow = z.infer<typeof Workflow>;

const TaskView = z.object({
  taskId: z.string(),
  parentThreadId: z.string(),
  childThreadId: z.string(),
  childTurnId: z.string().nullable(),
  title: z.string(),
  status: TaskStatus,
  workState: z.enum(["working", "waiting_for_children", "result_available"]),
  hasPendingQuestion: z.boolean(),
  hasPendingChildRuns: z.boolean(),
  waitTimedOut: z.boolean(),
  agentId: z.string(),
  model: z.string().nullable(),
  runtimeMode: z.enum(RUNTIME_MODES),
  interactionMode: z.enum(INTERACTION_MODES),
  summary: z.string().nullable(),
  delivery: Delivery,
  workflowId: z.string().optional(),
  createdAt: z.string(),
  endedAt: z.string().optional(),
});

class OrchestrationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;

// --- Mode ranks (T3's) -------------------------------------------------------------

const RUNTIME_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  "full-access": 2,
};
const INTERACTION_RANK: Record<InteractionMode, number> = { plan: 0, default: 1 };

/**
 * A child's mode: a requested one may not be broader than the parent's nor
 * one the agent lacks; an inherited one steps down to the broadest the agent
 * offers that is not broader (D364).
 */
function resolveMode<M extends string>(options: {
  kind: "runtime" | "interaction";
  requested: M | "inherit" | undefined;
  parent: M;
  offered: readonly M[];
  rank: Record<M, number>;
  agentName: string;
  fallback: M;
}): M {
  const { kind, requested, parent, offered, rank, agentName, fallback } = options;
  if (requested !== undefined && requested !== "inherit") {
    if (rank[requested] > rank[parent]) {
      throw new OrchestrationError(
        kind === "runtime"
          ? "RUNTIME_MODE_ESCALATION_DENIED"
          : "INTERACTION_MODE_ESCALATION_DENIED",
        `Child ${kind} mode ${requested} is broader than parent mode ${parent}.`,
        { requested, parent },
      );
    }
    if (!offered.includes(requested)) {
      throw new OrchestrationError(
        "INVALID_REQUEST",
        `Agent ${agentName} does not offer ${kind} mode ${requested}. Use one of: ${offered.join(", ")}.`,
        { requested, offered },
      );
    }
    return requested;
  }
  const fitting = offered
    .filter((mode) => rank[mode] <= rank[parent])
    .toSorted((a, b) => rank[b] - rank[a]);
  return fitting[0] ?? fallback;
}

/** T3's child title: the title, else the prompt, cut at 72; else "<parent> subagent <n>". */
export function childTitle(
  title: string | undefined,
  prompt: string,
  parentTitle: string,
  ordinal: number,
) {
  const source = (title ?? "").trim() || prompt.trim();
  const flat = source.replace(/\s+/g, " ");
  if (flat === "") return `${parentTitle} subagent ${ordinal}`;
  return flat.length <= CHILD_TITLE_LENGTH ? flat : `${flat.slice(0, CHILD_TITLE_LENGTH - 3)}...`;
}

/** The text a child's run produced (T3's subagentResultForRun). */
export function resultOfTurn(
  events: readonly StoredEvent[],
  turnId: string,
  status: string,
): string {
  let last: string | undefined;
  let failure: string | undefined;
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object" || payload.turnId !== turnId) continue;
    if (
      event.type === ThreadEvents.itemCompleted &&
      payload.kind === "message" &&
      typeof payload.text === "string" &&
      payload.text.trim() !== ""
    ) {
      last = payload.text;
    }
    if (event.type === ThreadEvents.turnFailed && typeof payload.error === "string") {
      failure = payload.error;
    }
  }
  if (status === "failed" && failure !== undefined) return failure;
  if (last !== undefined) return last;
  return status === "completed"
    ? "Child task completed without an assistant result."
    : `Child task ended with status ${status}.`;
}

/** The JSON object of an answer: the whole text, a fenced block, or the outermost braces. */
function jsonOf(text: string): unknown {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next reading.
    }
  }
  return undefined;
}

const now = () => new Date().toISOString();

/** Output tokens of a thread's turns: the last usage each turn reported (D873). */
export function outputTokens(events: readonly StoredEvent[]): number {
  const byTurn = new Map<string, number>();
  for (const event of events) {
    if (event.type !== ThreadEvents.usageUpdated) continue;
    const payload = event.payload as {
      turnId?: unknown;
      usage?: { outputTokens?: unknown };
    } | null;
    const tokens = payload?.usage?.outputTokens;
    if (typeof payload?.turnId === "string" && typeof tokens === "number") {
      byTurn.set(payload.turnId, tokens);
    }
  }
  return [...byTurn.values()].reduce((sum, tokens) => sum + tokens, 0);
}

/** One agent() call of a run, as its resume compares it (D872). */
interface JournalEntry {
  readonly index: number;
  readonly key: string;
  readonly result: Json;
  readonly taskId?: string;
  readonly childThreadId?: string;
}

export default definePlugin({
  async activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    // Required so the threads plugin (and its commands) runs first.
    context.services.get(AGENT_REGISTRY_CAPABILITY);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const run = <T>(name: string, input: unknown, invocation?: Invocation) =>
      context.commands.execute(
        name,
        input,
        invocation?.traceId === undefined ? {} : { traceId: invocation.traceId },
      ) as Promise<T>;

    const tasks = new Map<string, Task>();
    const workflows = new Map<string, Workflow>();
    /** `<parent>\0<clientRequestId>` → the task (or its creation under way). */
    const requests = new Map<string, Promise<Task> | string>();
    /** Called on every change of a task. */
    const listeners = new Set<(task: Task) => void>();
    /** Called on every thread record of the `threads` index. */
    const threadListeners = new Set<(thread: ThreadRecord) => void>();
    const writes = new Map<string, Promise<unknown>>();
    const running = new Map<string, AbortController>();
    /** The latest record of each thread the `threads` index reported. */
    const seenThreads = new Map<string, ThreadRecord>();
    let disposed = false;

    /** One write after another per record: the store and the stream keep its order. */
    function persist(key: string, value: Json, type: string): Promise<void> {
      const previous = writes.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await kv.set(NAMESPACE, key, value);
          await log.append(ORCHESTRATION_STREAM, [{ type, payload: value }]);
        });
      writes.set(key, next);
      void next.finally(() => {
        if (writes.get(key) === next) writes.delete(key);
      });
      return next;
    }

    async function saveTask(task: Task): Promise<Task> {
      const saved = Task.parse({ ...task, updatedAt: now() });
      tasks.set(saved.taskId, saved);
      for (const listener of listeners) listener(saved);
      await persist(
        `task/${saved.taskId}`,
        saved as unknown as Json,
        OrchestrationEvents.taskUpdated,
      );
      // A workflow's record follows its agents' tasks, also once the run stopped them (D867).
      const workflow = saved.workflowId === undefined ? undefined : workflows.get(saved.workflowId);
      const agent = workflow?.agents.find((entry) => entry.taskId === saved.taskId);
      if (workflow !== undefined && agent !== undefined && agent.status !== saved.status) {
        // Its own write: a failure there is logged and leaves the task's write standing.
        void updateWorkflow(workflow.workflowId, (current) => ({
          ...current,
          agents: current.agents.map((entry) =>
            entry.taskId === saved.taskId ? { ...entry, status: saved.status } : entry,
          ),
        })).catch((error: unknown) =>
          context.log.error("could not record a workflow's progress", { error: String(error) }),
        );
      }
      return saved;
    }

    async function saveWorkflow(workflow: Workflow): Promise<Workflow> {
      const saved = Workflow.parse({ ...workflow, updatedAt: now() });
      workflows.set(saved.workflowId, saved);
      await persist(
        `workflow/${saved.workflowId}`,
        saved as unknown as Json,
        OrchestrationEvents.workflowUpdated,
      );
      return saved;
    }

    /**
     * Leaves a mark of delegated work in the thread's stream, in the turn it
     * runs (D862). The work goes on without it: a mark that cannot be written
     * is only logged.
     */
    async function mark(threadId: string, type: string, payload: Record<string, Json>) {
      try {
        // Read now: the turn that started the work may have ended since the caller's read.
        const { thread } = await getThread(threadId);
        const turn = thread.lastTurn;
        const turnId = turn === undefined || ENDED_TURN.has(turn.status) ? undefined : turn.turnId;
        await log.append(threadStream(threadId), [
          { type, payload: { ...payload, ...(turnId === undefined ? {} : { turnId }) } },
        ]);
      } catch (error) {
        context.log.warn("could not mark delegated work in its thread", {
          threadId,
          type,
          error: String(error),
        });
      }
    }

    async function getThread(threadId: string, invocation?: Invocation) {
      try {
        return await run<{ thread: unknown; running?: string }>(
          "threads.get",
          { threadId },
          invocation,
        ).then((got) => ({ thread: ThreadRecord.parse(got.thread), running: got.running }));
      } catch (error) {
        if (codeOf(error) === "THREAD_NOT_FOUND") {
          throw new OrchestrationError("THREAD_NOT_FOUND", `No thread ${threadId}`, { threadId });
        }
        throw error;
      }
    }

    const agentsList = async (invocation?: Invocation) =>
      z.array(AgentInfo).parse(await run("agents.list", {}, invocation));

    /** Whether `threads.create` takes a `workspace` (W3, D371). */
    const workspaceSupported = () => {
      const create = context.commands.list().find((command) => command.name === "threads.create");
      const schema = create?.inputSchema as { properties?: Record<string, unknown> } | undefined;
      return schema?.properties?.workspace !== undefined;
    };

    function workspaceInput(strategy: WorkspaceStrategy | undefined): Record<string, unknown> {
      if (strategy === undefined) return {};
      if (workspaceSupported()) return { workspace: strategy };
      if (strategy.type === "root" && strategy.branch === undefined) return {};
      throw new OrchestrationError(
        "WORKSPACE_UNSUPPORTED",
        `This node cannot bind a thread to a ${strategy.type === "root" ? "branch" : strategy.type.replace("_", " ")} yet: only the project root is available.`,
        { strategy: strategy.type },
      );
    }

    /** The calling thread: the input's, the invocation's, or none. */
    function callerThread(named: string | undefined, invocation: Invocation): string | undefined {
      if (
        named !== undefined &&
        invocation.threadId !== undefined &&
        named !== invocation.threadId
      ) {
        throw new OrchestrationError(
          "INVALID_REQUEST",
          `The call comes from thread ${invocation.threadId}, not ${named}.`,
          { threadId: invocation.threadId, named },
        );
      }
      return named ?? invocation.threadId;
    }

    const requireThread = (threadId: string | undefined, operation: string): string => {
      if (threadId !== undefined) return threadId;
      throw new OrchestrationError(
        "THREAD_REQUIRED",
        `${operation} acts as the calling thread, so it needs an agent running inside a Jhin thread, or a parentThreadId.`,
      );
    };

    // --- Following threads ----------------------------------------------------------

    const isTerminal = (task: Task) => TERMINAL.has(task.status);

    /** Brings a task up to date with its child thread's record. */
    async function follow(task: Task, thread: ThreadRecord): Promise<void> {
      const current = tasks.get(task.taskId) ?? task;
      if (current.childTurnId === undefined) return;
      const turn = thread.lastTurn;
      if (turn === undefined || turn.turnId !== current.childTurnId) return;
      if (ENDED_TURN.has(turn.status)) {
        if (current.endedAt !== undefined) return;
        const status: TaskStatus =
          current.status === "cancelled" ? "cancelled" : (turn.status as TaskStatus);
        const events = await log.read(threadStream(thread.id));
        await finish(current, status, resultOfTurn(events, turn.turnId, status));
        return;
      }
      if (isTerminal(current)) return;
      const status = turn.status as TaskStatus;
      const hasPendingQuestion = turn.status === "waiting" && turn.waitingFor === "user-input";
      if (status !== current.status || hasPendingQuestion !== current.hasPendingQuestion) {
        await saveTask({ ...current, status, hasPendingQuestion });
      }
    }

    async function finish(task: Task, status: TaskStatus, summary: string): Promise<void> {
      const latest = tasks.get(task.taskId) ?? task;
      if (latest.endedAt !== undefined) return;
      const wakes =
        latest.wake === "always" && latest.delivery === "none" && status !== "cancelled";
      await saveTask({
        ...latest,
        status,
        summary: latest.summary ?? summary,
        hasPendingQuestion: false,
        endedAt: now(),
        delivery: wakes ? "pending" : latest.delivery,
      });
      if (wakes) void deliver(latest.parentThreadId);
    }

    const ENDINGS: Record<string, TaskStatus> = {
      [ThreadEvents.turnCompleted]: "completed",
      [ThreadEvents.turnInterrupted]: "interrupted",
      [ThreadEvents.turnFailed]: "failed",
    };

    /**
     * Brings a task up to date from its child's own stream, so a turn that
     * ended (or a task that never got one) while nobody followed is resolved
     * even after the child moved on. `startup`: no send of it is under way.
     */
    async function reconcile(task: Task, startup = false): Promise<void> {
      try {
        const { thread } = await getThread(task.childThreadId);
        let current = tasks.get(task.taskId) ?? task;
        if (current.endedAt !== undefined) return;
        const events = await log.read(threadStream(task.childThreadId));
        const turnOf = (event: StoredEvent) =>
          (event.payload as { turnId?: unknown } | null)?.turnId;
        let turnId = current.childTurnId;
        if (turnId === undefined) {
          if (!startup) return;
          // The node stopped between sending the task and recording its turn.
          const started = events.find((event) => event.type === ThreadEvents.turnStarted);
          if (started === undefined || typeof turnOf(started) !== "string") {
            await finish(current, "failed", "The node stopped before the child task started.");
            return;
          }
          turnId = turnOf(started) as string;
          current = await saveTask({ ...current, childTurnId: turnId });
        }
        const ending = events.find(
          (event) => ENDINGS[event.type] !== undefined && turnOf(event) === turnId,
        );
        if (ending !== undefined) {
          const status = current.status === "cancelled" ? "cancelled" : ENDINGS[ending.type]!;
          await finish(current, status, resultOfTurn(events, turnId, status));
          return;
        }
        await follow(current, thread);
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === "THREAD_NOT_FOUND") {
          const latest = tasks.get(task.taskId) ?? task;
          if (latest.endedAt === undefined) {
            await finish(
              latest,
              latest.status === "cancelled" ? "cancelled" : "failed",
              "The child thread was deleted.",
            );
          }
          return;
        }
        throw error;
      }
    }

    context.subscriptions.add(
      log.subscribe(THREADS_STREAM, (event) => {
        if (disposed) return;
        if (event.type === ThreadEvents.threadDeleted) {
          const id = (event.payload as { id?: unknown } | null)?.id;
          if (typeof id === "string") {
            seenThreads.delete(id);
            void onThreadGone(id).catch((error: unknown) =>
              context.log.error("could not follow a deleted thread", { error: String(error) }),
            );
          }
          return;
        }
        if (event.type !== ThreadEvents.threadUpdated && event.type !== ThreadEvents.threadCreated)
          return;
        const parsed = ThreadRecord.safeParse(event.payload);
        if (!parsed.success) return;
        const thread = parsed.data;
        if (thread.parentThreadId !== undefined) seenThreads.set(thread.id, thread);
        for (const listener of threadListeners) listener(thread);
        for (const task of tasks.values()) {
          if (task.childThreadId === thread.id) {
            void follow(task, thread).catch((error: unknown) =>
              context.log.error("could not follow a delegated task", {
                taskId: task.taskId,
                error: String(error),
              }),
            );
          }
        }
        if (thread.archivedAt !== undefined) {
          void dispose(thread.id).catch((error: unknown) =>
            context.log.error("could not drop the wake-ups of an archived thread", {
              error: String(error),
            }),
          );
        } else if (thread.lastTurn === undefined || ENDED_TURN.has(thread.lastTurn.status)) {
          void deliver(thread.id);
        }
      }),
    );

    async function onThreadGone(threadId: string) {
      await dispose(threadId);
      for (const task of tasks.values()) {
        if (task.childThreadId === threadId) await reconcile(task).catch(() => undefined);
        // Nobody is left to read their results: the work of a deleted thread stops.
        if (task.parentThreadId === threadId && !isTerminal(task)) {
          await cancelTask(task, "The parent thread was deleted");
        }
      }
      for (const workflow of workflows.values()) {
        if (workflow.parentThreadId === threadId && workflow.status === "running") {
          await stopWorkflow(workflow);
        }
      }
    }

    // --- Waking the parent (D368) -------------------------------------------------------

    /** Parents with a delivery under way, and whether another was asked for meanwhile. */
    const delivering = new Map<string, boolean>();

    async function dispose(parentThreadId: string) {
      for (const task of tasks.values()) {
        if (task.parentThreadId === parentThreadId && task.delivery === "pending") {
          await saveTask({ ...task, delivery: "disposed" });
        }
      }
      for (const workflow of workflows.values()) {
        if (workflow.parentThreadId === parentThreadId && workflow.delivery === "pending") {
          await saveWorkflow({ ...workflow, delivery: "disposed" });
        }
      }
    }

    function deliver(parentThreadId: string): Promise<void> {
      if (delivering.has(parentThreadId)) {
        delivering.set(parentThreadId, true);
        return Promise.resolve();
      }
      delivering.set(parentThreadId, false);
      return (async () => {
        try {
          do {
            delivering.set(parentThreadId, false);
            await deliverOnce(parentThreadId);
          } while (delivering.get(parentThreadId) === true);
        } catch (error) {
          context.log.error("could not wake a parent thread", {
            parentThreadId,
            error: String(error),
          });
        } finally {
          delivering.delete(parentThreadId);
        }
      })();
    }

    async function deliverOnce(parentThreadId: string): Promise<void> {
      const pendingTasks = [...tasks.values()].filter(
        (task) => task.parentThreadId === parentThreadId && task.delivery === "pending",
      );
      const pendingWorkflows = [...workflows.values()].filter(
        (workflow) => workflow.parentThreadId === parentThreadId && workflow.delivery === "pending",
      );
      if (pendingTasks.length === 0 && pendingWorkflows.length === 0) return;
      let parent: Awaited<ReturnType<typeof getThread>>;
      try {
        parent = await getThread(parentThreadId);
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === "THREAD_NOT_FOUND") {
          await dispose(parentThreadId);
          return;
        }
        throw error;
      }
      if (parent.thread.archivedAt !== undefined) {
        await dispose(parentThreadId);
        return;
      }
      // Never into a running turn: its end in the index brings us back.
      if (parent.running !== undefined) return;
      const lines: string[] = [];
      if (pendingTasks.length === 1) {
        const id = pendingTasks[0]!.taskId;
        lines.push(
          `Delegated task ${id} reached a terminal state. Use tasks_status with taskId ${id} to read the result.`,
        );
      } else if (pendingTasks.length > 1) {
        const ids = pendingTasks.map((task) => task.taskId).join(", ");
        lines.push(
          `Delegated tasks ${ids} reached terminal states. Use tasks_status with each taskId to read the results.`,
        );
      }
      for (const workflow of pendingWorkflows) {
        const id = workflow.workflowId;
        lines.push(
          `Workflow ${id} reached a terminal state. Use workflows_status with workflowId ${id} to read the result.`,
        );
      }
      try {
        await run("threads.send", { threadId: parentThreadId, text: lines.join("\n") });
      } catch (error) {
        const code = codeOf(error);
        // Taken meanwhile: its turn's end brings us back.
        if (code === "TURN_IN_PROGRESS") return;
        if (code === "THREAD_ARCHIVED" || code === "THREAD_NOT_FOUND") {
          await dispose(parentThreadId);
          return;
        }
        throw error;
      }
      for (const task of pendingTasks) {
        const latest = tasks.get(task.taskId)!;
        if (latest.delivery === "pending") await saveTask({ ...latest, delivery: "delivered" });
      }
      for (const workflow of pendingWorkflows) {
        const latest = workflows.get(workflow.workflowId)!;
        if (latest.delivery === "pending") await saveWorkflow({ ...latest, delivery: "delivered" });
      }
    }

    // --- Views -------------------------------------------------------------------------

    /** `fresh` reads the child thread; otherwise its last record in the index counts. */
    async function view(
      task: Task,
      waitTimedOut = false,
      fresh = false,
    ): Promise<z.input<typeof TaskView>> {
      const nested =
        [...tasks.values()].some(
          (child) => child.parentThreadId === task.childThreadId && !isTerminal(child),
        ) ||
        [...workflows.values()].some(
          (workflow) =>
            workflow.parentThreadId === task.childThreadId && workflow.status === "running",
        );
      let hasPendingChildRuns = false;
      if (isTerminal(task)) {
        if (fresh) {
          const child = await getThread(task.childThreadId).catch(() => undefined);
          hasPendingChildRuns = child?.running !== undefined && child.running !== task.childTurnId;
        } else {
          const turn = seenThreads.get(task.childThreadId)?.lastTurn;
          hasPendingChildRuns =
            turn !== undefined && turn.turnId !== task.childTurnId && !ENDED_TURN.has(turn.status);
        }
      }
      const workState = !isTerminal(task)
        ? "working"
        : nested
          ? "waiting_for_children"
          : "result_available";
      return {
        taskId: task.taskId,
        parentThreadId: task.parentThreadId,
        childThreadId: task.childThreadId,
        childTurnId: task.childTurnId ?? null,
        title: task.title,
        status: task.status,
        workState,
        hasPendingQuestion: task.hasPendingQuestion,
        hasPendingChildRuns,
        waitTimedOut,
        agentId: task.agentId,
        model: task.model ?? null,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
        summary: isTerminal(task) ? (task.summary ?? null) : null,
        delivery: task.delivery,
        ...(task.workflowId === undefined ? {} : { workflowId: task.workflowId }),
        createdAt: task.createdAt,
        ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      };
    }

    /** Resolves once the task ended (or asks a question, with `questions`), or after `timeoutMs`. */
    function waitFor(
      taskId: string,
      options: {
        timeoutMs?: number;
        /** `questions`: also when it asks the user something; `any`: also when it waits for an approval. */
        waiting: "none" | "questions" | "any";
        signal?: CancelSignal;
      },
    ): Promise<{ timedOut: boolean }> {
      const done = (task: Task | undefined) =>
        task === undefined ||
        task.endedAt !== undefined ||
        (options.waiting === "questions" && task.hasPendingQuestion) ||
        (options.waiting === "any" && task.status === "waiting");
      if (done(tasks.get(taskId))) return Promise.resolve({ timedOut: false });
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const stop = (timedOut: boolean) => {
          listeners.delete(listener);
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve({ timedOut });
        };
        const listener = (task: Task) => {
          if (task.taskId === taskId && done(task)) stop(false);
        };
        const onAbort = () => stop(false);
        listeners.add(listener);
        if (options.signal?.aborted === true) {
          stop(false);
          return;
        }
        options.signal?.addEventListener("abort", onAbort);
        if (options.timeoutMs !== undefined)
          timer = setTimeout(() => stop(true), options.timeoutMs);
      });
    }

    // --- Delegating ----------------------------------------------------------------------

    interface DelegateRequest {
      readonly parentThreadId: string;
      readonly task: string;
      readonly title?: string;
      readonly role?: (typeof Roles)[number];
      readonly target?: {
        readonly agentId?: string | undefined;
        readonly model?: string | undefined;
        readonly options?: readonly ModelOption[] | undefined;
      };
      readonly runtimeMode?: RuntimeMode | "inherit";
      readonly interactionMode?: InteractionMode | "inherit";
      readonly isolation?: "shared" | "worktree";
      readonly clientRequestId?: string;
      readonly wake: "always" | "none";
      readonly workflowId?: string;
    }

    async function delegate(request: DelegateRequest, invocation?: Invocation): Promise<Task> {
      if (request.clientRequestId !== undefined) {
        const key = `${request.parentThreadId}\u0000${request.clientRequestId}`;
        const known = requests.get(key);
        if (typeof known === "string") return tasks.get(known)!;
        if (known !== undefined) return known;
        const creating = startTask(request, invocation);
        requests.set(key, creating);
        try {
          const task = await creating;
          requests.set(key, task.taskId);
          return task;
        } catch (error) {
          requests.delete(key);
          throw error;
        }
      }
      return startTask(request, invocation);
    }

    /** The next child number of each parent, taken before any await so parallel delegations differ. */
    const ordinals = new Map<string, number>();

    async function startTask(request: DelegateRequest, invocation?: Invocation): Promise<Task> {
      const ordinal =
        (ordinals.get(request.parentThreadId) ??
          [...tasks.values()].filter((task) => task.parentThreadId === request.parentThreadId)
            .length) + 1;
      ordinals.set(request.parentThreadId, ordinal);
      const { thread: parent } = await getThread(request.parentThreadId, invocation);
      const agents = await agentsList(invocation);
      const fallback = agents.find((agent) => agent.default) ?? agents[0];
      const parentAgent =
        (parent.agentId === undefined
          ? undefined
          : agents.find((agent) => agent.agentId === parent.agentId)) ?? fallback;
      const agentId = request.target?.agentId ?? parentAgent?.agentId;
      const agent = agents.find((candidate) => candidate.agentId === agentId);
      if (agentId === undefined || agent === undefined) {
        throw new OrchestrationError(
          "AGENT_NOT_FOUND",
          agentId === undefined
            ? "No agent runtime is installed on this node."
            : `Agent ${agentId} is not registered.`,
          { agentId },
        );
      }
      if (!agent.available) {
        throw new OrchestrationError(
          "AGENT_UNAVAILABLE",
          `Agent ${agent.agentId} cannot run a child task: ${agent.message ?? "Agent is unavailable."}`,
          { agentId: agent.agentId },
        );
      }
      const requestedModel = request.target?.model;
      if (
        requestedModel !== undefined &&
        agent.models.length > 0 &&
        !agent.models.some((model) => model.id === requestedModel)
      ) {
        throw new OrchestrationError(
          "MODEL_UNAVAILABLE",
          `Model ${requestedModel} is not advertised by agent ${agent.agentId}.`,
          { agentId: agent.agentId, model: requestedModel },
        );
      }
      const sameAgent = agent.agentId === parentAgent?.agentId;
      const model = requestedModel ?? (sameAgent ? parent.model : undefined);
      // Options go with their model: the parent's are the base only while the child runs the
      // parent's model, and the chosen ones are laid over them (D870).
      const modelOptions = layerOptions(
        sameAgent && model === parent.model ? parent.modelOptions : undefined,
        request.target?.options,
      );
      const runtimeMode = resolveMode<RuntimeMode>({
        kind: "runtime",
        requested: request.runtimeMode,
        // No broader than the caller's ceiling either (security.md D1370).
        parent: capRuntimeMode(
          parent.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          ceilingOf(invocation?.caller?.permissions),
        ),
        offered: agent.runtimeModes,
        rank: RUNTIME_RANK,
        agentName: agent.agentId,
        fallback: "approval-required",
      });
      const interactionMode = resolveMode<InteractionMode>({
        kind: "interaction",
        requested: request.interactionMode,
        parent: parent.interactionMode ?? "default",
        offered: agent.interactionModes,
        rank: INTERACTION_RANK,
        agentName: agent.agentId,
        fallback: "default",
      });
      const workspace =
        request.isolation === "worktree"
          ? workspaceInput({ type: "worktree", baseRef: "HEAD", startFromOrigin: false })
          : {};
      const title = childTitle(request.title, request.task, parent.title, ordinal);
      const prompt =
        request.role === undefined || request.role === "general"
          ? request.task
          : `Act as the ${request.role} sub-agent for this task.\n\n${request.task}`;
      const child = ThreadRecord.parse(
        await run(
          "threads.create",
          {
            projectId: parent.projectId,
            title,
            agentId: agent.agentId,
            ...(model === undefined ? {} : { model }),
            ...(modelOptions === undefined ? {} : { modelOptions }),
            runtimeMode,
            interactionMode,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
            ...workspace,
          },
          invocation,
        ),
      );
      const createdAt = now();
      let task = await saveTask({
        taskId: Crypto.randomUUID(),
        parentThreadId: parent.id,
        childThreadId: child.id,
        ...(request.clientRequestId === undefined
          ? {}
          : { clientRequestId: request.clientRequestId }),
        title,
        ...(request.role === undefined ? {} : { role: request.role }),
        agentId: agent.agentId,
        ...(model === undefined ? {} : { model }),
        runtimeMode,
        interactionMode,
        status: "running",
        hasPendingQuestion: false,
        wake: request.wake,
        delivery: "none",
        ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
        createdAt,
        updatedAt: createdAt,
      });
      // A workflow's agents show in its own block, not one by one.
      if (request.workflowId === undefined) {
        await mark(parent.id, OrchestrationThreadEvents.taskDelegated, {
          taskId: task.taskId,
          childThreadId: child.id,
          title,
          agentId: agent.agentId,
          ...(model === undefined ? {} : { model }),
        });
      }
      let turnId: string;
      try {
        ({ turnId } = await run<{ turnId: string }>(
          "threads.send",
          { threadId: child.id, text: prompt },
          invocation,
        ));
      } catch (error) {
        // The caller gets the error: the parent is not woken for it as well.
        task = await saveTask({
          ...(tasks.get(task.taskId) ?? task),
          wake: "none",
          delivery: "disposed",
        });
        await finish(
          task,
          "failed",
          `The child task could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      task = await saveTask({ ...(tasks.get(task.taskId) ?? task), childTurnId: turnId });
      // Cancelled while it was starting: stop the turn it just started.
      if (task.status === "cancelled")
        await run("threads.interrupt", { threadId: child.id }).catch(() => undefined);
      // The turn may have ended before the task knew its id.
      await reconcile(task);
      return tasks.get(task.taskId) ?? task;
    }

    function ownTask(taskId: string, threadId: string | undefined): Task {
      const task = tasks.get(taskId);
      if (task === undefined) {
        throw new OrchestrationError("TASK_NOT_FOUND", `No delegated task ${taskId}.`, { taskId });
      }
      if (threadId !== undefined && task.parentThreadId !== threadId) {
        throw new OrchestrationError(
          "TASK_NOT_FOUND",
          `Delegated task ${taskId} does not belong to thread ${threadId}.`,
          { taskId, threadId },
        );
      }
      return task;
    }

    /** Stops a task's child and everything it started (D367). */
    async function cancelTask(task: Task, reason: string | undefined): Promise<void> {
      let latest = tasks.get(task.taskId) ?? task;
      if (!isTerminal(latest)) {
        latest = await saveTask({
          ...latest,
          status: "cancelled",
          hasPendingQuestion: false,
          ...(reason === undefined ? {} : { cancelReason: reason }),
        });
      }
      if (latest.delivery === "pending")
        latest = await saveTask({ ...latest, delivery: "disposed" });
      if (latest.childTurnId !== undefined || isTerminal(latest)) {
        await run("threads.interrupt", { threadId: latest.childThreadId }).catch(
          (error: unknown) => {
            if (codeOf(error) !== "THREAD_NOT_FOUND") throw error;
          },
        );
      }
      for (const nested of tasks.values()) {
        if (nested.parentThreadId === latest.childThreadId && !isTerminal(nested)) {
          await cancelTask(nested, reason);
        }
      }
      for (const workflow of workflows.values()) {
        if (workflow.parentThreadId === latest.childThreadId && workflow.status === "running") {
          await stopWorkflow(workflow);
        }
      }
      // A cancelled task whose turn already ended is final now.
      await reconcile(latest).catch(() => undefined);
    }

    // --- Commands: tasks ------------------------------------------------------------------

    const RuntimeModeInput = z.enum(["inherit", ...RUNTIME_MODES]);
    const InteractionModeInput = z.enum(["inherit", ...INTERACTION_MODES]);

    // The title of the permission workflow scripts need (security.md D961).
    describePermissions(context, {
      [WORKFLOWS_RUN_PERMISSION]: {
        title: "Run workflow scripts",
        description: "Run scripts that orchestrate agents; a script runs code on this node.",
      },
    });
    context.commands.register({
      name: "tasks.delegate",
      description:
        "Delegates one task to a child agent of the calling thread and runs it with only the given task prompt, without the parent's history. Choose agents and models from orchestration_capabilities; agent, model and modes inherit unless target or the modes override them, and a mode may not be broader than the parent's. For every review round call tasks_delegate again with the full brief, prior findings and objections, and a distinct clientRequestId per round (stable across retries of that round); childThreadId is backing storage, not the target of the next round. Prefer mode='async' for long work: the task's end wakes the calling thread with a message once its turn is over, so end the turn instead of polling. mode='wait' blocks until the task ends, asks a question, or timeoutMs (default 10 minutes) passes; waitTimedOut means the wait gave up, not the task.",
      input: z.object({
        task: z.string().trim().min(1).max(MAX_TASK_LENGTH),
        target: z
          .object({
            agentId: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            options: TargetOptions.optional().describe(
              "Model option selections advertised by orchestration_capabilities, as [{id, value}] or {id: value}: at most 20 distinct ids, the last value of an id winning. Options the model does not declare are dropped.",
            ),
          })
          .optional(),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        role: z.enum(Roles).optional(),
        isolation: z.enum(["shared", "worktree"]).optional(),
        mode: z.enum(["async", "wait"]).default("async"),
        timeoutMs: z.number().optional(),
        clientRequestId: z.string().min(1).max(256).optional(),
        runtimeMode: RuntimeModeInput.optional(),
        interactionMode: InteractionModeInput.optional(),
        parentThreadId: z.string().min(1).optional(),
      }),
      output: TaskView,
      permissions: ["threads.write"],
      handler: async (input, invocation) => {
        const parentThreadId = requireThread(
          callerThread(input.parentThreadId, invocation),
          "tasks.delegate",
        );
        const wait = input.mode === "wait";
        const task = await delegate(
          {
            parentThreadId,
            task: input.task,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.role === undefined ? {} : { role: input.role }),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
            ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
            ...(input.clientRequestId === undefined
              ? {}
              : { clientRequestId: input.clientRequestId }),
            wake: wait ? "none" : "always",
          },
          invocation,
        );
        if (!wait) return view(tasks.get(task.taskId) ?? task);
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(
            1,
            Number.isFinite(input.timeoutMs) ? input.timeoutMs! : DEFAULT_WAIT_TIMEOUT_MS,
          ),
        );
        // A caller that went away stops the wait, not the task (D1502).
        const { timedOut } = await waitFor(task.taskId, {
          timeoutMs,
          waiting: "questions",
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        });
        let latest = tasks.get(task.taskId) ?? task;
        // Not over when the wait returned: its end wakes the parent after all.
        if (latest.endedAt === undefined && latest.wake === "none") {
          latest = await saveTask({ ...latest, wake: "always" });
        }
        return view(latest, timedOut);
      },
    });

    context.commands.register({
      name: "tasks.status",
      description:
        "Reads a task delegated by the calling thread. workState tells working, waiting_for_children and result_available apart; summary is the task's result (the child's last message, or its error on failure) and stays as published. hasPendingChildRuns reports a later turn of the child thread still running. Reading a terminal result acknowledges its wake-up message.",
      input: z.object({ taskId: z.string().min(1), parentThreadId: z.string().min(1).optional() }),
      output: TaskView,
      permissions: ["threads.read"],
      handler: async ({ taskId, parentThreadId }, invocation) => {
        let task = ownTask(taskId, callerThread(parentThreadId, invocation));
        if (
          isTerminal(task) &&
          task.endedAt !== undefined &&
          (task.delivery === "pending" || task.delivery === "delivered")
        ) {
          task = await saveTask({ ...task, delivery: "acknowledged" });
        }
        return view(task, false, true);
      },
    });

    context.commands.register({
      name: "tasks.cancel",
      description:
        "Stops a task delegated by the calling thread and drops its wake-up message. Its child thread stops like a user's Stop, and the tasks and workflows it started stop too. Its child thread stops even when the task is already terminal (a later turn there included, as in T3); a terminal task returns its status, and its published result stays available.",
      input: z.object({
        taskId: z.string().min(1),
        reason: z.string().max(2000).optional(),
        clientRequestId: z.string().max(256).optional(),
        parentThreadId: z.string().min(1).optional(),
      }),
      output: z.object({
        taskId: z.string(),
        status: z.enum(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
      }),
      permissions: ["threads.write"],
      handler: async ({ taskId, reason, parentThreadId }, invocation) => {
        const task = ownTask(taskId, callerThread(parentThreadId, invocation));
        const wasTerminal = isTerminal(task);
        await cancelTask(task, reason);
        return {
          taskId,
          status: wasTerminal
            ? (task.status as "completed" | "failed" | "cancelled" | "interrupted")
            : ("cancel_requested" as const),
        };
      },
    });

    context.commands.register({
      name: "tasks.list",
      description:
        "Tasks delegated by the calling thread (or every task of the node without one), newest first",
      input: z.object({ parentThreadId: z.string().min(1).optional() }),
      output: z.array(TaskView),
      permissions: ["threads.read"],
      handler: async ({ parentThreadId }, invocation) => {
        const threadId = callerThread(parentThreadId, invocation);
        const list = [...tasks.values()]
          .filter((task) => threadId === undefined || task.parentThreadId === threadId)
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
        return Promise.all(list.map((task) => view(task)));
      },
    });

    // --- Commands: capabilities and launches ------------------------------------------------

    context.commands.register({
      name: "orchestration.capabilities",
      description:
        "Lists the agent runtimes of this node with their models and modes, whether each can run a child task, the calling thread's agent, model and modes, and the orchestration features available. For a separate top-level thread use orchestration_launch.",
      input: z.object({ threadId: z.string().min(1).optional() }),
      output: z.object({
        parentThreadId: z.string().nullable(),
        inheritedAgentId: z.string().nullable(),
        inheritedModel: z.string().nullable(),
        runtimeMode: z.enum(RUNTIME_MODES),
        interactionMode: z.enum(INTERACTION_MODES),
        agents: z.array(
          z.object({
            agentId: z.string(),
            name: z.string(),
            models: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                options: z.array(z.object({ id: z.string(), type: z.string() }).loose()).optional(),
              }),
            ),
            defaultModel: z.string().nullable(),
            runtimeModes: z.array(z.enum(RUNTIME_MODES)),
            interactionModes: z.array(z.enum(INTERACTION_MODES)),
            default: z.boolean(),
            canRunChildTask: z.boolean(),
            canRunCrossProviderChildTask: z.boolean(),
            constraints: z.array(z.string()),
          }),
        ),
        features: z.object({
          appOwnedSubagents: z.boolean(),
          asyncPolling: z.boolean(),
          cancellation: z.boolean(),
          threadManagement: z.boolean(),
          workflows: z.boolean(),
          scheduledTasks: z.boolean(),
          workspaceStrategies: z.array(z.enum(["root", "worktree", "existing_worktree"])),
        }),
      }),
      permissions: ["threads.read"],
      handler: async ({ threadId: named }, invocation) => {
        const threadId = callerThread(named, invocation);
        const thread =
          threadId === undefined ? undefined : (await getThread(threadId, invocation)).thread;
        const agents = await agentsList(invocation);
        const inherited =
          (thread?.agentId === undefined
            ? undefined
            : agents.find((agent) => agent.agentId === thread.agentId)) ??
          agents.find((agent) => agent.default);
        return {
          parentThreadId: thread?.id ?? null,
          inheritedAgentId: inherited?.agentId ?? null,
          inheritedModel:
            (thread?.agentId === inherited?.agentId ? thread?.model : undefined) ??
            inherited?.defaultModel ??
            inherited?.models[0]?.id ??
            null,
          runtimeMode: thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: thread?.interactionMode ?? "default",
          agents: agents.map((agent) => {
            const constraints = agent.available ? [] : [agent.message ?? "Agent is unavailable."];
            return {
              agentId: agent.agentId,
              name: agent.name,
              models: agent.models.map((model) => ({
                id: model.id,
                name: model.name,
                ...(Array.isArray(model.options) ? { options: model.options } : {}),
              })),
              defaultModel: agent.defaultModel ?? null,
              runtimeModes: agent.runtimeModes,
              interactionModes: agent.interactionModes,
              default: agent.default,
              canRunChildTask: constraints.length === 0,
              canRunCrossProviderChildTask: constraints.length === 0,
              constraints,
            };
          }),
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            threadManagement: true,
            workflows: true,
            scheduledTasks: context.commands
              .list()
              .some((command) => command.name === "scheduler.tasks.create"),
            // A new worktree also needs the node's source control to make it (D250, D252).
            workspaceStrategies: workspaceSupported()
              ? (["root", "worktree", "existing_worktree"] as const).filter(
                  (strategy) =>
                    strategy !== "worktree" ||
                    context.commands
                      .list()
                      .some((command) => command.name === "git.worktree.create"),
                )
              : ["root" as const],
          },
        };
      },
    });

    context.commands.register({
      name: "orchestration.launch",
      description:
        'Creates an ordinary top-level thread, bound to a workspace before its agent starts, and sends message as its first turn (omit it for an idle thread). Use it when the user asks for independent work or a new thread; use tasks_delegate for child agents. workspaceStrategy: {type:"worktree", baseRef, branch?, startFromOrigin?} for a new worktree, {type:"existing_worktree", worktreePath, branch?} for an existing checkout; omitted means the project root, not the caller\'s worktree. Omit projectId, agent, model and modes to inherit the calling thread\'s; a caller outside a thread must pass projectId. scratch:true runs it in the scratch project instead. Each call creates a new thread (no retry key): after an error, list threads before retrying. The thread may not run with broader modes than the calling thread.',
      input: z.object({
        title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
        projectId: z.string().min(1).optional(),
        scratch: z.boolean().optional(),
        message: z.string().max(MAX_TASK_LENGTH).optional(),
        agentId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        runtimeMode: z.enum(RUNTIME_MODES).optional(),
        interactionMode: z.enum(INTERACTION_MODES).optional(),
        workspaceStrategy: WorkspaceStrategy.optional(),
        callerThreadId: z.string().min(1).optional(),
      }),
      output: z.object({
        threadId: z.string(),
        projectId: z.string(),
        agentId: z.string().nullable(),
        model: z.string().nullable(),
        turnId: z.string().nullable(),
        status: z.enum(["running"]).nullable(),
      }),
      permissions: ["threads.write"],
      handler: async (input, invocation) => {
        const callerId = callerThread(input.callerThreadId, invocation);
        const caller =
          callerId === undefined ? undefined : (await getThread(callerId, invocation)).thread;
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        ) {
          throw new OrchestrationError(
            "INVALID_REQUEST",
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          );
        }
        const projectId =
          input.scratch === true ? "scratch" : (input.projectId ?? caller?.projectId);
        if (projectId === undefined) {
          throw new OrchestrationError(
            "INVALID_REQUEST",
            "Pass projectId: a caller outside a thread has no project to inherit.",
          );
        }
        const workspace = workspaceInput(input.workspaceStrategy);
        const agentId = input.agentId ?? caller?.agentId;
        const sameAgent = input.agentId === undefined || input.agentId === caller?.agentId;
        const model = input.model ?? (sameAgent ? caller?.model : undefined);
        let runtimeMode = input.runtimeMode ?? caller?.runtimeMode;
        let interactionMode = input.interactionMode ?? caller?.interactionMode;
        // Another agent: inherited modes step down to what it offers (D364).
        if (!sameAgent && agentId !== undefined) {
          const agent = (await agentsList(invocation)).find((item) => item.agentId === agentId);
          if (agent !== undefined) {
            if (input.runtimeMode === undefined && runtimeMode !== undefined) {
              runtimeMode = resolveMode<RuntimeMode>({
                kind: "runtime",
                requested: undefined,
                parent: runtimeMode,
                offered: agent.runtimeModes,
                rank: RUNTIME_RANK,
                agentName: agent.agentId,
                fallback: "approval-required",
              });
            }
            if (input.interactionMode === undefined && interactionMode !== undefined) {
              interactionMode = resolveMode<InteractionMode>({
                kind: "interaction",
                requested: undefined,
                parent: interactionMode,
                offered: agent.interactionModes,
                rank: INTERACTION_RANK,
                agentName: agent.agentId,
                fallback: "default",
              });
            }
          }
        }
        if (caller !== undefined) {
          const ceiling = caller.runtimeMode ?? DEFAULT_RUNTIME_MODE;
          if (runtimeMode !== undefined && RUNTIME_RANK[runtimeMode] > RUNTIME_RANK[ceiling]) {
            throw new OrchestrationError(
              "RUNTIME_MODE_ESCALATION_DENIED",
              `Thread runtime mode ${runtimeMode} is broader than the caller's mode ${ceiling}.`,
              { requested: runtimeMode, caller: ceiling },
            );
          }
          const interactionCeiling = caller.interactionMode ?? "default";
          if (
            interactionMode !== undefined &&
            INTERACTION_RANK[interactionMode] > INTERACTION_RANK[interactionCeiling]
          ) {
            throw new OrchestrationError(
              "INTERACTION_MODE_ESCALATION_DENIED",
              `Thread interaction mode ${interactionMode} is broader than the caller's mode ${interactionCeiling}.`,
              { requested: interactionMode, caller: interactionCeiling },
            );
          }
        }
        let created: ThreadRecord;
        try {
          created = ThreadRecord.parse(
            await run(
              "threads.create",
              {
                projectId,
                title: input.title,
                ...(agentId === undefined ? {} : { agentId }),
                ...(model === undefined ? {} : { model }),
                // A caller's full access stays inherited; an outside caller gets the node's default.
                ...(runtimeMode === undefined ? {} : { runtimeMode }),
                ...(interactionMode === undefined ? {} : { interactionMode }),
                ...workspace,
              },
              invocation,
            ),
          );
        } catch (error) {
          if (codeOf(error) === "PROJECT_NOT_FOUND") {
            throw new OrchestrationError("PROJECT_NOT_FOUND", "The project was not found.", {
              projectId,
            });
          }
          throw error;
        }
        let turnId: string | null = null;
        if (input.message !== undefined && input.message.trim() !== "") {
          ({ turnId } = await run<{ turnId: string }>(
            "threads.send",
            { threadId: created.id, text: input.message },
            invocation,
          ));
        }
        if (caller !== undefined) {
          await mark(caller.id, OrchestrationThreadEvents.threadLaunched, {
            threadId: created.id,
            title: created.title,
          });
        }
        return {
          threadId: created.id,
          projectId: created.projectId,
          agentId: created.agentId ?? null,
          model: created.model ?? null,
          turnId,
          status: turnId === null ? null : ("running" as const),
        };
      },
    });

    // --- Workflows (D372–D376) ----------------------------------------------------------------

    const concurrency = () => {
      const configured = (
        context.config.get(CONFIG_SECTION) as { maxConcurrentAgents?: number } | undefined
      )?.maxConcurrentAgents;
      return configured ?? Math.max(1, Math.min(16, Os.availableParallelism() - 2));
    };

    /** Runs one turn of a thread to its end and returns its last message, or undefined. */
    async function sendAndWait(
      threadId: string,
      text: string,
      signal: AbortSignal,
    ): Promise<string | undefined> {
      let ended: ((status: string) => void) | undefined;
      const seen = new Map<string, string>();
      const listener = (thread: ThreadRecord) => {
        if (thread.id !== threadId || thread.lastTurn === undefined) return;
        if (!ENDED_TURN.has(thread.lastTurn.status)) return;
        seen.set(thread.lastTurn.turnId, thread.lastTurn.status);
        ended?.(thread.lastTurn.turnId);
      };
      threadListeners.add(listener);
      try {
        const { turnId } = await run<{ turnId: string }>("threads.send", { threadId, text });
        const status =
          seen.get(turnId) ??
          (await new Promise<string>((resolve) => {
            // Stopped: the retry's turn stops with the workflow.
            const onAbort = () => {
              void run("threads.interrupt", { threadId }).catch(() => undefined);
              resolve("interrupted");
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            ended = (id) => {
              if (id !== turnId) return;
              signal.removeEventListener("abort", onAbort);
              resolve(seen.get(id)!);
            };
            // Ended before the listener knew its id.
            void getThread(threadId).then(
              ({ thread }) => {
                if (thread.lastTurn?.turnId === turnId) listener(thread);
              },
              // Gone (or unreadable): the retry has no answer to wait for.
              () => {
                signal.removeEventListener("abort", onAbort);
                resolve("interrupted");
              },
            );
          }));
        if (status !== "completed") return undefined;
        const events = await log.read(threadStream(threadId));
        return resultOfTurn(events, turnId, status);
      } finally {
        threadListeners.delete(listener);
      }
    }

    async function updateWorkflow(workflowId: string, change: (workflow: Workflow) => Workflow) {
      const current = workflows.get(workflowId);
      if (current === undefined) return;
      await saveWorkflow(change(current));
    }

    function schemaPrompt(prompt: string, schema: Record<string, unknown>): string {
      return `${prompt}\n\nAnswer with only one JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(schema, null, 2)}`;
    }

    /** The directory a thread's saved workflows and script paths are found from (D875). */
    async function workingDirectory(thread: ThreadRecord): Promise<string | undefined> {
      const own = (thread as { worktreePath?: unknown }).worktreePath;
      if (typeof own === "string") return own;
      const projects = await run<{ id: string; path?: string }[]>("projects.list", {}).catch(
        () => [],
      );
      return projects.find((project) => project.id === thread.projectId)?.path;
    }

    /** A saved workflow's script by name, or a script file (relative to `dir`) (D874, D875). */
    async function loadScript(
      dir: string | undefined,
      ref: string | { readonly scriptPath: string },
    ): Promise<string> {
      const file =
        typeof ref === "string"
          ? SAVED_NAME.test(ref) && dir !== undefined
            ? Path.join(dir, SAVED_DIR, `${ref}.js`)
            : undefined
          : Path.isAbsolute(ref.scriptPath)
            ? ref.scriptPath
            : dir === undefined
              ? undefined
              : Path.join(dir, ref.scriptPath);
      const what = typeof ref === "string" ? `saved workflow ${ref}` : `script ${ref.scriptPath}`;
      if (file === undefined) {
        throw new OrchestrationError(
          "WORKFLOW_NOT_FOUND",
          `No ${what}: the thread has no project folder.`,
        );
      }
      try {
        return await Fs.readFile(file, "utf8");
      } catch {
        throw new OrchestrationError("WORKFLOW_NOT_FOUND", `No ${what} (${file}).`, { path: file });
      }
    }

    /** What a run carries besides its record: its journal, what it resumes, its tokens. */
    interface RunState {
      readonly journal: JournalEntry[];
      readonly prior: ReadonlyMap<number, JournalEntry>;
      /** Off until the first call that is not the resumed run's (D872). */
      live: boolean;
      spent: number;
      /** Where its saved workflows and script paths are found (D875). */
      readonly dir: string | undefined;
      writing: Promise<unknown>;
    }
    const runStates = new Map<string, RunState>();

    /** The journal's answer for a call of a resumed run, decided in call order (D872). */
    function cachedAgent(
      workflow: Workflow,
      prompt: string,
      options: AgentOptions & { index: number },
    ): { value: unknown } | undefined {
      const state = runStates.get(workflow.workflowId);
      if (state === undefined || state.live) return undefined;
      const { index, ...given } = options;
      const hit = state.prior.get(index);
      if (hit === undefined || hit.key !== JSON.stringify([prompt, given])) {
        // The first call that changed, and every one after it, runs live.
        state.live = true;
        return undefined;
      }
      void updateWorkflow(workflow.workflowId, (current) => ({
        ...current,
        agents: [
          ...current.agents,
          {
            index,
            ...(options.label === undefined ? {} : { label: options.label }),
            ...((options.phase ?? current.currentPhase) === undefined
              ? {}
              : { phase: options.phase ?? current.currentPhase }),
            ...(hit.taskId === undefined ? {} : { taskId: hit.taskId }),
            ...(hit.childThreadId === undefined ? {} : { childThreadId: hit.childThreadId }),
            status: "completed" as const,
            cached: true,
          },
        ],
      })).catch((error: unknown) =>
        context.log.error("could not record a workflow's progress", { error: String(error) }),
      );
      record(workflow.workflowId, state, hit);
      return { value: hit.result };
    }

    async function workflowAgent(
      workflow: Workflow,
      prompt: string,
      options: AgentOptions & { index: number },
      signal: AbortSignal,
      traceId: string | undefined,
    ): Promise<unknown> {
      const state = runStates.get(workflow.workflowId);
      const { index, ...given } = options;
      const key = JSON.stringify([prompt, given]);
      let result: unknown;
      try {
        result = await liveAgent(workflow, prompt, options, signal, traceId);
      } finally {
        // Counting is bookkeeping: its failure never replaces the agent's own outcome.
        if (state !== undefined) {
          await countTokens(workflow.workflowId, state, index).catch((error: unknown) =>
            context.log.error("could not count a workflow agent's tokens", {
              error: String(error),
            }),
          );
        }
      }
      const entry = workflows
        .get(workflow.workflowId)
        ?.agents.find((agent) => agent.index === index);
      if (state !== undefined && result !== null && entry?.status === "completed") {
        record(workflow.workflowId, state, {
          index,
          key,
          result: result as Json,
          ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
          ...(entry.childThreadId === undefined ? {} : { childThreadId: entry.childThreadId }),
        });
      }
      return result;
    }

    /** Keeps a run's journal, one key per call (`journal/<id>/<index>`), for a later resume. */
    function record(workflowId: string, state: RunState, entry: JournalEntry) {
      state.journal.push(entry);
      state.writing = state.writing
        .catch(() => undefined)
        .then(() =>
          kv.set(NAMESPACE, `journal/${workflowId}/${entry.index}`, entry as unknown as Json),
        )
        .catch((error: unknown) =>
          context.log.error("could not record a workflow's journal", { error: String(error) }),
        );
    }

    /** Adds the output tokens of an agent's thread to its run's spending (D873). */
    async function countTokens(workflowId: string, state: RunState, index: number) {
      const childThreadId = workflows
        .get(workflowId)
        ?.agents.find((agent) => agent.index === index)?.childThreadId;
      if (childThreadId === undefined) return;
      const tokens = outputTokens(await log.read(threadStream(childThreadId)).catch(() => []));
      if (tokens === 0) return;
      state.spent += tokens;
      await updateWorkflow(workflowId, (current) => ({ ...current, spent: state.spent }));
    }

    async function liveAgent(
      workflow: Workflow,
      prompt: string,
      options: AgentOptions & { index: number },
      signal: AbortSignal,
      traceId: string | undefined,
    ): Promise<unknown> {
      if (options.agentType !== undefined) {
        throw new WorkflowError("WORKFLOW_SCRIPT", "agent() agentType is not available on Jhin");
      }
      const phase = options.phase ?? workflows.get(workflow.workflowId)?.currentPhase;
      const entry = {
        index: options.index,
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(phase === undefined ? {} : { phase }),
        status: "starting" as const,
      };
      await updateWorkflow(workflow.workflowId, (current) => ({
        ...current,
        agents: [...current.agents, entry],
      }));
      const setAgent = (change: Partial<z.infer<typeof WorkflowAgent>>) =>
        updateWorkflow(workflow.workflowId, (current) => ({
          ...current,
          agents: current.agents.map((agent) =>
            agent.index === options.index ? { ...agent, ...change } : agent,
          ),
        }));
      let task: Task;
      try {
        task = await delegate(
          {
            parentThreadId: workflow.parentThreadId,
            task: options.schema === undefined ? prompt : schemaPrompt(prompt, options.schema),
            ...(options.label === undefined ? {} : { title: options.label }),
            ...(options.agentId === undefined &&
            options.model === undefined &&
            options.effort === undefined
              ? {}
              : {
                  target: {
                    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
                    ...(options.model === undefined ? {} : { model: options.model }),
                    // The model's `effort` option (D870); a model without it drops it.
                    ...(options.effort === undefined
                      ? {}
                      : { options: [{ id: "effort", value: options.effort }] }),
                  },
                }),
            ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
            wake: "none",
            workflowId: workflow.workflowId,
          },
          traceId === undefined ? undefined : { traceId },
        );
      } catch (error) {
        await setAgent({ status: "failed" });
        // A call the script got wrong (an unknown agent or model, a mode) is the script's error.
        throw new WorkflowError(
          "WORKFLOW_SCRIPT",
          error instanceof Error ? error.message : String(error),
        );
      }
      await setAgent({
        taskId: task.taskId,
        childThreadId: task.childThreadId,
        status: task.status,
      });
      if (signal.aborted) await cancelTask(task, "The workflow was stopped");
      await waitFor(task.taskId, { waiting: "any", signal });
      // Nobody answers inside a workflow: an agent that asks the user stops there.
      if ((tasks.get(task.taskId) ?? task).status === "waiting" && !signal.aborted) {
        await cancelTask(task, "A workflow agent cannot ask the user");
        await updateWorkflow(workflow.workflowId, (current) => ({
          ...current,
          logs: [
            ...current.logs,
            `Agent ${options.label ?? options.index} asked the user something and was stopped: a workflow agent cannot ask.`,
          ].slice(-MAX_WORKFLOW_LOGS),
        }));
        await waitFor(task.taskId, { waiting: "none", signal });
      }
      const done = tasks.get(task.taskId) ?? task;
      await setAgent({ status: done.status });
      if (done.status !== "completed" || signal.aborted) return null;
      if (options.schema === undefined) return done.summary ?? null;
      const validator = (() => {
        try {
          return z.fromJSONSchema(options.schema as Parameters<typeof z.fromJSONSchema>[0]);
        } catch {
          return undefined;
        }
      })();
      let answer: string | undefined = done.summary;
      for (let attempt = 0; ; attempt++) {
        const value = answer === undefined ? undefined : jsonOf(answer);
        const checked =
          value === undefined
            ? undefined
            : (validator?.safeParse(value) ?? { success: true, data: value });
        if (checked?.success === true) return checked.data;
        if (attempt >= SCHEMA_RETRIES || signal.aborted) return null;
        const problem =
          value === undefined
            ? "it is not a JSON object"
            : (checked?.success === false ? checked.error.issues : [])
                .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; ");
        answer = await sendAndWait(
          task.childThreadId,
          `Your answer does not match the JSON Schema (${problem}). Answer again with only one JSON object that matches it.`,
          signal,
        );
      }
    }

    async function startWorkflow(
      workflow: Workflow,
      body: string,
      args: unknown,
      invocation: Invocation,
    ) {
      const traceId = invocation.traceId;
      const controller = new AbortController();
      running.set(workflow.workflowId, controller);
      let ending: Partial<Workflow>;
      try {
        const result = await runWorkflow(
          body,
          args,
          {
            agent: (prompt, options) =>
              workflowAgent(workflow, prompt, options, controller.signal, traceId),
            cached: (prompt, options) => cachedAgent(workflow, prompt, options),
            budget: workflow.budget ?? null,
            spent: () => runStates.get(workflow.workflowId)?.spent ?? 0,
            load: (ref) => loadScript(runStates.get(workflow.workflowId)?.dir, ref),
            // As whoever started the run, with its grants and trace (agents.md D705).
            command: (name, input) => context.commands.execute(name, input, invocation),
            log: (message) =>
              void updateWorkflow(workflow.workflowId, (current) => ({
                ...current,
                logs: [...current.logs, message].slice(-MAX_WORKFLOW_LOGS),
              })).catch((error: unknown) =>
                context.log.error("could not record a workflow's progress", {
                  error: String(error),
                }),
              ),
            phase: (title) =>
              void updateWorkflow(workflow.workflowId, (current) => ({
                ...current,
                currentPhase: title,
              })).catch((error: unknown) =>
                context.log.error("could not record a workflow's progress", {
                  error: String(error),
                }),
              ),
          },
          {
            concurrency: concurrency(),
            maxAgents: MAX_AGENTS_PER_WORKFLOW,
            maxItems: MAX_ITEMS_PER_CALL,
            syncTimeoutMs: SCRIPT_SYNC_TIMEOUT_MS,
          },
          controller.signal,
        );
        ending = controller.signal.aborted
          ? { status: "stopped" }
          : ({ status: "completed", ...(result === null ? {} : { result }) } as Partial<Workflow>);
      } catch (error) {
        ending = controller.signal.aborted
          ? { status: "stopped" }
          : { status: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        running.delete(workflow.workflowId);
        // Its journal is written before the run ends, for a resume right after.
        const state = runStates.get(workflow.workflowId);
        runStates.delete(workflow.workflowId);
        await state?.writing;
      }
      if (disposed) return;
      // An agent the script left running (it threw, or returned without waiting) stops with it.
      for (const task of tasks.values()) {
        if (task.workflowId === workflow.workflowId && !isTerminal(task)) {
          await cancelTask(task, "The workflow's run ended");
        }
      }
      const latest = workflows.get(workflow.workflowId) ?? workflow;
      if (latest.status !== "running") return;
      await saveWorkflow({
        ...latest,
        ...ending,
        endedAt: now(),
        delivery: latest.wake === "always" ? "pending" : latest.delivery,
      });
      if (latest.wake === "always") void deliver(latest.parentThreadId);
    }

    async function stopWorkflow(workflow: Workflow) {
      running.get(workflow.workflowId)?.abort();
      const latest = workflows.get(workflow.workflowId) ?? workflow;
      if (latest.status === "running") {
        await saveWorkflow({ ...latest, status: "stopped", endedAt: now(), delivery: "disposed" });
      }
      for (const task of tasks.values()) {
        if (task.workflowId === workflow.workflowId && !isTerminal(task)) {
          await cancelTask(task, "The workflow was stopped");
        }
      }
    }

    const ownWorkflow = (workflowId: string, threadId: string | undefined): Workflow => {
      const workflow = workflows.get(workflowId);
      if (
        workflow === undefined ||
        (threadId !== undefined && workflow.parentThreadId !== threadId)
      ) {
        throw new OrchestrationError(
          "WORKFLOW_NOT_FOUND",
          threadId === undefined || workflow === undefined
            ? `No workflow ${workflowId}.`
            : `Workflow ${workflowId} does not belong to thread ${threadId}.`,
          { workflowId },
        );
      }
      return workflow;
    };

    context.commands.register({
      name: "workflows.run",
      description:
        "Runs a workflow script that orchestrates several agents, as the Workflow tool does. The script begins with `export const meta = { name, description, phases? }` (a pure literal) and its body is plain JavaScript using agent(prompt, {label, phase, schema, model, agentId, isolation}), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), command(name, input) (runs a command of the node as the caller of workflows.run and returns its output), args, budget {total, spent(), remaining()} and workflow(nameOrRef, args) (a saved workflow of the project's .jhin/workflows/<name>.js, or {scriptPath}; one level). Instead of script, pass name or scriptPath to run a saved workflow or a file. resumeFromRunId reuses the results of an earlier run's unchanged agent() calls up to the first changed one; budget caps the output tokens of its agents. Each agent is a delegated task of the calling thread. Returns at once with a workflowId; the workflow's end wakes the calling thread with a message, so end the turn instead of polling. Date.now(), new Date() and Math.random() are unavailable. The script runs inside the node with the node's rights (it can reach the node's own functions and block it after its first await), so it needs the workflows.run permission and a full-access calling thread.",
      input: z.object({
        script: z
          .string()
          .min(1)
          .max(512 * 1024)
          .optional(),
        name: z
          .string()
          .regex(SAVED_NAME, "A saved workflow's name: letters, digits, . _ -")
          .optional(),
        scriptPath: z.string().min(1).max(4096).optional(),
        args: z.json().optional(),
        parentThreadId: z.string().min(1).optional(),
        resumeFromRunId: z.string().min(1).optional(),
        budget: z.number().int().positive().optional(),
      }),
      output: z.object({ workflowId: z.string(), name: z.string(), status: WorkflowStatus }),
      permissions: ["threads.write", WORKFLOWS_RUN_PERMISSION],
      handler: async (
        { script: given, name, scriptPath, args, parentThreadId: named, resumeFromRunId, budget },
        invocation,
      ) => {
        // A mesh member's calls hold every permission (foundation Deferred): it
        // runs no code here until scoped mesh calls (W13).
        if (invocation.caller?.id.startsWith("node:") === true) {
          throw new OrchestrationError(
            "PERMISSION_DENIED",
            "A workflow script runs code on this node, so another node of the mesh cannot start one.",
            { caller: invocation.caller.id },
          );
        }
        const parentThreadId = requireThread(callerThread(named, invocation), "workflows.run");
        const { thread: parent } = await getThread(parentThreadId, invocation);
        // A script reaches the node's own functions (D375): only a thread that
        // may already run anything without approval may run one.
        const mode = parent.runtimeMode ?? DEFAULT_RUNTIME_MODE;
        if (mode !== "full-access") {
          throw new OrchestrationError(
            "RUNTIME_MODE_ESCALATION_DENIED",
            `A workflow script runs with the node's rights, so it needs a thread in full-access mode, not ${mode}.`,
            { runtimeMode: mode },
          );
        }
        if ([given, name, scriptPath].filter((value) => value !== undefined).length !== 1) {
          throw new OrchestrationError(
            "INVALID_REQUEST",
            "Pass exactly one of script, name and scriptPath.",
          );
        }
        // A resumed run is one of this thread's, and no longer runs (D872).
        let prior: JournalEntry[] = [];
        if (resumeFromRunId !== undefined) {
          const previous = ownWorkflow(resumeFromRunId, parentThreadId);
          if (previous.status === "running") {
            throw new OrchestrationError(
              "WORKFLOW_RUNNING",
              `Workflow ${resumeFromRunId} still runs: stop it before resuming it.`,
              { workflowId: resumeFromRunId },
            );
          }
          prior = (await kv.list(NAMESPACE, { prefix: `journal/${resumeFromRunId}/` })).map(
            (entry) => entry.value as unknown as JournalEntry,
          );
        }
        const dir = await workingDirectory(parent);
        const script =
          given ?? (await loadScript(dir, name ?? { scriptPath: scriptPath as string }));
        let parsed: ReturnType<typeof parseWorkflow>;
        try {
          parsed = parseWorkflow(script);
        } catch (error) {
          throw new OrchestrationError(
            "WORKFLOW_INVALID",
            error instanceof Error ? error.message : String(error),
          );
        }
        const createdAt = now();
        const workflow = await saveWorkflow({
          workflowId: Crypto.randomUUID(),
          parentThreadId,
          name: parsed.meta.name,
          description: parsed.meta.description,
          phases: (parsed.meta.phases ?? []).map((phase) => ({
            title: phase.title,
            ...(phase.detail === undefined ? {} : { detail: phase.detail }),
          })),
          ...(resumeFromRunId === undefined ? {} : { resumedFrom: resumeFromRunId }),
          ...(budget === undefined ? {} : { budget }),
          status: "running",
          agents: [],
          logs: [],
          wake: "always",
          delivery: "none",
          createdAt,
          updatedAt: createdAt,
        });
        runStates.set(workflow.workflowId, {
          journal: [],
          prior: new Map(prior.map((entry) => [entry.index, entry])),
          live: prior.length === 0,
          spent: 0,
          dir,
          writing: Promise.resolve(),
        });
        await mark(parent.id, OrchestrationThreadEvents.workflowStarted, {
          workflowId: workflow.workflowId,
          name: workflow.name,
          description: workflow.description,
          phases: workflow.phases as unknown as Json,
          script,
        });
        void startWorkflow(workflow, parsed.body, args, invocation).catch((error: unknown) =>
          context.log.error("a workflow could not be recorded", {
            workflowId: workflow.workflowId,
            error: String(error),
          }),
        );
        return { workflowId: workflow.workflowId, name: workflow.name, status: workflow.status };
      },
    });

    const WorkflowView = Workflow.omit({ wake: true });
    const viewWorkflow = ({ wake: _wake, ...workflow }: Workflow) => workflow;

    context.commands.register({
      name: "workflows.status",
      description:
        "Reads a workflow of the calling thread: its status, phases, agents (with their task ids), log lines and, once over, its result or error. Reading a finished workflow acknowledges its wake-up message.",
      input: z.object({
        workflowId: z.string().min(1),
        parentThreadId: z.string().min(1).optional(),
      }),
      output: WorkflowView,
      permissions: ["threads.read"],
      handler: async ({ workflowId, parentThreadId }, invocation) => {
        let workflow = ownWorkflow(workflowId, callerThread(parentThreadId, invocation));
        if (
          workflow.status !== "running" &&
          (workflow.delivery === "pending" || workflow.delivery === "delivered")
        ) {
          workflow = await saveWorkflow({ ...workflow, delivery: "acknowledged" });
        }
        return viewWorkflow(workflow);
      },
    });

    context.commands.register({
      name: "workflows.stop",
      description:
        "Stops a running workflow of the calling thread, with all its agents. Does not stop the calling thread or other workflows.",
      input: z.object({
        workflowId: z.string().min(1),
        parentThreadId: z.string().min(1).optional(),
      }),
      output: z.object({ workflowId: z.string(), status: WorkflowStatus }),
      permissions: ["threads.write"],
      handler: async ({ workflowId, parentThreadId }, invocation) => {
        const workflow = ownWorkflow(workflowId, callerThread(parentThreadId, invocation));
        await stopWorkflow(workflow);
        return { workflowId, status: workflows.get(workflowId)?.status ?? workflow.status };
      },
    });

    context.commands.register({
      name: "workflows.list",
      description:
        "Workflows of the calling thread (or every workflow of the node without one), newest first",
      input: z.object({ parentThreadId: z.string().min(1).optional() }),
      output: z.array(WorkflowView),
      permissions: ["threads.read"],
      handler: async ({ parentThreadId }, invocation) => {
        const threadId = callerThread(parentThreadId, invocation);
        return [...workflows.values()]
          .filter((workflow) => threadId === undefined || workflow.parentThreadId === threadId)
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(viewWorkflow);
      },
    });

    context.commands.register({
      name: "orchestration.thread",
      description:
        "The delegated tasks and workflows of a thread as records of the orchestration stream, with the stream's head to follow them from. Unlike tasks_status and workflows_status, reading acknowledges no result.",
      input: z.object({ threadId: z.string().min(1).optional() }),
      output: z.object({ tasks: z.array(Task), workflows: z.array(Workflow), head: z.number() }),
      permissions: ["threads.read"],
      handler: async ({ threadId: named }, invocation) => {
        const threadId = requireThread(callerThread(named, invocation), "orchestration.thread");
        // A thread that does not exist is no thread without delegated work.
        await getThread(threadId, invocation);
        // The head first: whatever changes after it comes on the stream, and a record read twice
        // is the same record.
        const head = await log.head(ORCHESTRATION_STREAM);
        return {
          tasks: [...tasks.values()].filter((task) => task.parentThreadId === threadId),
          workflows: [...workflows.values()].filter(
            (workflow) => workflow.parentThreadId === threadId,
          ),
          head,
        };
      },
    });

    // --- Load, reconcile, stop ----------------------------------------------------------------

    for (const entry of await kv.list(NAMESPACE, { prefix: "task/" })) {
      const parsed = Task.safeParse(entry.value);
      if (!parsed.success) continue;
      // A waited task still running when the node stopped lost its waiter: its end wakes the parent.
      const waiterGone =
        parsed.data.endedAt === undefined &&
        parsed.data.wake === "none" &&
        parsed.data.workflowId === undefined &&
        parsed.data.delivery === "none";
      tasks.set(parsed.data.taskId, waiterGone ? { ...parsed.data, wake: "always" } : parsed.data);
      // A task that never started is no answer to a retry of its request.
      const started = parsed.data.childTurnId !== undefined;
      if (parsed.data.clientRequestId !== undefined && started) {
        requests.set(
          `${parsed.data.parentThreadId}\u0000${parsed.data.clientRequestId}`,
          parsed.data.taskId,
        );
      }
    }
    for (const entry of await kv.list(NAMESPACE, { prefix: "workflow/" })) {
      const parsed = Workflow.safeParse(entry.value);
      if (parsed.success) workflows.set(parsed.data.workflowId, parsed.data);
    }
    // Workflows do not resume (Deferred): one that ran when the node stopped failed.
    const orphaned = new Set<string>();
    for (const workflow of workflows.values()) {
      if (workflow.status === "running") {
        orphaned.add(workflow.workflowId);
        await saveWorkflow({
          ...workflow,
          status: "failed",
          error: "The node stopped while the workflow ran.",
          endedAt: now(),
          delivery: workflow.wake === "always" ? "pending" : workflow.delivery,
        });
      }
    }
    // After activation, so the commands this calls are all there.
    void (async () => {
      // The agents of a run that ended with the node (or a reload) stop too.
      for (const task of tasks.values()) {
        if (task.workflowId !== undefined && orphaned.has(task.workflowId) && !isTerminal(task)) {
          await cancelTask(task, "The workflow's run ended").catch((error: unknown) =>
            context.log.warn("could not stop a workflow's agent", {
              taskId: task.taskId,
              error: String(error),
            }),
          );
        }
      }
      for (const task of tasks.values()) {
        if (task.endedAt === undefined) {
          await reconcile(task, true).catch((error: unknown) =>
            context.log.warn("could not reconcile a delegated task", {
              taskId: task.taskId,
              error: String(error),
            }),
          );
        }
      }
      const parents = new Set<string>();
      for (const task of tasks.values())
        if (task.delivery === "pending") parents.add(task.parentThreadId);
      for (const workflow of workflows.values())
        if (workflow.delivery === "pending") parents.add(workflow.parentThreadId);
      for (const parent of parents) await deliver(parent);
    })();

    context.onDeactivate(async () => {
      disposed = true;
      for (const controller of running.values()) controller.abort();
      await Promise.allSettled(writes.values());
    });
  },
});
