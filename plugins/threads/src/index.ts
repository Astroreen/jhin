// Settling, pinning, snoozing and ordering threads (the "Arrangement" commands and
// the rules they share with the web client) follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/server/src/orchestration-v2/Orchestrator.ts
// (dispatchThreadMutation, a turn start unsettling and waking its thread) and
// ThreadSettlementService.ts (isAutoSettlementCandidate, isSnoozed).
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
  AGENT_RUNTIME_CAPABILITY,
  APPROVAL_DECISIONS,
  INTERACTION_MODES,
  RUNTIME_MODES,
  THREADS_STREAM,
  applicableModelOptions,
  ThreadEvents,
  threadStream,
  type AgentItem,
  type AgentRegistry,
  type AgentRequest,
  type AgentResponse,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentTurn,
  type InteractionMode,
  type ModelOptionSelection,
  type RuntimeMode,
  type TurnAttachment,
} from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";

export { THREADS_STREAM };

const NAMESPACE = "jhin.threads";
const CONFIG_SECTION = "jhin.threads";
const DRAIN_TIMEOUT_MS = 5000;
/** How long archiving or deleting a thread waits for its turn to end after the interrupt. */
export const STOP_TIMEOUT_MS = 5000;
/** How long an agent runtime's `status()` answer is reused. */
const STATUS_TTL_MS = 30_000;
/** The title a thread gets until its first message names it. */
export const DEFAULT_THREAD_TITLE = "New thread";
const MAX_TITLE_LENGTH = 60;
/** Per image, as a data URL (base64 adds a third). */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
/** What `projects.write-file` writes at most: a plan, a note, never a dump. */
const MAX_WRITTEN_FILE_CHARS = 1_000_000;
/** All images of one message together, as data URLs: they are stored in the turn's first event. */
const MAX_ATTACHMENTS_TOTAL = 20 * 1024 * 1024;
const MAX_BROWSE_ENTRIES = 500;

/** Every node has this project for chats without a project (D51). */
export const SCRATCH_PROJECT = "scratch";

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
const Config = z
  .object({
    defaultAgent: z
      .string()
      .optional()
      .meta({
        title: "Default agent",
        description:
          "The agent runtime of new threads, by id (see agents.list); the first available one when unset.",
        examples: ["fake"],
      }),
  })
  .meta({
    title: "Threads",
    description: "Projects, threads and the agents that run their turns.",
  });
type Config = z.output<typeof Config>;

const Project = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute working directory on this node. */
  path: z.string(),
  scratch: z.boolean(),
  createdAt: z.string(),
});
type Project = z.infer<typeof Project>;

const TurnStatus = z.enum(["running", "waiting", "completed", "interrupted", "failed"]);
type TurnStatus = z.infer<typeof TurnStatus>;
const ENDED: ReadonlySet<TurnStatus> = new Set(["completed", "interrupted", "failed"]);

const Thread = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  /** Last change of the thread: created, renamed, a turn started or ended. */
  updatedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  /** What the next turn runs with unless the message says otherwise (sticky per thread). */
  agentId: z.string().optional(),
  model: z.string().optional(),
  runtimeMode: z.enum(RUNTIME_MODES).optional(),
  interactionMode: z.enum(INTERACTION_MODES).optional(),
  /** Values chosen for the model's options (D297), kept with the model they are for. */
  modelOptions: z
    .array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) }))
    .optional(),
  /** The latest turn, for lists: `waiting` means it asks the user something. */
  lastTurn: z
    .object({
      turnId: z.string(),
      status: TurnStatus,
      at: z.string(),
      agentId: z.string(),
      /** What a waiting turn asks for. */
      waitingFor: z.enum(["approval", "user-input"]).optional(),
    })
    .optional(),
  // Where the sidebar keeps the thread (D75–D78). These are the user's
  // arrangement, not activity: changing them leaves `updatedAt` alone.
  /** Settled or kept active by hand; overrides the automatic rule until the next turn. */
  settledOverride: z.enum(["settled", "active"]).optional(),
  /** When the thread was settled by hand. */
  settledAt: z.string().optional(),
  /** When it last came back from the Settled shelf: it sorts as if created then. */
  unsettledAt: z.string().optional(),
  pinnedAt: z.string().optional(),
  /** The pinned thread's place among the pinned ones (a fractional key, T3 Code's). */
  pinOrderKey: z.string().optional(),
  /** The thread's place among the active ones once dragged there. */
  activeOrderKey: z.string().optional(),
  /** Hidden until then, unless it asks for something, fails or completes meanwhile. */
  snoozedUntil: z.string().optional(),
  snoozedAt: z.string().optional(),
  /** When a snooze last ended by hand: the automatic rule counts it as activity. */
  lastSnoozeWakeAt: z.string().optional(),
  /** The thread that delegated this one's work (docs/plans/orchestration.md, D363). */
  parentThreadId: z.string().optional(),
  /** How it relates to `parentThreadId`: a delegated child task's thread is a `subagent`. */
  relationshipToParent: z.enum(["subagent"]).optional(),
});
type Thread = z.infer<typeof Thread>;

/** T3 Code's default for settling a thread by itself; the web client's rule (D70) twins this one. */
const AUTO_SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** A fractional order key: lowercase letters, compared as strings (T3 Code's pin order keys). */
const OrderKey = z
  .string()
  .regex(/^[a-z]*[b-z]$/, "must be lowercase letters, not ending in a")
  .max(64);

/** A time in milliseconds; NaN when absent or unreadable. */
const millis = (at: string | undefined) => (at === undefined ? Number.NaN : Date.parse(at));

/**
 * A snoozed thread that asked for something, failed or completed since it was
 * snoozed is awake again before its time (T3 Code's threadRaisedHandWhileSnoozed).
 */
function raisedHand(thread: Thread): boolean {
  const turn = thread.lastTurn;
  if (turn === undefined) return false;
  if (turn.status === "waiting") return true;
  if (turn.status !== "failed" && turn.status !== "completed") return false;
  const snoozedAt = millis(thread.snoozedAt);
  return Number.isNaN(snoozedAt) ? turn.status === "failed" : millis(turn.at) > snoozedAt;
}

/** Hidden on the Snoozed shelf now. */
function isSnoozed(thread: Thread, nowMs: number): boolean {
  const until = millis(thread.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs && !raisedHand(thread);
}

/**
 * Whether the sidebar shows the thread on its Settled shelf now: settled by
 * hand, or by T3 Code's automatic rule (no activity for three days, nothing
 * running or waiting, not pinned, not snoozed, not kept active by hand).
 */
function isSettled(thread: Thread, nowMs: number): boolean {
  if (thread.settledOverride !== undefined) return thread.settledOverride === "settled";
  return autoSettledAt(thread, nowMs) !== undefined;
}

/**
 * When the automatic rule settled the thread, if it did: as of its last
 * activity, a snooze that ended counting as activity (the web client's twin).
 */
function autoSettledAt(thread: Thread, nowMs: number): string | undefined {
  if (thread.pinnedAt !== undefined || isSnoozed(thread, nowMs)) return undefined;
  const status = thread.lastTurn?.status;
  if (status === "running" || status === "waiting") return undefined;
  const until = millis(thread.snoozedUntil);
  const activity = Math.max(
    ...[thread.lastTurn?.at ?? thread.updatedAt ?? thread.createdAt, thread.lastSnoozeWakeAt]
      .map(millis)
      .filter((value) => !Number.isNaN(value)),
    until <= nowMs ? until : Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(activity) && activity < nowMs - AUTO_SETTLE_AFTER_MS
    ? new Date(activity).toISOString()
    : undefined;
}

/**
 * What a new turn changes in the thread's arrangement, as T3 Code's turn start
 * does: a settled thread comes back to the top of the active ones, a snoozed
 * one wakes, and a choice made by hand gives way to the automatic rule again.
 */
function revived(thread: Thread, at: string): Thread {
  const nowMs = Date.parse(at);
  const settled = isSettled(thread, nowMs);
  if (!settled && thread.settledOverride === undefined && thread.snoozedUntil === undefined) {
    return thread;
  }
  const {
    settledOverride: _override,
    settledAt: _settledAt,
    snoozedUntil: _until,
    snoozedAt: _snoozedAt,
    ...rest
  } = thread;
  if (!settled) return rest;
  // Back from the shelf: on top of the active threads, out of any dragged order.
  const { activeOrderKey: _key, ...unordered } = rest;
  return { ...unordered, unsettledAt: at };
}

const StoredEventSchema = z.object({
  stream: z.string(),
  sequence: z.number(),
  type: z.string(),
  payload: z.unknown(),
  at: z.string(),
});

const Attachment = z.object({
  kind: z.literal("image"),
  name: z.string().min(1).max(255),
  mimeType: z.string().regex(/^image\/[\w.+-]+$/, "must be an image type"),
  dataUrl: z
    .string()
    .startsWith("data:image/", "must be a data URL of an image")
    .max(MAX_ATTACHMENT_BYTES, "is too large"),
});

const ModelOptionSelectionSchema = z.object({
  id: z.string().min(1).max(100),
  value: z.union([z.string().max(100), z.boolean()]),
});

const AgentSettings = {
  agentId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimeMode: z.enum(RUNTIME_MODES).optional(),
  interactionMode: z.enum(INTERACTION_MODES).optional(),
  /** Values for the model's options (D297); ones the model does not declare are dropped. */
  modelOptions: z.array(ModelOptionSelectionSchema).max(20).optional(),
};

const ModelOptionDescriptorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select"),
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    options: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
        isDefault: z.boolean().optional(),
      }),
    ),
    promptInjectedValues: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }),
]);

/** Equal records keep their thread untouched; option lists compare by value. */
const sameValue = (left: unknown, right: unknown) =>
  left === right ||
  (typeof left === "object" &&
    typeof right === "object" &&
    JSON.stringify(left) === JSON.stringify(right));

const Response: z.ZodType<AgentResponse> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval"), decision: z.enum(APPROVAL_DECISIONS) }),
  z.object({
    kind: z.literal("user-input"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
]);

const AgentInfo = z.object({
  agentId: z.string(),
  name: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      options: z.array(ModelOptionDescriptorSchema).optional(),
    }),
  ),
  defaultModel: z.string().optional(),
  runtimeModes: z.array(z.enum(RUNTIME_MODES)),
  interactionModes: z.array(z.enum(INTERACTION_MODES)),
  available: z.boolean(),
  message: z.string().optional(),
  version: z.string().optional(),
  /** The agent a thread without a chosen agent runs. */
  default: z.boolean(),
});

class ThreadsError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

interface Running {
  readonly turnId: string;
  readonly agentId: string;
  /** Set once the agent started; an interrupt before that is applied when it does. */
  turn: AgentTurn | undefined;
  readonly done: Promise<void>;
  interrupted: boolean;
  /** Requests the agent opened that nobody answered yet, with the kind of answer each takes. */
  readonly openRequests: Map<string, AgentRequest["kind"]>;
  /** Answers being recorded; the turn's end waits for them. */
  readonly answering: Map<string, Promise<unknown>>;
  /** The agent's item being recorded; the turn's end waits for it too. */
  recording: Promise<unknown> | undefined;
  /** Set once the turn's end is being recorded: the agent takes no more answers. */
  ending: boolean;
  /**
   * Ends the turn without the agent, for an agent that ignores its interrupt;
   * set once the agent started.
   */
  abandon: ((reason: string) => Promise<void>) | undefined;
  /** Why a stop gave up on the agent before it started: it is ended as soon as it starts. */
  giveUp: string | undefined;
}

/** What a turn with open requests waits for: an approval, if one is open, else answers. */
function awaitedKind(open: ReadonlyMap<string, AgentRequest["kind"]>): AgentRequest["kind"] {
  return [...open.values()].includes("approval") ? "approval" : "user-input";
}

/** The first line of a message, shortened at a word: the title of a new thread. */
export function titleFromText(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  const flat = line.replace(/\s+/g, " ");
  if (flat === "") return DEFAULT_THREAD_TITLE;
  if (flat.length <= MAX_TITLE_LENGTH) return flat;
  const cut = flat.slice(0, MAX_TITLE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `~` and `~/…` stand for the home directory; any other path is taken as given. */
function expandHome(path: string): string {
  if (path === "~") return Os.homedir();
  return path.startsWith("~/") || path.startsWith(`~${Path.sep}`)
    ? Path.join(Os.homedir(), path.slice(2))
    : path;
}

export default definePlugin({
  async activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const paths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
    // Reading threads takes what threads.get takes (security.md D415).
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    if (live?.guard !== undefined) {
      context.subscriptions.add(live.guard(THREADS_STREAM, ["threads.read"]));
      context.subscriptions.add(live.guard("thread/", ["threads.read"]));
    }
    const active = new Map<string, Running>();
    /**
     * Threads being deleted, and those whose deletion failed after it was
     * recorded: no turn starts on them. Kept apart from archives, so an archive
     * never lifts a deletion's mark.
     */
    const deleted = new Set<string>();
    /** Archives under way: no turn starts on their threads; a second archive joins. */
    const archiving = new Map<string, Promise<Thread>>();
    /**
     * Deletions under way, by thread, and those that failed after the thread's
     * stream recorded it deleted: deleting the thread again finishes them.
     */
    const deletions = new Map<
      string,
      { readonly thread: Thread; recorded: boolean; running: Promise<void> | undefined }
    >();
    /**
     * Projects being removed, and removed ones: no thread is created in them.
     * Kept after a removal, one id each: a creation that read the project just
     * before it went checks this mark only after its read.
     */
    const removedProjects = new Set<string>();
    /** Project removals under way: a second removal of a project joins the first. */
    const projectRemovals = new Map<string, Promise<{ deletedThreads: number }>>();
    /** Thread creations under way, by project: a removal of the project waits for them. */
    const creations = new Map<string, Set<Promise<unknown>>>();
    const archivedError = (threadId: string) =>
      new ThreadsError("THREAD_ARCHIVED", "The thread is archived: unarchive it to continue", {
        threadId,
      });
    // Before storage stops (it deactivates after this plugin), running turns are
    // interrupted and their last event recorded; an agent that ignores the
    // interrupt cannot hold shutdown for more than DRAIN_TIMEOUT_MS.
    context.onDeactivate(async () => {
      const entries = [...active.values()];
      for (const entry of entries) {
        entry.interrupted = true;
        entry.turn?.interrupt();
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>(
        (resolve) => (timer = setTimeout(resolve, DRAIN_TIMEOUT_MS)),
      );
      await Promise.race([Promise.all(entries.map((entry) => entry.done)), timeout]);
      clearTimeout(timer);
    });
    const now = () => new Date().toISOString();

    // --- Agent runtimes -------------------------------------------------------
    // Runtimes registered through agent.registry@1, then the node's single
    // agent.runtime@1 if a plugin provides one.
    const registered = new Map<string, AgentRuntime>();
    const registry: AgentRegistry = {
      register(runtime) {
        if (registered.has(runtime.agentId)) {
          throw new ThreadsError(
            "AGENT_DUPLICATE",
            `An agent ${runtime.agentId} is already registered`,
            { agentId: runtime.agentId },
          );
        }
        registered.set(runtime.agentId, runtime);
        statuses.delete(runtime.agentId);
        return toDisposable(() => {
          if (registered.get(runtime.agentId) === runtime) registered.delete(runtime.agentId);
        });
      },
      list: () => runtimes(),
      get: (agentId) => runtimes().find((runtime) => runtime.agentId === agentId),
    };
    context.services.provide(AGENT_REGISTRY_CAPABILITY, registry);
    const runtimes = (): AgentRuntime[] => {
      const single = context.services.tryGet<AgentRuntime>(AGENT_RUNTIME_CAPABILITY);
      return [
        ...registered.values(),
        ...(single === undefined || registered.has(single.agentId) ? [] : [single]),
      ];
    };
    const statuses = new Map<string, { at: number; status: AgentRuntimeStatus }>();
    const statusOf = async (runtime: AgentRuntime): Promise<AgentRuntimeStatus> => {
      if (runtime.status === undefined) return { available: true };
      const cached = statuses.get(runtime.agentId);
      if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
      let status: AgentRuntimeStatus;
      try {
        status = await runtime.status();
      } catch (error) {
        status = { available: false, message: String(error) };
      }
      statuses.set(runtime.agentId, { at: Date.now(), status });
      return status;
    };
    const defaultRuntime = async (): Promise<AgentRuntime | undefined> => {
      const all = runtimes();
      const configured = context.config.get<Config>(CONFIG_SECTION).defaultAgent;
      const chosen = all.find((runtime) => runtime.agentId === configured);
      if (chosen !== undefined) return chosen;
      for (const runtime of all) if ((await statusOf(runtime)).available) return runtime;
      return all[0];
    };

    // --- Records ---------------------------------------------------------------
    const getProject = async (id: string): Promise<Project> => {
      const value = await kv.get(NAMESPACE, `project/${id}`);
      if (value === undefined)
        throw new ThreadsError("PROJECT_NOT_FOUND", `No project ${id}`, { projectId: id });
      return Project.parse(value);
    };
    const getThread = async (id: string): Promise<Thread> => {
      const value = await kv.get(NAMESPACE, `thread/${id}`);
      if (value === undefined)
        throw new ThreadsError("THREAD_NOT_FOUND", `No thread ${id}`, { threadId: id });
      return Thread.parse(value);
    };
    const listThreads = async (): Promise<Thread[]> =>
      (await kv.list(NAMESPACE, { prefix: "thread/" }))
        .map((entry) => Thread.parse(entry.value))
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

    /**
     * Changes to one record run one at a time, so none overwrites another and
     * none writes back a record removed meanwhile: by thread id, and by
     * `project/<id>` for projects.
     */
    const pending = new Map<string, Promise<unknown>>();
    /** Runs `task` once the changes to the same record queued before it are done. */
    function queued<T>(id: string, task: () => Promise<T>): Promise<T> {
      const previous = pending.get(id) ?? Promise.resolve();
      const result = previous.then(task, task);
      const settled = result.catch(() => undefined);
      pending.set(id, settled);
      void settled.then(() => {
        if (pending.get(id) === settled) pending.delete(id);
      });
      return result;
    }
    function updateThread(id: string, change: (thread: Thread) => Thread): Promise<Thread> {
      return queued(id, async () => {
        const current = await getThread(id);
        const changed = change(current);
        if (changed === current) return current;
        const next = Thread.parse(changed);
        await kv.set(NAMESPACE, `thread/${id}`, next as unknown as Json);
        await log.append(THREADS_STREAM, [
          { type: ThreadEvents.threadUpdated, payload: next as unknown as Json },
        ]);
        return next;
      });
    }
    /** Records where the thread's latest turn is; failures are logged, never thrown. */
    const setTurnStatus = (
      threadId: string,
      turnId: string,
      agentId: string,
      status: TurnStatus,
      waitingFor?: "approval" | "user-input",
    ) =>
      updateThread(threadId, (thread) =>
        // A turn's late ending never overwrites the status of a newer turn, and
        // a turn that ended stays ended (an answer recorded as it ends says "running").
        (status !== "running" &&
          thread.lastTurn !== undefined &&
          thread.lastTurn.turnId !== turnId) ||
        (thread.lastTurn?.turnId === turnId &&
          ENDED.has(thread.lastTurn.status) &&
          !ENDED.has(status))
          ? thread
          : {
              ...thread,
              updatedAt: now(),
              lastTurn: {
                turnId,
                status,
                at: now(),
                agentId,
                ...(waitingFor === undefined ? {} : { waitingFor }),
              },
            },
      ).then(
        () => undefined,
        (error: unknown) =>
          context.log.error("could not record a turn's status", {
            threadId,
            turnId,
            status,
            error: String(error),
          }),
      );

    if ((await kv.get(NAMESPACE, `project/${SCRATCH_PROJECT}`)) === undefined) {
      const path = Path.join(paths.dataDir(context.plugin.id), "scratch");
      Fs.mkdirSync(path, { recursive: true });
      const scratch: Project = {
        id: SCRATCH_PROJECT,
        name: "No project",
        path,
        scratch: true,
        createdAt: now(),
      };
      await kv.set(NAMESPACE, `project/${SCRATCH_PROJECT}`, scratch);
    }

    // Threads made before the index existed are added to it once, oldest first.
    if ((await log.head(THREADS_STREAM)) === 0) {
      const existing = await listThreads();
      if (existing.length > 0) {
        await log.append(
          THREADS_STREAM,
          existing.map((thread) => ({
            type: ThreadEvents.threadCreated,
            payload: thread as unknown as Json,
          })),
        );
      }
    }

    // A turn still running or waiting when the node stopped without draining
    // (a crash) never got its last event: it is closed as interrupted now,
    // together with the requests it left open, as a live turn's end does (D56).
    for (const thread of await listThreads()) {
      const last = thread.lastTurn;
      if (last === undefined || (last.status !== "running" && last.status !== "waiting")) continue;
      const stream = threadStream(thread.id);
      // Read whole: a crash is rare, and the turn may have started long ago.
      const turnEvents = (await log.read(stream)).filter(
        (event) => (event.payload as { turnId?: unknown } | null)?.turnId === last.turnId,
      );
      const endings: Record<string, TurnStatus> = {
        [ThreadEvents.turnCompleted]: "completed",
        [ThreadEvents.turnInterrupted]: "interrupted",
        [ThreadEvents.turnFailed]: "failed",
      };
      const ended = turnEvents.findLast((event) => endings[event.type] !== undefined);
      if (ended === undefined) {
        const requestOf = (event: { payload: unknown }) =>
          (event.payload as { requestId?: unknown } | null)?.requestId;
        const resolved = new Set(
          turnEvents.filter((event) => event.type === ThreadEvents.requestResolved).map(requestOf),
        );
        const open = turnEvents
          .filter((event) => event.type === ThreadEvents.requestOpened)
          .map(requestOf)
          .filter((requestId): requestId is string => typeof requestId === "string")
          .filter((requestId) => !resolved.has(requestId));
        await log.append(stream, [
          ...open.map((requestId) => ({
            type: ThreadEvents.requestResolved,
            payload: { turnId: last.turnId, requestId },
          })),
          {
            type: ThreadEvents.turnInterrupted,
            payload: { turnId: last.turnId, reason: "The node stopped while the turn ran" },
          },
        ]);
      }
      await setTurnStatus(
        thread.id,
        last.turnId,
        last.agentId,
        ended === undefined ? "interrupted" : endings[ended.type]!,
      );
    }

    /**
     * Reserves the thread for a turn. Checking that it is free and taking it is
     * one synchronous step, so two sends can never both start a turn, nor a
     * send start one on a thread being archived or deleted. `release` frees the
     * thread once the turn's last event is recorded; `finish` (which releases
     * too) ends the turn's work for stops and the shutdown drain.
     */
    function reserve(
      threadId: string,
      turnId: string,
      agentId: string,
    ): { entry: Running; release: () => void; finish: () => void } {
      const current = active.get(threadId);
      if (current !== undefined) {
        throw new ThreadsError("TURN_IN_PROGRESS", "The thread is already running a turn", {
          threadId,
          turnId: current.turnId,
        });
      }
      if (deleted.has(threadId)) {
        throw new ThreadsError("THREAD_NOT_FOUND", `No thread ${threadId}`, { threadId });
      }
      if (archiving.has(threadId)) throw archivedError(threadId);
      let resolve!: () => void;
      const entry: Running = {
        turnId,
        agentId,
        turn: undefined,
        done: new Promise((done) => (resolve = done)),
        interrupted: false,
        openRequests: new Map(),
        answering: new Map(),
        recording: undefined,
        ending: false,
        abandon: undefined,
        giveUp: undefined,
      };
      active.set(threadId, entry);
      const release = () => {
        if (active.get(threadId) === entry) active.delete(threadId);
      };
      return {
        entry,
        release,
        finish: () => {
          release();
          resolve();
        },
      };
    }

    /** The thread-stream event an agent item becomes. */
    function eventOf(turnId: string, item: AgentItem): { type: string; payload: Json } {
      switch (item.kind) {
        case "message.delta":
        case "reasoning.delta":
          return {
            type: ThreadEvents.itemDelta,
            payload: {
              turnId,
              itemId: item.itemId,
              kind: item.kind === "message.delta" ? "message" : "reasoning",
              text: item.text,
            },
          };
        case "message.completed":
        case "reasoning.completed":
          return {
            type: ThreadEvents.itemCompleted,
            payload: {
              turnId,
              itemId: item.itemId,
              kind: item.kind === "message.completed" ? "message" : "reasoning",
              text: item.text,
            },
          };
        case "tool.started":
          return {
            type: ThreadEvents.itemStarted,
            payload: {
              turnId,
              itemId: item.itemId,
              kind: "tool",
              tool: item.tool as unknown as Json,
            },
          };
        case "tool.output":
          return {
            type: ThreadEvents.itemDelta,
            payload: { turnId, itemId: item.itemId, kind: "tool", text: item.text },
          };
        case "tool.completed":
          return {
            type: ThreadEvents.itemCompleted,
            payload: {
              turnId,
              itemId: item.itemId,
              kind: "tool",
              status: item.status,
              ...(item.output === undefined ? {} : { output: item.output }),
              ...(item.error === undefined ? {} : { error: item.error }),
            },
          };
        case "request.opened":
          return {
            type: ThreadEvents.requestOpened,
            payload: {
              turnId,
              requestId: item.requestId,
              request: item.request as unknown as Json,
            },
          };
        case "plan.updated":
          return {
            type: ThreadEvents.planUpdated,
            payload: { turnId, steps: item.steps as unknown as Json },
          };
        case "plan.proposed":
          return {
            type: ThreadEvents.planProposed,
            payload: { turnId, itemId: item.itemId, markdown: item.markdown },
          };
        case "usage":
          return {
            type: ThreadEvents.usageUpdated,
            payload: { turnId, usage: item.usage as unknown as Json },
          };
      }
    }

    interface TurnSettings {
      readonly model?: string;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: InteractionMode;
      readonly modelOptions?: ModelOptionSelection[];
    }

    async function runTurn(
      thread: Thread,
      input: { text: string; attachments?: readonly TurnAttachment[] },
      runtime: AgentRuntime,
      settings: TurnSettings,
      { entry, release, finish }: ReturnType<typeof reserve>,
    ): Promise<void> {
      const { turnId } = entry;
      const stream = threadStream(thread.id);
      let turn: AgentTurn;
      try {
        const project = await getProject(thread.projectId);
        const history = await log.read(stream);
        // The record says the turn runs before its first event is written: a node
        // that stops in between finds it on restart and closes it.
        await setTurnStatus(thread.id, turnId, runtime.agentId, "running");
        try {
          await log.append(stream, [
            {
              type: ThreadEvents.turnStarted,
              payload: {
                turnId,
                agentId: runtime.agentId,
                input: input as unknown as Json,
                ...(settings as unknown as Record<string, Json>),
              },
            },
          ]);
        } catch (error) {
          // Never started: the record does not say it runs.
          await setTurnStatus(thread.id, turnId, runtime.agentId, "failed");
          throw error;
        }
        try {
          turn = runtime.startTurn({
            threadId: thread.id,
            turnId,
            input,
            history,
            cwd: project.path,
            ...settings,
          });
        } catch (error) {
          // turn.started is already recorded: close it, keeping the agent's error for the caller.
          await log
            .append(stream, [
              { type: ThreadEvents.turnFailed, payload: { turnId, error: String(error) } },
            ])
            .catch((appendError: unknown) =>
              context.log.error("could not record a failed start", {
                turnId,
                error: String(appendError),
              }),
            );
          await setTurnStatus(thread.id, turnId, runtime.agentId, "failed");
          throw error;
        }
      } catch (error) {
        finish();
        throw error;
      }
      entry.turn = turn;
      if (entry.interrupted) turn.interrupt();
      /** Appends a turn's last events; a storage failure here is logged, never thrown. */
      const recordEnd = (type: string, payload: Json) =>
        log.append(stream, [{ type, payload }]).then(
          () => undefined,
          (appendError: unknown) =>
            context.log.error("could not record the end of a turn", {
              threadId: thread.id,
              turnId,
              error: String(appendError),
            }),
        );
      /** Requests left open when the turn ends are closed without an answer. */
      const closeRequests = async () => {
        // The item and the answers being recorded go first: a request is
        // recorded opened (and maybe answered) before it is closed.
        await Promise.allSettled([entry.recording, ...entry.answering.values()]);
        const open = [...entry.openRequests.keys()];
        entry.openRequests.clear();
        for (const requestId of open) {
          await recordEnd(ThreadEvents.requestResolved, { turnId, requestId });
        }
      };
      /** Records the end of the turn once, whether the agent ended it or a stop gave up on it. */
      const end = async (ending: {
        type: string;
        status: TurnStatus;
        error?: string;
        reason?: string;
      }) => {
        if (entry.ending) return;
        entry.ending = true;
        try {
          await closeRequests();
          await recordEnd(ending.type, {
            turnId,
            ...(ending.error === undefined ? {} : { error: ending.error }),
            ...(ending.reason === undefined ? {} : { reason: ending.reason }),
          });
        } finally {
          // Once its last event is recorded the thread takes the next message.
          release();
        }
        try {
          await setTurnStatus(thread.id, turnId, runtime.agentId, ending.status);
        } finally {
          finish();
        }
      };
      const items = turn.items[Symbol.asyncIterator]();
      /** Stops the wait for the agent's next item, once the turn is given up on. */
      let wake: (() => void) | undefined;
      const nextItem = () =>
        new Promise<IteratorResult<AgentItem> | undefined>((resolve, reject) => {
          wake = () => resolve(undefined);
          items.next().then(resolve, reject);
        });
      entry.abandon = (reason) => {
        const ended = end({ type: ThreadEvents.turnInterrupted, status: "interrupted", reason });
        // Given up on: the loop stops waiting for an agent that may never answer.
        wake?.();
        return ended;
      };
      // A stop gave up on it while it was starting: it ends now.
      if (entry.giveUp !== undefined) void entry.abandon(entry.giveUp);
      void (async () => {
        let ending: { type: string; status: TurnStatus; error?: string };
        try {
          // A turn that delivered its answer is complete even if an interrupt came late.
          let answered = false;
          while (!entry.ending) {
            const next = await nextItem();
            // Given up on (it ignored an interrupt): what the agent still says is dropped.
            if (next === undefined || next.done === true || entry.ending) break;
            const item = next.value;
            answered = item.kind === "message.completed";
            if (item.kind === "request.opened") {
              entry.openRequests.set(item.requestId, item.request.kind);
            }
            const recording = log.append(stream, [eventOf(turnId, item)]);
            entry.recording = recording;
            try {
              await recording;
            } catch (error) {
              // Never recorded, so never asked: there is nothing to close.
              if (item.kind === "request.opened") entry.openRequests.delete(item.requestId);
              throw error;
            } finally {
              if (entry.recording === recording) entry.recording = undefined;
            }
            if (item.kind === "request.opened") {
              await setTurnStatus(
                thread.id,
                turnId,
                runtime.agentId,
                "waiting",
                awaitedKind(entry.openRequests),
              );
            }
          }
          ending =
            entry.interrupted && !answered
              ? { type: ThreadEvents.turnInterrupted, status: "interrupted" }
              : { type: ThreadEvents.turnCompleted, status: "completed" };
        } catch (error) {
          context.log.warn("turn failed", { threadId: thread.id, turnId, error: String(error) });
          ending = { type: ThreadEvents.turnFailed, status: "failed", error: String(error) };
        } finally {
          // Its items are closed, so an agent still going may clean up; it is not waited for.
          void Promise.resolve(items.return?.()).catch(() => undefined);
        }
        await end(ending);
      })();
    }

    /**
     * Stops a thread's running turn, if any, and waits until it has ended. An
     * agent that ignores the interrupt for STOP_TIMEOUT_MS is given up on: its
     * turn is recorded as interrupted and the thread released. A turn still
     * starting then is given up on as soon as it has started; its start only
     * waits on storage, as recording its end would.
     */
    async function stopTurn(threadId: string): Promise<void> {
      const current = active.get(threadId);
      if (current === undefined) return;
      current.interrupted = true;
      current.turn?.interrupt();
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([
        current.done.then(() => true),
        new Promise<false>(
          (resolve) => (timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
        ),
      ]);
      clearTimeout(timer);
      if (stopped) return;
      const reason = "The agent did not stop when interrupted";
      // An agent still starting has no turn to give up on yet: it is given up
      // on once it starts. Either way the turn's last events are recorded once
      // it is done, also when the agent ended it just now.
      if (current.abandon === undefined) current.giveUp = reason;
      else await current.abandon(reason);
      await current.done;
    }

    /** Deletes a thread once: a deletion already under way is joined, not repeated. */
    function deleteThread(thread: Thread): Promise<void> {
      const deletion = deletions.get(thread.id) ?? { thread, recorded: false, running: undefined };
      if (deletion.running !== undefined) return deletion.running;
      deletions.set(thread.id, deletion);
      // From here on no turn starts on it, so none writes after its deleted event.
      deleted.add(thread.id);
      deletion.running = (async () => {
        try {
          if (!deletion.recorded) {
            await stopTurn(thread.id);
            await log.append(threadStream(thread.id), [
              { type: ThreadEvents.threadDeleted, payload: { id: thread.id } },
            ]);
            // Its stream says deleted: it stays closed to turns, whatever fails next.
            deletion.recorded = true;
          }
          // After the changes to its record already under way: none writes it back.
          await queued(thread.id, () => kv.delete(NAMESPACE, `thread/${thread.id}`));
          await log.append(THREADS_STREAM, [
            { type: ThreadEvents.threadDeleted, payload: { id: thread.id } },
          ]);
          deletions.delete(thread.id);
          // Gone: its record is, so nothing takes it for a thread any more.
          deleted.delete(thread.id);
        } catch (error) {
          deletion.running = undefined;
          if (!deletion.recorded) {
            // Not deleted after all: the thread is as it was and takes messages again.
            deletions.delete(thread.id);
            deleted.delete(thread.id);
          }
          throw error;
        }
      })();
      return deletion.running;
    }

    const projectEvent = (type: string, payload: Json) =>
      log.append(THREADS_STREAM, [{ type, payload }]);

    // --- Projects --------------------------------------------------------------
    context.commands.register({
      name: "projects.list",
      description: "Projects on this node, the scratch project first",
      input: z.object({}),
      output: z.array(Project),
      permissions: ["projects.read"],
      handler: async () =>
        (await kv.list(NAMESPACE, { prefix: "project/" }))
          .map((entry) => Project.parse(entry.value))
          .toSorted(
            (a, b) =>
              Number(b.scratch) - Number(a.scratch) || a.createdAt.localeCompare(b.createdAt),
          ),
    });

    context.commands.register({
      name: "projects.create",
      description:
        "Registers a working directory on this node as a project; the name defaults to the folder's",
      input: z.object({ name: z.string().min(1).optional(), path: z.string().min(1) }),
      output: Project,
      permissions: ["projects.write"],
      handler: async ({ name, path: given }) => {
        const expanded = expandHome(given);
        // Stored normalised: "/a/../b" becomes "/b".
        const path = Path.resolve(expanded);
        if (
          !Path.isAbsolute(expanded) ||
          !Fs.existsSync(path) ||
          !Fs.statSync(path).isDirectory()
        ) {
          throw new ThreadsError(
            "PROJECT_PATH_INVALID",
            `${path} is not an existing absolute directory`,
            { path },
          );
        }
        const project: Project = {
          id: Crypto.randomUUID(),
          name: name ?? (Path.basename(path) || path),
          path,
          scratch: false,
          createdAt: now(),
        };
        await kv.set(NAMESPACE, `project/${project.id}`, project);
        await projectEvent(ThreadEvents.projectCreated, project as unknown as Json);
        return project;
      },
    });

    context.commands.register({
      name: "projects.update",
      description: "Renames a project",
      input: z.object({ projectId: z.string(), name: z.string().trim().min(1) }),
      output: Project,
      permissions: ["projects.write"],
      // One change of a project's record at a time, its removal included.
      handler: ({ projectId, name }) =>
        queued(`project/${projectId}`, async () => {
          if (removedProjects.has(projectId)) {
            throw new ThreadsError("PROJECT_NOT_FOUND", `No project ${projectId}`, { projectId });
          }
          const project = await getProject(projectId);
          if (project.scratch) {
            throw new ThreadsError("PROJECT_IS_SCRATCH", "The scratch project cannot be renamed", {
              projectId,
            });
          }
          const next: Project = { ...project, name };
          await kv.set(NAMESPACE, `project/${projectId}`, next);
          await projectEvent(ThreadEvents.projectUpdated, next as unknown as Json);
          return next;
        }),
    });

    context.commands.register({
      name: "projects.delete",
      description:
        "Removes a project and deletes its threads; its directory stays on disk untouched",
      input: z.object({ projectId: z.string() }),
      output: z.object({ deletedThreads: z.number() }),
      permissions: ["projects.write"],
      handler: ({ projectId }) => {
        const running = projectRemovals.get(projectId);
        if (running !== undefined) return running;
        const removal = removeProject(projectId);
        projectRemovals.set(projectId, removal);
        void removal.then(
          () => projectRemovals.delete(projectId),
          () => projectRemovals.delete(projectId),
        );
        return removal;
      },
    });

    async function removeProject(projectId: string): Promise<{ deletedThreads: number }> {
      const project = await getProject(projectId);
      if (project.scratch) {
        throw new ThreadsError("PROJECT_IS_SCRATCH", "The scratch project cannot be removed", {
          projectId,
        });
      }
      // From here on no thread is created in it, and those being created are
      // waited for, so none is left behind.
      removedProjects.add(projectId);
      let removed = false;
      try {
        await Promise.allSettled(creations.get(projectId) ?? []);
        const threads = (await listThreads()).filter((thread) => thread.projectId === projectId);
        for (const thread of threads) await deleteThread(thread);
        // After a rename under way: none writes the project back.
        await queued(`project/${projectId}`, () => kv.delete(NAMESPACE, `project/${projectId}`));
        removed = true;
        await projectEvent(ThreadEvents.projectDeleted, { id: projectId });
        return { deletedThreads: threads.length };
      } catch (error) {
        // The project is still there: threads can be created in it again.
        if (!removed) removedProjects.delete(projectId);
        throw error;
      }
    }

    context.commands.register({
      name: "projects.write-file",
      description:
        "Writes a text file inside a project's directory (a path relative to it), creating its folders; T3 Code's 'Save to workspace'",
      input: z.object({
        projectId: z.string(),
        path: z.string().trim().min(1).max(1024),
        contents: z.string().max(MAX_WRITTEN_FILE_CHARS),
      }),
      output: z.object({ path: z.string(), relativePath: z.string() }),
      permissions: ["projects.write"],
      handler: async ({ projectId, path, contents }) => {
        const project = await getProject(projectId);
        const root = Path.resolve(project.path);
        const target = Path.resolve(root, path);
        const relativePath = Path.relative(root, target);
        const outside = (relative: string) =>
          relative === ".." || relative.startsWith(`..${Path.sep}`) || Path.isAbsolute(relative);
        const refuse = () =>
          new ThreadsError(
            "PATH_OUTSIDE_PROJECT",
            "The path must be inside the project, and not a link",
            { projectId, path },
          );
        if (relativePath === "" || outside(relativePath)) throw refuse();
        // A link inside the project must not lead the write out of it: not a folder
        // on the way (resolved before and after creating the missing ones), nor the
        // file itself (refused, and never followed where the platform can say so).
        // A link swapped in between these steps by someone who can already write
        // into the project is not guarded against.
        const realRoot = await Fs.promises.realpath(root);
        const inside = async (folder: string) => {
          const real = await Fs.promises.realpath(folder).catch(() => undefined);
          return real !== undefined && !outside(Path.relative(realRoot, real));
        };
        const lexists = (candidate: string) =>
          Fs.promises.lstat(candidate).then(
            () => true,
            () => false,
          );
        let parent = Path.dirname(target);
        while (!(await lexists(parent))) parent = Path.dirname(parent);
        // A folder that is a dangling link resolves nowhere: refused too.
        if (!(await inside(parent))) throw refuse();
        try {
          await Fs.promises.mkdir(Path.dirname(target), { recursive: true });
        } catch {
          throw refuse();
        }
        if (!(await inside(Path.dirname(target)))) throw refuse();
        const existing = await Fs.promises.lstat(target).catch(() => undefined);
        if (existing !== undefined && !existing.isFile()) throw refuse();
        let file: Fs.promises.FileHandle;
        try {
          file = await Fs.promises.open(
            target,
            Fs.constants.O_WRONLY |
              Fs.constants.O_CREAT |
              Fs.constants.O_TRUNC |
              (Fs.constants.O_NOFOLLOW ?? 0),
            0o644,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOOP") throw refuse();
          throw error;
        }
        try {
          await file.writeFile(contents, "utf8");
        } finally {
          await file.close();
        }
        return { path: target, relativePath: relativePath.split(Path.sep).join("/") };
      },
    });

    context.commands.register({
      name: "projects.browse",
      description:
        "Folders inside a directory of this node (the home directory by default), for picking a project",
      input: z.object({ path: z.string().optional() }),
      output: z.object({
        path: z.string(),
        parent: z.string().optional(),
        home: z.string(),
        entries: z.array(z.object({ name: z.string(), path: z.string(), git: z.boolean() })),
      }),
      // It reads any folder the node can: a permission of its own, granted on purpose.
      permissions: ["projects.browse"],
      // Asynchronous throughout: a slow or network mount must not hold the node.
      handler: async ({ path: given }) => {
        const home = Os.homedir();
        const raw = given === undefined || given.trim() === "" ? home : given.trim();
        const expanded = expandHome(raw);
        if (!Path.isAbsolute(expanded)) {
          throw new ThreadsError("PATH_INVALID", `${raw} is not an absolute path`, { path: raw });
        }
        const path = Path.resolve(expanded);
        let names: Fs.Dirent[];
        try {
          names = await Fs.promises.readdir(path, { withFileTypes: true });
        } catch {
          throw new ThreadsError("PATH_INVALID", `${path} cannot be read`, { path });
        }
        const exists = (target: string) =>
          Fs.promises.access(target).then(
            () => true,
            () => false,
          );
        // A link to a folder is a folder too; a link that leads nowhere is not.
        const isFolder = async (entry: Fs.Dirent) =>
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await Fs.promises.stat(Path.join(path, entry.name)).then(
              (stat) => stat.isDirectory(),
              () => false,
            )));
        const folders = await Promise.all(
          names
            .filter((entry) => !entry.name.startsWith("."))
            .map(async (entry) => ((await isFolder(entry)) ? entry.name : undefined)),
        );
        const entries = await Promise.all(
          folders
            .filter((name): name is string => name !== undefined)
            .toSorted((a, b) => a.localeCompare(b))
            .slice(0, MAX_BROWSE_ENTRIES)
            .map(async (name) => {
              const full = Path.join(path, name);
              return { name, path: full, git: await exists(Path.join(full, ".git")) };
            }),
        );
        const parent = Path.dirname(path);
        return { path, ...(parent === path ? {} : { parent }), home, entries };
      },
    });

    // --- Agents ----------------------------------------------------------------
    context.commands.register({
      name: "agents.list",
      description: "Agent runtimes on this node with their models, modes and whether they can run",
      input: z.object({}),
      output: z.array(AgentInfo),
      permissions: ["threads.read"],
      handler: async () => {
        const all = runtimes();
        const fallback = await defaultRuntime();
        return Promise.all(
          all.map(async (runtime) => {
            const status = await statusOf(runtime);
            return {
              agentId: runtime.agentId,
              name: runtime.name ?? runtime.agentId,
              models: (runtime.models ?? []).map(({ options, ...model }) => ({
                ...model,
                ...(options === undefined
                  ? {}
                  : {
                      options: structuredClone(options) as z.infer<
                        typeof ModelOptionDescriptorSchema
                      >[],
                    }),
              })),
              ...(runtime.defaultModel === undefined ? {} : { defaultModel: runtime.defaultModel }),
              runtimeModes: [...(runtime.runtimeModes ?? ["full-access"])],
              interactionModes: [...(runtime.interactionModes ?? ["default"])],
              available: status.available,
              ...(status.message === undefined ? {} : { message: status.message }),
              ...(status.version === undefined ? {} : { version: status.version }),
              default: runtime === fallback,
            };
          }),
        );
      },
    });

    // --- Threads ---------------------------------------------------------------
    context.commands.register({
      name: "threads.list",
      description:
        "Threads on this node, oldest first, optionally of one project; archived ones included",
      input: z.object({ projectId: z.string().optional() }),
      output: z.array(Thread),
      permissions: ["threads.read"],
      handler: async ({ projectId }) =>
        (await listThreads()).filter(
          (thread) => projectId === undefined || thread.projectId === projectId,
        ),
    });

    context.commands.register({
      name: "threads.catalog",
      description:
        "Every project and thread of this node, and the head of the `threads` index they reflect: follow the index after `head` to keep them current",
      input: z.object({}),
      output: z.object({ head: z.number(), projects: z.array(Project), threads: z.array(Thread) }),
      permissions: ["threads.read"],
      handler: async () => {
        // The head first: a change made while the lists are read is then also
        // delivered after it (applying a record again is harmless).
        const head = await log.head(THREADS_STREAM);
        const projects = (await kv.list(NAMESPACE, { prefix: "project/" }))
          .map((entry) => Project.parse(entry.value))
          .toSorted(
            (a, b) =>
              Number(b.scratch) - Number(a.scratch) || a.createdAt.localeCompare(b.createdAt),
          );
        return { head, projects, threads: await listThreads() };
      },
    });

    context.commands.register({
      name: "threads.create",
      description: "Starts a thread in a project (the scratch project by default)",
      input: z.object({
        projectId: z.string().default(SCRATCH_PROJECT),
        title: z.string().min(1).default(DEFAULT_THREAD_TITLE),
        ...AgentSettings,
        parentThreadId: z.string().min(1).optional(),
        relationshipToParent: z.enum(["subagent"]).optional(),
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ projectId, title, ...settings }) => {
        await getProject(projectId);
        if (settings.parentThreadId !== undefined) {
          // A child shares its parent's project (docs/plans/orchestration.md, D363).
          const parent = await getThread(settings.parentThreadId);
          if (parent.projectId !== projectId) {
            throw new ThreadsError(
              "PARENT_PROJECT_MISMATCH",
              `Thread ${parent.id} is in another project than ${projectId}`,
              { parentThreadId: parent.id, projectId },
            );
          }
        }
        if (removedProjects.has(projectId)) {
          throw new ThreadsError("PROJECT_NOT_FOUND", `No project ${projectId}`, { projectId });
        }
        // A removal of the project that starts meanwhile waits for this thread.
        const creating = createThread(projectId, title, settings);
        const underWay = creations.get(projectId) ?? new Set<Promise<unknown>>();
        creations.set(projectId, underWay.add(creating));
        try {
          return await creating;
        } finally {
          underWay.delete(creating);
          if (underWay.size === 0 && creations.get(projectId) === underWay) {
            creations.delete(projectId);
          }
        }
      },
    });

    async function createThread(
      projectId: string,
      title: string,
      settings: Omit<Thread, "id" | "projectId" | "title" | "createdAt" | "updatedAt">,
    ): Promise<Thread> {
      const createdAt = now();
      const thread: Thread = Thread.parse({
        id: Crypto.randomUUID(),
        projectId,
        title,
        createdAt,
        updatedAt: createdAt,
        ...settings,
      });
      // The stream's first event comes first: a thread record never exists without it.
      await log.append(threadStream(thread.id), [
        { type: ThreadEvents.threadCreated, payload: thread as unknown as Json },
      ]);
      await kv.set(NAMESPACE, `thread/${thread.id}`, thread as unknown as Json);
      // Then the node's index of threads, which other nodes follow to mirror new
      // threads (D26 eager): whoever learns of the thread there can read it.
      await log.append(THREADS_STREAM, [
        { type: ThreadEvents.threadCreated, payload: thread as unknown as Json },
      ]);
      return thread;
    }

    context.commands.register({
      name: "threads.get",
      description: "A thread, its stream name and the sequence of its last event",
      input: z.object({ threadId: z.string() }),
      output: z.object({
        thread: Thread,
        stream: z.string(),
        head: z.number(),
        running: z.string().optional(),
      }),
      permissions: ["threads.read"],
      handler: async ({ threadId }) => {
        const thread = await getThread(threadId);
        const turn = active.get(threadId);
        return {
          thread,
          stream: threadStream(threadId),
          head: await log.head(threadStream(threadId)),
          ...(turn === undefined ? {} : { running: turn.turnId }),
        };
      },
    });

    context.commands.register({
      name: "threads.update",
      description: "Renames a thread or changes the agent, model and modes its next turns run with",
      input: z.object({
        threadId: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        ...AgentSettings,
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ threadId, title, ...settings }) => {
        if (settings.agentId !== undefined && registry.get(settings.agentId) === undefined) {
          throw new ThreadsError("AGENT_NOT_FOUND", `No agent ${settings.agentId} on this node`, {
            agentId: settings.agentId,
          });
        }
        const fallback = await defaultRuntime();
        return updateThread(threadId, (thread) => {
          const next: Thread = {
            ...thread,
            ...(title === undefined ? {} : { title }),
            ...settings,
          };
          // A model named for another agent does not carry over to a new one.
          const agentChanged =
            settings.agentId !== undefined && settings.agentId !== thread.agentId;
          if (agentChanged && settings.model === undefined) {
            delete (next as { model?: string }).model;
          }
          // The model each record runs: naming the default model changes nothing.
          const runtimeOf = (agentId: string | undefined) =>
            (agentId === undefined ? undefined : registry.get(agentId)) ?? fallback;
          const runtime = runtimeOf(next.agentId);
          const modelOf = (candidate: AgentRuntime | undefined, model: string | undefined) =>
            model ?? candidate?.defaultModel ?? candidate?.models?.[0]?.id;
          const effectiveModel = modelOf(runtime, next.model);
          // Options chosen for another model do not carry over either.
          if (
            settings.modelOptions === undefined &&
            (agentChanged || effectiveModel !== modelOf(runtimeOf(thread.agentId), thread.model))
          ) {
            delete (next as { modelOptions?: unknown }).modelOptions;
          }
          // Only what the model declares is kept (D297), as threads.send keeps it.
          if (settings.modelOptions !== undefined) {
            const kept = applicableModelOptions(
              runtime?.models?.find((model) => model.id === effectiveModel)?.options,
              settings.modelOptions,
            );
            if (kept.length === 0) delete (next as { modelOptions?: unknown }).modelOptions;
            else next.modelOptions = kept;
          }
          const changed = (Object.keys({ ...thread, ...next }) as (keyof Thread)[]).some(
            (key) => !sameValue(next[key], thread[key]),
          );
          return changed ? { ...next, updatedAt: now() } : thread;
        });
      },
    });

    context.commands.register({
      name: "threads.archive",
      description: "Hides a thread from lists until it is unarchived; stops its running turn",
      input: z.object({ threadId: z.string() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) => {
        // From here on no turn starts on it, until it is archived (and then
        // takes no messages) or the archive failed. A second archive joins.
        const running = archiving.get(threadId);
        if (running !== undefined) return running;
        const archive = archiveThread(threadId);
        archiving.set(threadId, archive);
        void archive.then(
          () => archiving.delete(threadId),
          () => archiving.delete(threadId),
        );
        return archive;
      },
    });

    async function archiveThread(threadId: string): Promise<Thread> {
      // A thread being deleted is gone already, as far as an archive goes.
      if (deleted.has(threadId)) {
        throw new ThreadsError("THREAD_NOT_FOUND", `No thread ${threadId}`, { threadId });
      }
      const thread = await getThread(threadId);
      if (thread.archivedAt !== undefined) return thread;
      await stopTurn(threadId);
      return updateThread(threadId, (latest) => ({
        ...latest,
        archivedAt: now(),
        updatedAt: now(),
      }));
    }

    context.commands.register({
      name: "threads.unarchive",
      description: "Brings an archived thread back into lists",
      input: z.object({ threadId: z.string() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) =>
        updateThread(threadId, (thread) => {
          if (thread.archivedAt === undefined) return thread;
          const { archivedAt: _archivedAt, ...rest } = thread;
          return { ...rest, updatedAt: now() };
        }),
    });

    // --- Arrangement (D75–D78) --------------------------------------------------
    // Where the sidebar keeps a thread: settled, pinned, snoozed, and its place
    // in a list. Kept on the node, so every client and device follows it.
    /** Changes a thread's arrangement; an archived thread has none. */
    const arrange = (threadId: string, change: (thread: Thread, at: string) => Thread) =>
      updateThread(threadId, (thread) => {
        if (thread.archivedAt !== undefined) throw archivedError(threadId);
        return change(thread, now());
      });
    const ThreadId = z.object({ threadId: z.string() });

    context.commands.register({
      name: "threads.settle",
      description:
        "Moves a thread to the Settled shelf until it is un-settled or its next turn; unpins it and wakes it if snoozed. A thread running a turn or waiting for an answer cannot settle",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) =>
        arrange(threadId, (thread, at) => {
          if (thread.lastTurn?.status === "waiting") {
            throw new ThreadsError(
              "TURN_IN_PROGRESS",
              "The thread is waiting on an approval or question: answer it before settling",
              { threadId },
            );
          }
          if (active.has(threadId) || thread.lastTurn?.status === "running") {
            throw new ThreadsError(
              "TURN_IN_PROGRESS",
              "The thread is still running: stop it before settling",
              { threadId },
            );
          }
          const snoozed = thread.snoozedUntil !== undefined;
          if (thread.settledOverride === "settled" && thread.pinnedAt === undefined && !snoozed) {
            return thread;
          }
          const {
            unsettledAt: _unsettledAt,
            pinnedAt: _pinnedAt,
            pinOrderKey: _pinOrderKey,
            activeOrderKey: _activeOrderKey,
            snoozedUntil: _until,
            snoozedAt: _snoozedAt,
            ...rest
          } = thread;
          // A thread on the shelf already keeps its place there: settled by hand
          // as of then, by the rule as of its last activity (T3 keeps settledAt).
          const since =
            thread.settledOverride === "settled"
              ? thread.settledAt
              : autoSettledAt(thread, Date.parse(at));
          return {
            ...rest,
            settledOverride: "settled",
            settledAt: since ?? at,
            // Settling wakes a snoozed thread, as T3's drop onto the shelf does:
            // the Snoozed shelf would otherwise keep showing it.
            ...(snoozed ? { lastSnoozeWakeAt: at } : {}),
          };
        }),
    });

    context.commands.register({
      name: "threads.unsettle",
      description:
        "Brings a thread back from the Settled shelf to the top of the active threads; it stays active until its next turn. A thread not settled is left as it is",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) =>
        arrange(threadId, (thread, at) => {
          // Only a thread on the shelf comes back: T3's command would also move an
          // active one to the top and switch the automatic rule off for it. A
          // snooze stays; it still hides the thread until it wakes.
          if (!isSettled(thread, Date.parse(at))) return thread;
          const { settledAt: _settledAt, ...rest } = thread;
          return { ...rest, settledOverride: "active", unsettledAt: at };
        }),
    });

    context.commands.register({
      name: "threads.pin",
      description:
        "Pins a thread above the active ones, at `orderKey` among the pinned (else after the ordered ones); a settled thread comes back, a snoozed one wakes",
      input: ThreadId.extend({ orderKey: OrderKey.optional() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId, orderKey }) =>
        arrange(threadId, (thread, at) => {
          const settled = isSettled(thread, Date.parse(at));
          if (thread.pinnedAt !== undefined && !settled && thread.snoozedUntil === undefined) {
            return thread;
          }
          const {
            settledAt: _settledAt,
            snoozedUntil: _until,
            snoozedAt: _snoozedAt,
            ...rest
          } = thread;
          return {
            ...rest,
            pinnedAt: thread.pinnedAt ?? at,
            ...(thread.pinnedAt === undefined && orderKey !== undefined
              ? { pinOrderKey: orderKey }
              : {}),
            ...(settled ? { settledOverride: "active" as const } : {}),
            ...(thread.snoozedUntil === undefined ? {} : { lastSnoozeWakeAt: at }),
          };
        }),
    });

    context.commands.register({
      name: "threads.unpin",
      description: "Unpins a thread: it goes back among the active ones",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) =>
        arrange(threadId, (thread) => {
          if (thread.pinnedAt === undefined) return thread;
          const { pinnedAt: _pinnedAt, pinOrderKey: _pinOrderKey, ...rest } = thread;
          return rest;
        }),
    });

    context.commands.register({
      name: "threads.reorder",
      description:
        "Gives a thread its place among the pinned or the active threads: a fractional `orderKey`, compared as text with the others' keys",
      input: ThreadId.extend({ list: z.enum(["pinned", "active"]), orderKey: OrderKey }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId, list, orderKey }) =>
        arrange(threadId, (thread, at) => {
          // Refused rather than pinning, un-settling or waking in passing: a
          // reorder that races an unpin must not bring the pin back, and a key
          // written on a shelf would place the thread when it comes back.
          if (list === "pinned" && thread.pinnedAt === undefined) {
            throw new ThreadsError("THREAD_NOT_PINNED", "The thread is not pinned", { threadId });
          }
          const nowMs = Date.parse(at);
          if (
            list === "active" &&
            (thread.pinnedAt !== undefined || isSettled(thread, nowMs) || isSnoozed(thread, nowMs))
          ) {
            throw new ThreadsError(
              "THREAD_NOT_ACTIVE",
              "The thread is pinned, settled or snoozed",
              { threadId },
            );
          }
          const key = list === "pinned" ? "pinOrderKey" : "activeOrderKey";
          return thread[key] === orderKey ? thread : { ...thread, [key]: orderKey };
        }),
    });

    context.commands.register({
      name: "threads.snooze",
      description:
        "Hides a thread on the Snoozed shelf until `until`; it wakes earlier when it asks for something, fails or completes. A thread waiting for an answer cannot snooze",
      input: ThreadId.extend({ until: z.iso.datetime({ offset: true }) }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId, until }) =>
        arrange(threadId, (thread, at) => {
          const wakeMs = Date.parse(until);
          if (!(wakeMs > Date.parse(at))) {
            throw new ThreadsError("SNOOZE_IN_PAST", `${until} is not in the future`, {
              threadId,
              until,
            });
          }
          if (thread.lastTurn?.status === "waiting") {
            throw new ThreadsError(
              "TURN_IN_PROGRESS",
              "The thread is waiting on an approval or question: answer it before snoozing",
              { threadId },
            );
          }
          // Stamped again even for the same time: snoozing a thread that woke
          // means "seen, not now".
          return { ...thread, snoozedUntil: new Date(wakeMs).toISOString(), snoozedAt: at };
        }),
    });

    context.commands.register({
      name: "threads.unsnooze",
      description: "Wakes a snoozed thread now",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) =>
        arrange(threadId, (thread, at) => {
          if (thread.snoozedUntil === undefined) return thread;
          const { snoozedUntil: _until, snoozedAt: _snoozedAt, ...rest } = thread;
          return { ...rest, lastSnoozeWakeAt: at };
        }),
    });

    context.commands.register({
      name: "threads.delete",
      description:
        "Deletes a thread: it leaves every list; its event stream keeps a final deleted event",
      input: z.object({ threadId: z.string() }),
      output: z.object({ deleted: z.boolean() }),
      permissions: ["threads.write"],
      handler: async ({ threadId }) => {
        // A deletion left half done is finished, even once the record is gone.
        await deleteThread(deletions.get(threadId)?.thread ?? (await getThread(threadId)));
        return { deleted: true };
      },
    });

    context.commands.register({
      name: "threads.events",
      description: "Events of a thread after a sequence, oldest first",
      input: z.object({
        threadId: z.string(),
        after: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(1000).default(200),
      }),
      output: z.array(StoredEventSchema),
      permissions: ["threads.read"],
      handler: async ({ threadId, after, limit }) => {
        await getThread(threadId);
        return log.read(threadStream(threadId), { after, limit });
      },
    });

    context.commands.register({
      name: "threads.send",
      description:
        "Sends a message and starts a turn; the response arrives as events of the thread. Agent, model and modes default to the thread's",
      input: z.object({
        threadId: z.string(),
        text: z.string(),
        attachments: z
          .array(Attachment)
          .max(MAX_ATTACHMENTS)
          .refine(
            (list) =>
              list.reduce((total, item) => total + item.dataUrl.length, 0) <= MAX_ATTACHMENTS_TOTAL,
            "are too large together",
          )
          .optional(),
        ...AgentSettings,
      }),
      output: z.object({ turnId: z.string() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, text, attachments, ...requested }) => {
        if (text.trim() === "" && (attachments ?? []).length === 0) {
          throw new ThreadsError("MESSAGE_EMPTY", "A message needs text or an attachment");
        }
        // Early answers for the common cases; the reservation below decides.
        const read = await getThread(threadId);
        if (read.archivedAt !== undefined) throw archivedError(threadId);
        const running = active.get(threadId);
        if (running !== undefined) {
          throw new ThreadsError("TURN_IN_PROGRESS", "The thread is already running a turn", {
            threadId,
            turnId: running.turnId,
          });
        }
        const agentId = requested.agentId ?? read.agentId;
        let runtime = agentId === undefined ? undefined : registry.get(agentId);
        if (runtime === undefined && requested.agentId !== undefined) {
          throw new ThreadsError("AGENT_NOT_FOUND", `No agent ${requested.agentId} on this node`, {
            agentId: requested.agentId,
          });
        }
        runtime ??= await defaultRuntime();
        if (runtime === undefined) {
          throw new ThreadsError("NO_AGENT", "No agent runtime is installed on this node");
        }
        // A first message names its thread. The hook runs before the thread is
        // taken: one that is slow, or never answers, holds nothing.
        const firstTitle =
          read.lastTurn === undefined && read.title === DEFAULT_THREAD_TITLE
            ? await context.hooks
                .run("threads.title", { thread: read, text }, ({ text: input }) =>
                  titleFromText(input),
                )
                .catch(() => titleFromText(text))
            : undefined;
        const turnId = Crypto.randomUUID();
        // Nothing is awaited between checking that the thread is free and taking it.
        const reservation = reserve(threadId, turnId, runtime.agentId);
        let thread: Thread;
        let settings: TurnSettings;
        try {
          // The thread as it is now that it is ours: archived meanwhile, it takes no turn.
          thread = await getThread(threadId);
          if (thread.archivedAt !== undefined) throw archivedError(threadId);
          // A model named for another agent does not carry over to this one.
          const sameAgent = thread.agentId === undefined || thread.agentId === runtime.agentId;
          const model = requested.model ?? (sameAgent ? thread.model : undefined);
          const runtimeMode = requested.runtimeMode ?? thread.runtimeMode;
          const interactionMode = requested.interactionMode ?? thread.interactionMode;
          // Options chosen for the thread's model carry over while the model does (D297),
          // and only those the model declares go to the agent.
          const sameModel = sameAgent && (requested.model ?? thread.model) === thread.model;
          const effectiveModel = model ?? runtime.defaultModel ?? runtime.models?.[0]?.id;
          const modelOptions = applicableModelOptions(
            runtime.models?.find((candidate) => candidate.id === effectiveModel)?.options,
            requested.modelOptions ?? (sameModel ? thread.modelOptions : undefined),
          );
          settings = {
            ...(model === undefined ? {} : { model }),
            ...(runtimeMode === undefined ? {} : { runtimeMode }),
            ...(interactionMode === undefined ? {} : { interactionMode }),
            ...(modelOptions.length === 0 ? {} : { modelOptions }),
          };
          const chosen = { agentId: runtime.agentId, ...settings };
          // The record keeps what this turn runs with: no model of another agent,
          // no options of another model.
          const dropModel = settings.model === undefined;
          const dropOptions = settings.modelOptions === undefined;
          // A new turn also brings a settled thread back and wakes a snoozed one.
          const at = now();
          await updateThread(threadId, (latest) => {
            const back = revived(latest, at);
            const { model: _model, ...withoutModel } = back;
            const kept = dropModel ? withoutModel : back;
            const { modelOptions: _options, ...withoutOptions } = kept;
            const next: Thread = {
              ...(dropOptions ? withoutOptions : kept),
              ...chosen,
              // Only the first message names the thread, and only while it has the
              // default title: a rename that landed since it was read stays.
              title:
                firstTitle !== undefined &&
                latest.lastTurn === undefined &&
                latest.title === DEFAULT_THREAD_TITLE
                  ? firstTitle
                  : latest.title,
            };
            const changed = (Object.keys({ ...latest, ...next }) as (keyof Thread)[]).some(
              (key) => !sameValue(next[key], latest[key]),
            );
            return changed ? next : latest;
          });
        } catch (error) {
          reservation.finish();
          throw error;
        }
        await runTurn(
          thread,
          { text, ...(attachments === undefined ? {} : { attachments }) },
          runtime,
          settings,
          reservation,
        );
        return { turnId };
      },
    });

    context.commands.register({
      name: "threads.interrupt",
      description: "Stops the running turn of a thread",
      input: z.object({ threadId: z.string() }),
      output: z.object({ interrupted: z.boolean() }),
      permissions: ["threads.write"],
      handler: async ({ threadId }) => {
        const current = active.get(threadId);
        if (current === undefined) return { interrupted: false };
        current.interrupted = true;
        current.turn?.interrupt();
        return { interrupted: true };
      },
    });

    context.commands.register({
      name: "threads.respond",
      description:
        "Answers a request of the running turn: an approval decision or answers to the agent's questions",
      input: z.object({ threadId: z.string(), requestId: z.string(), response: Response }),
      output: z.object({ resolved: z.boolean() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, requestId, response }) => {
        const current = active.get(threadId);
        // The request may still be being recorded: its answer comes after it.
        if (current?.recording !== undefined) await Promise.allSettled([current.recording]);
        const kind = current?.openRequests.get(requestId);
        // An answer being recorded makes the request no longer open to another
        // one, and a turn that is ending takes no more answers.
        if (
          current === undefined ||
          kind === undefined ||
          current.answering.has(requestId) ||
          current.ending
        ) {
          throw new ThreadsError("REQUEST_NOT_FOUND", `No open request ${requestId}`, {
            threadId,
            requestId,
          });
        }
        if (response.kind !== kind) {
          throw new ThreadsError(
            "RESPONSE_MISMATCH",
            `Request ${requestId} takes a ${kind} answer, not ${response.kind}`,
            { threadId, requestId, expected: kind, received: response.kind },
          );
        }
        const turn = current.turn;
        if (turn?.respond === undefined) {
          throw new ThreadsError("REQUEST_UNSUPPORTED", "The agent takes no answers", {
            threadId,
            requestId,
          });
        }
        const recorded = log.append(threadStream(threadId), [
          {
            type: ThreadEvents.requestResolved,
            payload: {
              turnId: current.turnId,
              requestId,
              response: response as unknown as Json,
            },
          },
        ]);
        current.answering.set(requestId, recorded);
        try {
          await recorded;
        } finally {
          // A failed record leaves the request open, so the answer can be sent again.
          current.answering.delete(requestId);
        }
        if (current.ending) {
          // The turn ended while the answer was recorded: the agent never gets
          // it, and the turn's end closes the request after the answer.
          throw new ThreadsError(
            "REQUEST_NOT_FOUND",
            `The turn of request ${requestId} ended before the answer reached the agent`,
            { threadId, requestId },
          );
        }
        // Recorded: the request is answered, whatever the agent makes of it, so
        // it takes no second answer.
        current.openRequests.delete(requestId);
        let refused: unknown;
        try {
          turn.respond(requestId, response);
        } catch (error) {
          refused = error;
        }
        // What the turn waits for now: the requests still open, or nothing.
        if (active.get(threadId) === current) {
          await (current.openRequests.size === 0
            ? setTurnStatus(threadId, current.turnId, current.agentId, "running")
            : setTurnStatus(
                threadId,
                current.turnId,
                current.agentId,
                "waiting",
                awaitedKind(current.openRequests),
              ));
        }
        if (refused !== undefined) {
          context.log.error("an agent failed to take an answer", {
            threadId,
            requestId,
            error: String(refused),
          });
          throw new ThreadsError(
            "AGENT_FAILED",
            `The agent did not take the answer: ${String(refused)}`,
            { threadId, requestId },
          );
        }
        return { resolved: true };
      },
    });
  },
});
