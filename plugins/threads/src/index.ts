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
  ThreadEvents,
  ThreadHooks,
  threadStream,
  type AgentItem,
  type AgentRegistry,
  type AgentRequest,
  type AgentResponse,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentTurn,
  type InteractionMode,
  type RuntimeMode,
  type TurnAttachment,
  type TurnInput,
  type TurnEndHookInput,
  type TurnHookInput,
  visibleThreadEvents,
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
  type NewEvent,
  type RecordWrite,
  type StoredEvent,
} from "@jhin/storage-api";

import { matchTexts, mergeBackMessage, searchTexts, type SearchText } from "./history.ts";

export { THREADS_STREAM };

const NAMESPACE = "jhin.threads";
const CONFIG_SECTION = "jhin.threads";
const DRAIN_TIMEOUT_MS = 5000;
/** How long archiving or deleting a thread waits for its turn to end after the interrupt. */
export const STOP_TIMEOUT_MS = 5000;
/**
 * How long a turn hook may take by default (the `turnHookTimeoutSeconds`
 * setting): one that has not answered by then is given up on, so a hook that
 * hangs never holds its thread (D241).
 */
const TURN_HOOK_TIMEOUT_SECONDS = 60;
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
/** The message texts a node keeps for searching, in characters, across its threads (D227). */
const SEARCH_CACHE_CHARS = 32_000_000;

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
    turnHookTimeoutSeconds: z.number().min(0).max(3600).default(TURN_HOOK_TIMEOUT_SECONDS).meta({
      title: "Turn hook timeout (seconds)",
      description:
        "How long a plugin's hook around a turn (a checkpoint) may take: a start hook that takes longer fails the turn, an end hook is given up on. 0 gives hooks no time: one that does not answer at once is given up on.",
      advanced: true,
    }),
    // T3 Code's "Organization" settings (D444): how threads settle by themselves.
    autoSettleOnMerge: z.boolean().default(true).meta({
      title: "Auto-settle merged threads",
      description:
        "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
    }),
    autoSettleInactive: z.boolean().default(true).meta({
      title: "Auto-settle inactive threads",
      description: "Sidebar threads with no activity for this long settle automatically.",
    }),
    autoSettleAfterDays: z.number().int().min(1).max(90).default(3).meta({
      title: "Days of inactivity before auto-settle",
      description: "Any new activity un-settles a thread automatically.",
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
  /**
   * The thread's own working directory (T3 Code's `worktreePath`), usually a
   * git worktree of its project: its turns run there. Absent: the project's.
   */
  worktreePath: z.string().optional(),
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
  /** The thread and turn this thread was forked at (D225). */
  forkedFrom: z.object({ threadId: z.string(), turnId: z.string() }).optional(),
  /** A fork merged back: its result goes to the agent with the next message (D226). */
  pendingMergeBack: z
    .object({ id: z.string(), threadId: z.string(), turnId: z.string(), at: z.string() })
    .optional(),
  /** When the user last sent it a message (T3's latestUserMessageAt). */
  lastMessageAt: z.string().optional(),
  /** Set while the thread never settles by itself (T3's per-thread "Auto-settle behavior"). */
  autoSettleDisabledAt: z.string().optional(),
});
type Thread = z.infer<typeof Thread>;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a thread goes without activity before it settles by itself, per
 * the node's config (T3's default: 3 days); `undefined` while the rule is off.
 */
type SettleRule = { readonly afterMs: number } | undefined;
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
function isSettled(thread: Thread, nowMs: number, rule: SettleRule): boolean {
  if (thread.settledOverride !== undefined) return thread.settledOverride === "settled";
  return autoSettledAt(thread, nowMs, rule) !== undefined;
}

/**
 * When the automatic rule settled the thread, if it did: as of its last
 * activity, a snooze that ended counting as activity (the web client's twin).
 */
function autoSettledAt(thread: Thread, nowMs: number, rule: SettleRule): string | undefined {
  if (rule === undefined || !mayAutoSettle(thread, nowMs)) return undefined;
  const activity = lastActivity(thread, nowMs);
  return Number.isFinite(activity) && activity < nowMs - rule.afterMs
    ? new Date(activity).toISOString()
    : undefined;
}

/**
 * Whether anything keeps the thread from settling by itself (T3's
 * isAutoSettlementCandidate): settled or kept active by hand, archived,
 * pinned, auto-settle turned off for it, a turn running or waiting for the
 * user, or snoozed.
 */
function mayAutoSettle(thread: Thread, nowMs: number): boolean {
  if (thread.settledOverride !== undefined || thread.archivedAt !== undefined) return false;
  if (thread.pinnedAt !== undefined || thread.autoSettleDisabledAt !== undefined) return false;
  const status = thread.lastTurn?.status;
  if (status === "running" || status === "waiting") return false;
  return !isSnoozed(thread, nowMs);
}

/** The thread's last activity: its latest turn, else its last change; a snooze that ended counts. */
function lastActivity(thread: Thread, nowMs: number): number {
  const until = millis(thread.snoozedUntil);
  return Math.max(
    ...[thread.lastTurn?.at ?? thread.updatedAt ?? thread.createdAt, thread.lastSnoozeWakeAt]
      .map(millis)
      .filter((value) => !Number.isNaN(value)),
    until <= nowMs ? until : Number.NEGATIVE_INFINITY,
  );
}

/**
 * What a new turn changes in the thread's arrangement, as T3 Code's turn start
 * does: a settled thread comes back to the top of the active ones, a snoozed
 * one wakes, and a choice made by hand gives way to the automatic rule again.
 */
function revived(thread: Thread, at: string, rule: SettleRule): Thread {
  const nowMs = Date.parse(at);
  const settled = isSettled(thread, nowMs, rule);
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

/** A thread id a caller chooses (D207): it names the thread's stream, `thread/<id>`. */
const ThreadIdInput = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "must be letters, digits, _ or -, up to 128");

const AgentSettings = {
  agentId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimeMode: z.enum(RUNTIME_MODES).optional(),
  interactionMode: z.enum(INTERACTION_MODES).optional(),
};

const Response: z.ZodType<AgentResponse> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval"), decision: z.enum(APPROVAL_DECISIONS) }),
  z.object({
    kind: z.literal("user-input"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
]);

const Attachments = z
  .array(Attachment)
  .max(MAX_ATTACHMENTS)
  .refine(
    (list) => list.reduce((total, item) => total + item.dataUrl.length, 0) <= MAX_ATTACHMENTS_TOTAL,
    "are too large together",
  );

/** A message waiting in a thread's queue (D201), with what it was typed with. */
const QueuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(Attachment).optional(),
  ...AgentSettings,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
type QueuedMessage = z.infer<typeof QueuedMessage>;

/** Why a queue waits for `threads.queue.resume` (D202). */
const QueueHold = z.object({
  reason: z.enum(["interrupted", "failed", "refused"]),
  /** The turn that was stopped or failed. */
  turnId: z.string().optional(),
  /** Why the node refused to start the first message, or why its turn failed. */
  error: z.string().optional(),
  at: z.string(),
});

const Queue = z.object({
  messages: z.array(QueuedMessage),
  held: QueueHold.optional(),
  /** The stopped or failed turn the user resumed the queue past: a restart does not hold it again. */
  resumedPast: z.string().optional(),
});
type Queue = z.infer<typeof Queue>;

/** A queue as `threads.queue.updated` carries it: images by name and type only. */
const QueueView = z.object({
  messages: z.array(
    QueuedMessage.extend({
      attachments: z.array(
        z.object({ kind: z.literal("image"), name: z.string(), mimeType: z.string() }),
      ),
    }),
  ),
  held: QueueHold.optional(),
});
type QueueView = z.infer<typeof QueueView>;

const viewOf = ({ resumedPast: _resumedPast, ...queue }: Queue): QueueView => ({
  messages: queue.messages.map((message) => ({
    ...message,
    attachments: (message.attachments ?? []).map(({ kind, name, mimeType }) => ({
      kind,
      name,
      mimeType,
    })),
  })),
  ...(queue.held === undefined ? {} : { held: queue.held }),
});

/** A message a caller sends: what `threads.send`, the queue and steering take. */
const Outgoing = z.object({
  threadId: z.string(),
  text: z.string(),
  attachments: Attachments.optional(),
  ...AgentSettings,
});
type Outgoing = Omit<z.infer<typeof Outgoing>, "threadId">;

/** A message id a caller chooses (D201): queuing it again changes nothing. */
const MessageIdInput = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/, "must be letters, digits, _ : . or -, up to 128");

const AgentInfo = z.object({
  agentId: z.string(),
  name: z.string(),
  models: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string().optional() }),
  ),
  defaultModel: z.string().optional(),
  runtimeModes: z.array(z.enum(RUNTIME_MODES)),
  interactionModes: z.array(z.enum(INTERACTION_MODES)),
  available: z.boolean(),
  message: z.string().optional(),
  version: z.string().optional(),
  /** The agent a thread without a chosen agent runs. */
  default: z.boolean(),
  /** Its turns take messages while they run (D204). */
  steering: z.boolean(),
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
  /** Steers being recorded (D205); the turn's end waits for them. */
  readonly steering: Set<Promise<unknown>>;
  /** Settles once the agent's turn started, or its start failed. */
  readonly started: Promise<void>;
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

/**
 * A thread's own working directory: an existing absolute directory, stored by
 * its real path, so it compares equal with the paths git reports.
 */
async function worktreeDirectory(given: string): Promise<string> {
  const invalid = () =>
    new ThreadsError("WORKTREE_PATH_INVALID", `${given} is not an existing absolute directory`, {
      path: given,
    });
  if (!Path.isAbsolute(given)) throw invalid();
  const path = await Fs.promises.realpath(given).catch(() => undefined);
  const stat = path === undefined ? undefined : await Fs.promises.stat(path).catch(() => undefined);
  if (path === undefined || stat?.isDirectory() !== true) throw invalid();
  return path;
}

/** Settles with `task`, or once `ms` passed without it (then `expired` runs). */
function withDeadline(task: Promise<unknown>, ms: number, expired: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    task.then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired();
        resolve();
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export default definePlugin({
  async activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    /** The node's rule for settling by inactivity, as configured now (D444). */
    const settleRule = (): SettleRule => {
      const config = context.config.get<Config>(CONFIG_SECTION);
      return config.autoSettleInactive
        ? { afterMs: config.autoSettleAfterDays * DAY_MS }
        : undefined;
    };
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
    /** Rollbacks under way (D220): they hold their thread as a turn does. */
    const rollingBack = new Map<string, Promise<void>>();
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
    /** Set once the node stops: no queued message starts a turn any more. */
    let stopping = false;
    context.onDeactivate(async () => {
      stopping = true;
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
    const hookTimeoutMs = () =>
      context.config.get<Config>(CONFIG_SECTION).turnHookTimeoutSeconds * 1000;

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
    /** The last event of a stream, if it has any. */
    const lastEvent = async (stream: string) =>
      (await log.read(stream, { after: Math.max(0, (await log.head(stream)) - 1) }))[0];
    const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
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
     * Writes a record (or removes it, `undefined`) together with the `threads`
     * index event that announces it, in one write (D208): a client following the
     * index never misses a change the records already show, nor the reverse.
     */
    const writeIndexed = (
      key: string,
      value: Json | undefined,
      type: string,
      payload?: Json,
      also: readonly RecordWrite[] = [],
    ) =>
      log.append(THREADS_STREAM, [{ type, payload: payload ?? (value as Json) }], {
        records: [
          value === undefined
            ? { namespace: NAMESPACE, key, delete: true }
            : { namespace: NAMESPACE, key, value },
          ...also,
        ],
      });

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
        await writeIndexed(`thread/${id}`, next as unknown as Json, ThreadEvents.threadUpdated);
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

    // D208 needs the records of an append to land in the storage.kv this
    // plugin reads: both capabilities from one provider. Checked once, with an
    // append of no events, so a node that mixes providers fails to start
    // instead of losing records quietly.
    // A key of its own, so nodes starting on shared storage at once do not
    // read each other's; removed whatever happens.
    const probe = `probe/${Crypto.randomUUID()}`;
    let seen = false;
    try {
      await log.append(THREADS_STREAM, [], {
        records: [{ namespace: NAMESPACE, key: probe, value: true }],
      });
      seen = (await kv.get(NAMESPACE, probe)) === true;
    } finally {
      await kv.delete(NAMESPACE, probe);
    }
    if (!seen) {
      throw new ThreadsError(
        "STORAGE_MISMATCH",
        "storage.eventlog@1.1 writes its records to another store than storage.kv: both must come from one plugin",
      );
    }

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
    // A deletion the node stopped in the middle of (its stream says deleted,
    // its record is still there, D208) is finished now: the thread is gone.
    for (const thread of await listThreads()) {
      if ((await lastEvent(threadStream(thread.id)))?.type !== ThreadEvents.threadDeleted) continue;
      await writeIndexed(
        `thread/${thread.id}`,
        undefined,
        ThreadEvents.threadDeleted,
        { id: thread.id },
        [{ namespace: NAMESPACE, key: `queue/${thread.id}`, delete: true }],
      );
    }

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
    ): { entry: Running; release: () => void; finish: () => void; started: () => void } {
      const current = active.get(threadId);
      if (current !== undefined) {
        throw new ThreadsError("TURN_IN_PROGRESS", "The thread is already running a turn", {
          threadId,
          turnId: current.turnId,
        });
      }
      if (rollingBack.has(threadId)) {
        throw new ThreadsError("TURN_IN_PROGRESS", "The thread is rolling back its turns", {
          threadId,
        });
      }
      if (deleted.has(threadId)) {
        throw new ThreadsError("THREAD_NOT_FOUND", `No thread ${threadId}`, { threadId });
      }
      if (archiving.has(threadId)) throw archivedError(threadId);
      let resolve!: () => void;
      let started!: () => void;
      const entry: Running = {
        turnId,
        agentId,
        turn: undefined,
        done: new Promise((done) => (resolve = done)),
        started: new Promise((done) => (started = done)),
        steering: new Set(),
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
        started,
        finish: () => {
          release();
          started();
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
    }

    async function runTurn(
      thread: Thread,
      input: { text: string; attachments?: readonly TurnAttachment[] },
      runtime: AgentRuntime,
      settings: TurnSettings,
      { entry, release, finish, started }: ReturnType<typeof reserve>,
      /** The message the turn answers, when the caller named it (a queued one). */
      messageId?: string,
      /** Set once the turn's start is recorded: from then on the message is the turn's. */
      progress?: { recorded: boolean },
      alongside?: { events: readonly NewEvent[]; records: readonly RecordWrite[] },
      /** A fork's result the agent gets before the message (D226). */
      handoff?: { readonly payload: Json; readonly text: string },
    ): Promise<void> {
      const { turnId } = entry;
      const stream = threadStream(thread.id);
      let turn: AgentTurn;
      let hookInput: TurnHookInput;
      try {
        const project = await getProject(thread.projectId);
        hookInput = {
          threadId: thread.id,
          projectId: thread.projectId,
          turnId,
          agentId: runtime.agentId,
          cwd: thread.worktreePath ?? project.path,
        };
        // What the thread still shows: a rollback's dropped turns are not history (D221).
        const history = visibleThreadEvents(await log.read(stream));
        // The record says the turn runs before its first event is written: a node
        // that stops in between finds it on restart and closes it.
        await setTurnStatus(thread.id, turnId, runtime.agentId, "running");
        try {
          await log.append(
            stream,
            [
              {
                type: ThreadEvents.turnStarted,
                payload: {
                  turnId,
                  agentId: runtime.agentId,
                  input: input as unknown as Json,
                  ...(settings as Record<string, Json>),
                  ...(messageId === undefined ? {} : { messageId }),
                  ...(handoff === undefined ? {} : { handoff: handoff.payload }),
                },
              },
              ...(alongside?.events ?? []),
            ],
            alongside === undefined ? undefined : { records: alongside.records },
          );
          if (progress !== undefined) progress.recorded = true;
        } catch (error) {
          // Never started: the record does not say it runs.
          await setTurnStatus(thread.id, turnId, runtime.agentId, "failed");
          throw error;
        }
        try {
          // Before the agent touches anything (a checkpoint of the working tree, D240).
          // A start hook that does not answer fails the turn as one that throws does: the
          // agent never works without what the hooks do first (a checkpoint).
          let late = false;
          await withDeadline(
            context.hooks.run(ThreadHooks.turnStart, hookInput, () => undefined),
            hookTimeoutMs(),
            () => (late = true),
          );
          if (late) {
            throw new ThreadsError(
              "TURN_HOOK_TIMEOUT",
              `A turn start hook did not answer within ${hookTimeoutMs() / 1000} s`,
              { threadId: thread.id, turnId },
            );
          }
          // A worktree removed under the thread, and not brought back by a hook (D242).
          if (
            thread.worktreePath !== undefined &&
            !(await Fs.promises.stat(hookInput.cwd).then(
              (stat) => stat.isDirectory(),
              () => false,
            ))
          ) {
            throw new ThreadsError(
              "WORKTREE_NOT_FOUND",
              `The thread's worktree ${hookInput.cwd} no longer exists`,
              { threadId: thread.id, path: hookInput.cwd },
            );
          }
          turn = runtime.startTurn({
            threadId: thread.id,
            turnId,
            input: handoff === undefined ? input : { ...input, text: handoff.text },
            history,
            cwd: hookInput.cwd,
            ...settings,
          });
        } catch (error) {
          // turn.started is already recorded: close it, keeping the hook's or the agent's error.
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
      started();
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
        // The item, the answers and the steers being recorded go first: a
        // request is recorded opened (and maybe answered) before it is closed.
        await Promise.allSettled([entry.recording, ...entry.answering.values(), ...entry.steering]);
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
          // Before the end is recorded: whoever sees the turn end sees what the hooks did.
          const endInput: TurnEndHookInput = {
            ...hookInput,
            status: ending.status as TurnEndHookInput["status"],
          };
          await withDeadline(
            context.hooks
              .run(ThreadHooks.turnEnd, endInput, () => undefined)
              .catch((error: unknown) =>
                context.log.error("a turn end hook failed", {
                  threadId: thread.id,
                  turnId,
                  error: String(error),
                }),
              ),
            hookTimeoutMs(),
            () =>
              context.log.error("a turn end hook did not answer; the turn ends", {
                threadId: thread.id,
                turnId,
              }),
          );
          const payload: Json = {
            turnId,
            ...(ending.error === undefined ? {} : { error: ending.error }),
            ...(ending.reason === undefined ? {} : { reason: ending.reason }),
          };
          // A stop or a failure holds the queue in the same write, so no queued
          // message starts after it (T3's queueHeld).
          if (ending.status === "completed" || deleted.has(thread.id)) {
            await recordEnd(ending.type, payload);
          } else {
            await recordEndHolding(
              thread.id,
              { type: ending.type, payload },
              ending.error,
              release,
            ).catch((appendError: unknown) => {
              // The queue could not be read or written: the end is recorded alone.
              context.log.error("could not hold the queue at the end of a turn", {
                threadId: thread.id,
                turnId,
                error: String(appendError),
              });
              return recordEnd(ending.type, payload);
            });
          }
        } finally {
          // Once its last event is recorded the thread takes the next message.
          release();
        }
        try {
          await setTurnStatus(thread.id, turnId, runtime.agentId, ending.status);
        } finally {
          finish();
        }
        // The thread is free: its queue goes on.
        if (ending.status === "completed") void deliver(thread.id);
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
     * waits on storage and the turn start hooks, as recording its end would.
     */
    async function stopTurn(threadId: string): Promise<void> {
      // A rollback under way is never cut short: it ends by itself (D220).
      await rollingBack.get(threadId);
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
            // After the queue's changes under way: none writes after this event.
            await queued(queueKey(thread.id), () =>
              log.append(threadStream(thread.id), [
                { type: ThreadEvents.threadDeleted, payload: { id: thread.id } },
              ]),
            );
            // Its stream says deleted: it stays closed to turns, whatever fails next.
            deletion.recorded = true;
          }
          // After the changes to its record already under way: none writes it back.
          await queued(thread.id, () =>
            writeIndexed(
              `thread/${thread.id}`,
              undefined,
              ThreadEvents.threadDeleted,
              { id: thread.id },
              // Its queue goes with it.
              [{ namespace: NAMESPACE, key: queueKey(thread.id), delete: true }],
            ),
          );
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
        await writeIndexed(
          `project/${project.id}`,
          project as unknown as Json,
          ThreadEvents.projectCreated,
        );
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
          await writeIndexed(
            `project/${projectId}`,
            next as unknown as Json,
            ThreadEvents.projectUpdated,
          );
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
        await queued(`project/${projectId}`, () =>
          writeIndexed(`project/${projectId}`, undefined, ThreadEvents.projectDeleted, {
            id: projectId,
          }),
        );
        removed = true;
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
              models: [...(runtime.models ?? [])],
              ...(runtime.defaultModel === undefined ? {} : { defaultModel: runtime.defaultModel }),
              runtimeModes: [...(runtime.runtimeModes ?? ["full-access"])],
              interactionModes: [...(runtime.interactionModes ?? ["default"])],
              available: status.available,
              ...(status.message === undefined ? {} : { message: status.message }),
              ...(status.version === undefined ? {} : { version: status.version }),
              default: runtime === fallback,
              steering: runtime.steering === true,
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
      description:
        "Starts a thread in a project (the scratch project by default). With a `threadId` chosen by the caller it is idempotent: creating that thread again in the same project returns it as it is, whatever title or agent settings the later call names",
      input: z.object({
        projectId: z.string().default(SCRATCH_PROJECT),
        title: z.string().min(1).default(DEFAULT_THREAD_TITLE),
        threadId: ThreadIdInput.optional(),
        ...AgentSettings,
        parentThreadId: z.string().min(1).optional(),
        relationshipToParent: z.enum(["subagent"]).optional(),
        worktreePath: z.string().min(1).optional().meta({
          description:
            "The thread's own working directory (a git worktree of the project); its turns run there",
        }),
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ projectId, title, threadId, worktreePath, ...rest }) => {
        const settings =
          worktreePath === undefined
            ? rest
            : { ...rest, worktreePath: await worktreeDirectory(worktreePath) };
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
        // Creations of one id run one at a time, so the second finds the first's thread.
        return creatingIn(projectId, () =>
          threadId === undefined
            ? createThread(Crypto.randomUUID(), projectId, title, settings)
            : queued(threadId, () => createThread(threadId, projectId, title, settings)),
        );
      },
    });

    /** Creates a thread in a project that is not being removed; a removal waits for it. */
    async function creatingIn(projectId: string, create: () => Promise<Thread>): Promise<Thread> {
      await getProject(projectId);
      if (removedProjects.has(projectId)) {
        throw new ThreadsError("PROJECT_NOT_FOUND", `No project ${projectId}`, { projectId });
      }
      // A removal of the project that starts meanwhile waits for this thread.
      const creating = create();
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
    }

    async function createThread(
      id: string,
      projectId: string,
      title: string,
      settings: Omit<Thread, "id" | "projectId" | "title" | "createdAt" | "updatedAt">,
      retried = false,
      /** Events written with its first one: a fork's copy of its parent (D225). */
      following: (thread: Thread) => { type: string; payload: Json }[] = () => [],
    ): Promise<Thread> {
      const stream = threadStream(id);
      const taken = () =>
        new ThreadsError("THREAD_EXISTS", `A thread ${id} exists or existed on this node`, {
          threadId: id,
        });
      // The same id again (D207): the thread made by an earlier call whose
      // answer was lost, when it is the same project's.
      const existing = await kv.get(NAMESPACE, `thread/${id}`);
      if (existing !== undefined) {
        const thread = Thread.parse(existing);
        // A record kept until its deletion is announced is no thread to return.
        if (
          thread.projectId !== projectId ||
          deleted.has(id) ||
          (await lastEvent(stream))?.type === ThreadEvents.threadDeleted
        ) {
          throw taken();
        }
        return thread;
      }
      // A stream without a record: a deleted thread, whose id is not taken
      // again, or a creation that stopped after the stream's first event,
      // which this one finishes with the thread that event recorded.
      const [first] = await log.read(stream, { limit: 1 });
      let thread: Thread;
      if (first !== undefined) {
        const started = Thread.safeParse(first.payload);
        const last = await lastEvent(stream);
        if (
          first.type !== ThreadEvents.threadCreated ||
          !started.success ||
          started.data.projectId !== projectId ||
          last?.type === ThreadEvents.threadDeleted
        ) {
          throw taken();
        }
        thread = started.data;
      } else {
        const createdAt = now();
        thread = Thread.parse({
          id,
          projectId,
          title,
          createdAt,
          updatedAt: createdAt,
          ...settings,
        });
        // The stream's first event comes first: a thread record never exists without it.
        try {
          await log.append(
            stream,
            [
              { type: ThreadEvents.threadCreated, payload: thread as unknown as Json },
              ...following(thread),
            ],
            { expectedHead: 0 },
          );
        } catch (error) {
          // Another process sharing the storage took the id meanwhile: what it
          // wrote decides, as for any id already taken.
          if (codeOf(error) !== "CONFLICT" || retried) throw error;
          return createThread(id, projectId, title, settings, true, following);
        }
      }
      // Then the record with the node's index of threads, which other nodes
      // follow to mirror new threads (D26 eager): whoever learns of the thread
      // there can read it.
      await writeIndexed(`thread/${id}`, thread as unknown as Json, ThreadEvents.threadCreated);
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
      description:
        "Renames a thread or changes the agent, model and modes its next turns run with, or the working directory they run in",
      input: z.object({
        threadId: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        ...AgentSettings,
        worktreePath: z.string().min(1).nullable().optional().meta({
          description:
            "The thread's own working directory (a git worktree of the project); null: the project's again",
        }),
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ threadId, title, worktreePath, ...settings }) => {
        if (settings.agentId !== undefined && registry.get(settings.agentId) === undefined) {
          throw new ThreadsError("AGENT_NOT_FOUND", `No agent ${settings.agentId} on this node`, {
            agentId: settings.agentId,
          });
        }
        const directory =
          worktreePath === undefined || worktreePath === null
            ? worktreePath
            : await worktreeDirectory(worktreePath);
        // A running turn keeps the directory it started in; the next one runs in this one.
        return updateThread(threadId, (thread) => {
          const next: Thread = {
            ...thread,
            ...(title === undefined ? {} : { title }),
            ...settings,
            ...(typeof directory === "string" ? { worktreePath: directory } : {}),
          };
          if (directory === null) delete (next as { worktreePath?: string }).worktreePath;
          // A model named for another agent does not carry over to a new one.
          if (
            settings.agentId !== undefined &&
            settings.agentId !== thread.agentId &&
            settings.model === undefined
          ) {
            delete (next as { model?: string }).model;
          }
          const changed = (Object.keys({ ...thread, ...next }) as (keyof Thread)[]).some(
            (key) => next[key] !== thread[key],
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

    /**
     * What each arrangement command does to a record, checked and changed in
     * memory; `threads.arrange` (D449) runs several of them as one write.
     */
    const changes = {
      settle(thread: Thread, at: string): Thread {
        if (thread.lastTurn?.status === "waiting") {
          throw new ThreadsError(
            "TURN_IN_PROGRESS",
            "The thread is waiting on an approval or question: answer it before settling",
            { threadId: thread.id },
          );
        }
        if (active.has(thread.id) || thread.lastTurn?.status === "running") {
          throw new ThreadsError(
            "TURN_IN_PROGRESS",
            "The thread is still running: stop it before settling",
            { threadId: thread.id },
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
            : autoSettledAt(thread, Date.parse(at), settleRule());
        return {
          ...rest,
          settledOverride: "settled",
          settledAt: since ?? at,
          // Settling wakes a snoozed thread, as T3's drop onto the shelf does:
          // the Snoozed shelf would otherwise keep showing it.
          ...(snoozed ? { lastSnoozeWakeAt: at } : {}),
        };
      },
      unsettle(thread: Thread, at: string): Thread {
        // Only a thread on the shelf comes back: T3's command would also move an
        // active one to the top and switch the automatic rule off for it. A
        // snooze stays; it still hides the thread until it wakes.
        if (!isSettled(thread, Date.parse(at), settleRule())) return thread;
        const { settledAt: _settledAt, ...rest } = thread;
        return { ...rest, settledOverride: "active", unsettledAt: at };
      },
      pin(thread: Thread, at: string, orderKey?: string): Thread {
        const settled = isSettled(thread, Date.parse(at), settleRule());
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
      },
      unpin(thread: Thread): Thread {
        if (thread.pinnedAt === undefined) return thread;
        const { pinnedAt: _pinnedAt, pinOrderKey: _pinOrderKey, ...rest } = thread;
        return rest;
      },
      reorder(thread: Thread, at: string, list: "pinned" | "active", orderKey: string): Thread {
        // Refused rather than pinning, un-settling or waking in passing: a
        // reorder that races an unpin must not bring the pin back, and a key
        // written on a shelf would place the thread when it comes back.
        if (list === "pinned" && thread.pinnedAt === undefined) {
          throw new ThreadsError("THREAD_NOT_PINNED", "The thread is not pinned", {
            threadId: thread.id,
          });
        }
        const nowMs = Date.parse(at);
        if (
          list === "active" &&
          (thread.pinnedAt !== undefined ||
            isSettled(thread, nowMs, settleRule()) ||
            isSnoozed(thread, nowMs))
        ) {
          throw new ThreadsError("THREAD_NOT_ACTIVE", "The thread is pinned, settled or snoozed", {
            threadId: thread.id,
          });
        }
        const key = list === "pinned" ? "pinOrderKey" : "activeOrderKey";
        return thread[key] === orderKey ? thread : { ...thread, [key]: orderKey };
      },
      unsnooze(thread: Thread, at: string): Thread {
        if (thread.snoozedUntil === undefined) return thread;
        const { snoozedUntil: _until, snoozedAt: _snoozedAt, ...rest } = thread;
        return { ...rest, lastSnoozeWakeAt: at };
      },
    };

    context.commands.register({
      name: "threads.settle",
      description:
        "Moves a thread to the Settled shelf until it is un-settled or its next turn; unpins it and wakes it if snoozed. A thread running a turn or waiting for an answer cannot settle",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) => arrange(threadId, (thread, at) => changes.settle(thread, at)),
    });

    context.commands.register({
      name: "threads.unsettle",
      description:
        "Brings a thread back from the Settled shelf to the top of the active threads; it stays active until its next turn. A thread not settled is left as it is",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) => arrange(threadId, (thread, at) => changes.unsettle(thread, at)),
    });

    context.commands.register({
      name: "threads.pin",
      description:
        "Pins a thread above the active ones, at `orderKey` among the pinned (else after the ordered ones); a settled thread comes back, a snoozed one wakes",
      input: ThreadId.extend({ orderKey: OrderKey.optional() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId, orderKey }) =>
        arrange(threadId, (thread, at) => changes.pin(thread, at, orderKey)),
    });

    context.commands.register({
      name: "threads.unpin",
      description: "Unpins a thread: it goes back among the active ones",
      input: ThreadId,
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) => arrange(threadId, (thread) => changes.unpin(thread)),
    });

    context.commands.register({
      name: "threads.reorder",
      description:
        "Gives a thread its place among the pinned or the active threads: a fractional `orderKey`, compared as text with the others' keys",
      input: ThreadId.extend({ list: z.enum(["pinned", "active"]), orderKey: OrderKey }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId, list, orderKey }) =>
        arrange(threadId, (thread, at) => changes.reorder(thread, at, list, orderKey)),
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
      handler: ({ threadId }) => arrange(threadId, (thread, at) => changes.unsnooze(thread, at)),
    });

    const ArrangeStep = z.discriminatedUnion("op", [
      ThreadId.extend({ op: z.literal("settle") }),
      ThreadId.extend({ op: z.literal("unsettle") }),
      ThreadId.extend({ op: z.literal("pin"), orderKey: OrderKey.optional() }),
      ThreadId.extend({ op: z.literal("unpin") }),
      ThreadId.extend({ op: z.literal("unsnooze") }),
      ThreadId.extend({
        op: z.literal("reorder"),
        list: z.enum(["pinned", "active"]),
        orderKey: OrderKey,
      }),
    ]);
    /** Runs `task` holding every record of `ids` (in one order, so two runs never wait on each other). */
    const holding = <T>(ids: readonly string[], task: () => Promise<T>): Promise<T> =>
      [...new Set(ids)]
        .toSorted()
        .reduceRight<() => Promise<T>>((inner, id) => () => queued(id, inner), task)();

    context.commands.register({
      name: "threads.arrange",
      description:
        "Several arrangement steps (settle, unsettle, pin, unpin, unsnooze, reorder) as one write, as a sidebar drop needs: every step is checked first, and one refused leaves every thread as it was",
      // A drop rewrites at most the keys of the threads a sidebar shows; a node keeps far fewer.
      input: z.object({ steps: z.array(ArrangeStep).min(1).max(10_000) }),
      output: z.object({ threads: z.array(Thread) }),
      permissions: ["threads.write"],
      handler: ({ steps }) =>
        holding(
          steps.map((step) => step.threadId),
          async () => {
            const at = now();
            const records = new Map<string, Thread>();
            const before = new Map<string, Thread>();
            for (const step of steps) {
              if (!before.has(step.threadId))
                before.set(step.threadId, await getThread(step.threadId));
              const thread = records.get(step.threadId) ?? before.get(step.threadId)!;
              if (thread.archivedAt !== undefined) throw archivedError(step.threadId);
              records.set(
                step.threadId,
                step.op === "pin"
                  ? changes.pin(thread, at, step.orderKey)
                  : step.op === "reorder"
                    ? changes.reorder(thread, at, step.list, step.orderKey)
                    : step.op === "unpin"
                      ? changes.unpin(thread)
                      : changes[step.op](thread, at),
              );
            }
            // Every step held: the records and their events in one transaction (D208).
            const written = [...records]
              .filter(([id, next]) => next !== before.get(id))
              .map(([, next]) => Thread.parse(next));
            if (written.length === 0) return { threads: written };
            await log.append(
              THREADS_STREAM,
              written.map((thread) => ({
                type: ThreadEvents.threadUpdated,
                payload: thread as unknown as Json,
              })),
              {
                records: written.map((thread) => ({
                  namespace: NAMESPACE,
                  key: `thread/${thread.id}`,
                  value: thread as unknown as Json,
                })),
              },
            );
            return { threads: written };
          },
        ),
    });

    // --- Settling by itself (D444–D447) ------------------------------------------
    // T3's ThreadSettlementService: the node settles a thread with no activity
    // for the configured days, and one whose pull request merged or closed.
    /** Settles a thread by the automatic rule, as of its last activity; false if it may not. */
    const autoSettle = (threadId: string, may: (thread: Thread, nowMs: number) => boolean) =>
      updateThread(threadId, (thread) => {
        const nowMs = Date.parse(now());
        if (!mayAutoSettle(thread, nowMs) || !may(thread, nowMs)) return thread;
        const { unsettledAt: _back, activeOrderKey: _key, ...rest } = thread;
        const activity = lastActivity(thread, nowMs);
        return {
          ...rest,
          settledOverride: "settled",
          settledAt: new Date(Number.isFinite(activity) ? activity : nowMs).toISOString(),
        };
      });

    context.commands.register({
      name: "threads.set-auto-settle",
      description:
        'Turns settling by itself on or off for one thread (T3\'s "Auto-settle behavior"): off, it settles only by hand',
      input: ThreadId.extend({ enabled: z.boolean() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId, enabled }) =>
        arrange(threadId, (thread, at) => {
          if (enabled) {
            const { autoSettleDisabledAt: _off, ...rest } = thread;
            return rest;
          }
          return thread.autoSettleDisabledAt === undefined
            ? { ...thread, autoSettleDisabledAt: at }
            : thread;
        }),
    });

    context.commands.register({
      name: "threads.auto-settle",
      description:
        "Settles a thread whose pull request merged or closed at `closedAt`, as the node's rule says: not one settled, pinned, snoozed, running, waiting or with auto-settle off, nor one the user wrote to since; merged ones only while jhin.threads.autoSettleOnMerge is on",
      input: ThreadId.extend({
        reason: z.enum(["pull-request-merged", "pull-request-closed"]),
        closedAt: z.iso.datetime({ offset: true }),
      }),
      output: z.object({ settled: z.boolean() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, reason, closedAt }) => {
        const config = context.config.get<Config>(CONFIG_SECTION);
        if (reason === "pull-request-merged" && !config.autoSettleOnMerge)
          return { settled: false };
        const closedMs = Date.parse(closedAt);
        const thread = await autoSettle(
          threadId,
          // A pull request that closed before the user's latest message is history.
          (current) =>
            closedMs >=
            Math.max(
              ...[
                current.createdAt,
                // A thread from before lastMessageAt was kept: its latest turn, to be safe.
                current.lastMessageAt ?? current.lastTurn?.at ?? "",
              ]
                .map(millis)
                .filter((value) => !Number.isNaN(value)),
            ),
        );
        return { settled: thread.settledOverride === "settled" };
      },
    });

    /** T3's sweep: every thread the inactivity rule settles now, written as settled. */
    const sweep = async () => {
      const rule = settleRule();
      if (rule === undefined) return;
      const nowMs = Date.parse(now());
      for (const thread of await listThreads()) {
        if (autoSettledAt(thread, nowMs, rule) === undefined) continue;
        await autoSettle(
          thread.id,
          (latest, latestMs) => autoSettledAt(latest, latestMs, settleRule()) !== undefined,
        ).catch((error: unknown) =>
          context.log.warn("settling a thread failed", {
            threadId: thread.id,
            error: String(error),
          }),
        );
      }
    };
    let sweeping: Promise<void> = Promise.resolve();
    const sweepNow = () => {
      sweeping = sweeping
        .then(sweep)
        .catch((error: unknown) =>
          context.log.warn("the settle sweep failed", { error: String(error) }),
        );
      return sweeping;
    };
    // Every minute, as T3 sweeps, and when the rule changes.
    const sweepTimer = setInterval(() => void sweepNow(), 60_000);
    sweepTimer.unref?.();
    context.subscriptions.add({ dispose: () => clearInterval(sweepTimer) });
    context.subscriptions.add(context.config.onDidChange(CONFIG_SECTION, () => void sweepNow()));
    void sweepNow();

    context.commands.register({
      name: "threads.sweep",
      description:
        "Settles now every thread the node's inactivity rule settles (the node also does this every minute)",
      input: z.object({}),
      output: z.object({}),
      permissions: ["threads.write"],
      handler: async () => {
        await sweepNow();
        return {};
      },
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

    /** Refuses a message without text and images. */
    const assertMessage = (text: string, attachments: readonly unknown[] | undefined) => {
      if (text.trim() === "" && (attachments ?? []).length === 0) {
        throw new ThreadsError("MESSAGE_EMPTY", "A message needs text or an attachment");
      }
    };

    /**
     * Starts a turn of a thread with a message: what `threads.send` does, and
     * what delivers a queued message (D202). Throws `TURN_IN_PROGRESS` on a
     * busy thread. `progress.recorded` says whether the turn's start was
     * recorded, so the message belongs to that turn even if it then failed.
     */
    async function startTurn(
      threadId: string,
      { text, attachments, ...requested }: Outgoing,
      options: {
        messageId?: string;
        progress?: { recorded: boolean };
        /** Written with the turn's start: a queued message leaving its queue. */
        alongside?: { events: readonly NewEvent[]; records: readonly RecordWrite[] };
        /**
         * Runs once the thread is held for the turn, as the last step before it
         * starts: a regeneration drops the turn it runs again (D224).
         */
        prepare?: (thread: Thread) => Promise<Thread>;
        /** A fork merged into the turn being run again (D226); else the thread's pending one. */
        merge?: { readonly threadId: string; readonly turnId: string };
      } = {},
    ): Promise<string> {
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
              .run(ThreadHooks.title, { thread: read, text }, ({ text: input }) =>
                titleFromText(input),
              )
              .catch(() => titleFromText(text))
          : undefined;
      const merge = options.merge;
      const turnId = Crypto.randomUUID();
      // Nothing is awaited between checking that the thread is free and taking it.
      const reservation = reserve(threadId, turnId, runtime.agentId);
      let thread: Thread;
      let settings: TurnSettings;
      let handoff: { payload: Json; text: string } | undefined;
      let dropMerge: string | undefined;
      let deliveredMerge: string | undefined;
      try {
        // The thread as it is now that it is ours: archived meanwhile, it takes no turn.
        thread = await getThread(threadId);
        if (thread.archivedAt !== undefined) throw archivedError(threadId);
        // A model named for another agent does not carry over to this one.
        const sameAgent = thread.agentId === undefined || thread.agentId === runtime.agentId;
        const model = requested.model ?? (sameAgent ? thread.model : undefined);
        const runtimeMode = requested.runtimeMode ?? thread.runtimeMode;
        const interactionMode = requested.interactionMode ?? thread.interactionMode;
        settings = {
          ...(model === undefined ? {} : { model }),
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
          ...(interactionMode === undefined ? {} : { interactionMode }),
        };
        const chosen = { agentId: runtime.agentId, ...settings };
        // A fork merged back meanwhile: its result goes with this message (D226).
        const marked = merge === undefined ? thread.pendingMergeBack : undefined;
        const delivering = merge ?? marked;
        const found =
          delivering === undefined ? undefined : await mergeBackHandoff(thread, delivering, text);
        if (typeof found === "object") handoff = found;
        // A pending mark whose fork or turn is gone goes now; one delivered goes once the
        // turn has started, so a turn that cannot start keeps it for the next message.
        if (found === "gone" && marked !== undefined) dropMerge = marked.id;
        if (typeof found === "object" && marked !== undefined) deliveredMerge = marked.id;
        // The record keeps what this turn runs with: no model of another agent.
        const dropModel = settings.model === undefined;
        // A new turn also brings a settled thread back and wakes a snoozed one.
        const at = now();
        await updateThread(threadId, (latest) => {
          const back = revived(latest, at, settleRule());
          const { model: _model, ...rest } = back;
          // The merge it delivers is done; one recorded since waits for the next message.
          const { pendingMergeBack: _merge, ...dropped } = dropModel ? rest : back;
          const next: Thread = {
            ...(dropMerge !== undefined && latest.pendingMergeBack?.id === dropMerge
              ? dropped
              : dropModel
                ? rest
                : back),
            ...chosen,
            lastMessageAt: at,
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
            (key) => next[key] !== latest[key],
          );
          return changed ? next : latest;
        });
        if (options.prepare !== undefined) thread = await options.prepare(thread);
        // The drop put back the mark of the merge this turn delivers again: it goes too.
        const restored = thread.pendingMergeBack;
        if (
          merge !== undefined &&
          handoff !== undefined &&
          restored?.threadId === merge.threadId &&
          restored.turnId === merge.turnId
        ) {
          deliveredMerge = restored.id;
        }
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
        options.messageId,
        options.progress,
        options.alongside,
        handoff,
      );
      if (deliveredMerge !== undefined) {
        const id = deliveredMerge;
        await updateThread(threadId, (latest) => {
          if (latest.pendingMergeBack?.id !== id) return latest;
          const { pendingMergeBack: _merge, ...rest } = latest;
          return rest;
        }).catch((error: unknown) =>
          context.log.error("could not record a merge-back delivered", {
            threadId,
            error: String(error),
          }),
        );
      }
      return turnId;
    }

    context.commands.register({
      name: "threads.send",
      description:
        "Sends a message and starts a turn; the response arrives as events of the thread. Agent, model and modes default to the thread's. A thread running a turn refuses it: queue it (threads.queue.add) or steer it in (threads.steer)",
      input: Outgoing,
      output: z.object({ turnId: z.string() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, ...message }) => {
        assertMessage(message.text, message.attachments);
        return { turnId: await startTurn(threadId, message) };
      },
    });

    // --- Queue and steering (D201–D205) ------------------------------------------
    // A thread's queue lives in the node's storage, so it outlives the page that
    // sent its messages; each change is announced on the thread's stream.
    const queueKey = (threadId: string) => `queue/${threadId}`;
    /** Queued messages steered whose removal from the queue could not be written: never sent again. */
    const taken = new Set<string>();
    /** Queued messages being promoted to a steer, as `thread:message`: they start no turn of their own. */
    const steering = new Set<string>();
    const readQueue = async (threadId: string): Promise<Queue> => {
      const value = await kv.get(NAMESPACE, queueKey(threadId));
      return value === undefined ? { messages: [] } : Queue.parse(value);
    };
    /** The event and the record that write a queue; an empty queue holds nothing. */
    const queueWrite = (threadId: string, queue: Queue) => {
      const next: Queue = queue.messages.length === 0 ? { messages: [] } : queue;
      const record: RecordWrite =
        next.messages.length === 0
          ? { namespace: NAMESPACE, key: queueKey(threadId), delete: true }
          : { namespace: NAMESPACE, key: queueKey(threadId), value: next as unknown as Json };
      return {
        next,
        event: { type: ThreadEvents.queueUpdated, payload: viewOf(next) as unknown as Json },
        record,
      };
    };
    const writeQueue = async (threadId: string, queue: Queue): Promise<Queue> => {
      const { next, event, record } = queueWrite(threadId, queue);
      await log.append(threadStream(threadId), [event], { records: [record] });
      return next;
    };
    /**
     * Changes a thread's queue: one change of a queue at a time, its delivery
     * included, and none on a thread being deleted, so nothing is written
     * after its deleted event.
     */
    const changeQueue = <T>(threadId: string, change: (queue: Queue) => Promise<T>) =>
      queued(queueKey(threadId), async () => {
        if (deleted.has(threadId)) {
          throw new ThreadsError("THREAD_NOT_FOUND", `No thread ${threadId}`, { threadId });
        }
        return change(await readQueue(threadId));
      });
    const notQueued = (threadId: string, messageId: string) =>
      new ThreadsError("QUEUED_MESSAGE_NOT_FOUND", `No queued message ${messageId}`, {
        threadId,
        messageId,
      });
    const failed = (what: string, threadId: string) => (error: unknown) => {
      // A thread deleted meanwhile has no queue left to keep.
      if (codeOf(error) !== "THREAD_NOT_FOUND") {
        context.log.error(what, { threadId, error: String(error) });
      }
    };

    /**
     * Starts the first queued message of a free thread whose queue is not
     * held (D202). It leaves the queue once its turn is reserved; a message
     * the node refuses stays first and holds the queue.
     */
    function deliver(threadId: string): Promise<void> {
      return changeQueue(threadId, async (queue) => {
        const head = queue.messages[0];
        if (stopping || head === undefined || queue.held !== undefined || active.has(threadId)) {
          return;
        }
        // Promoted to a steer at this moment: it goes into the turn, not after it.
        if (steering.has(`${threadId}:${head.id}`)) return;
        // Steered already, though storage still lists it: it leaves now, unsent.
        if (taken.has(`${threadId}:${head.id}`)) {
          taken.delete(`${threadId}:${head.id}`);
          await writeQueue(threadId, { ...queue, messages: queue.messages.slice(1) });
          void deliver(threadId);
          return;
        }
        const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...message } = head;
        const progress = { recorded: false };
        // It leaves the queue in the write that records its turn's start, so a
        // crash leaves it in one place or the other, never in neither.
        const { event, record } = queueWrite(threadId, { messages: queue.messages.slice(1) });
        try {
          await startTurn(threadId, message, {
            messageId: id,
            progress,
            alongside: { events: [event], records: [record] },
          });
        } catch (error) {
          if (deleted.has(threadId)) return;
          const at = now();
          const held = progress.recorded
            ? // Its turn failed as it started: the queue waits, as after any failed turn.
              { reason: "failed" as const, error: String((error as Error).message ?? error), at }
            : codeOf(error) === "TURN_IN_PROGRESS"
              ? undefined
              : {
                  reason: "refused" as const,
                  error: String((error as Error).message ?? error),
                  at,
                };
          if (progress.recorded) {
            if (held !== undefined) {
              await writeQueue(threadId, { messages: queue.messages.slice(1), held });
            }
          } else if (held !== undefined) {
            await writeQueue(threadId, { ...queue, held });
          }
        }
      }).catch(failed("could not deliver a queued message", threadId));
    }

    /**
     * Records the end of a stopped or failed turn, holding the thread's queue
     * in the same write when something waits in it (T3's queueHeld).
     */
    const recordEndHolding = (
      threadId: string,
      ending: { type: string; payload: Json },
      error: string | undefined,
      /** Frees the thread: called as soon as the end is recorded. */
      recorded: () => void,
    ) =>
      changeQueue(threadId, async (queue) => {
        const turnId = (ending.payload as { turnId: string }).turnId;
        const status = ending.type === ThreadEvents.turnFailed ? "failed" : "interrupted";
        if (queue.messages.length === 0 || queue.held !== undefined) {
          await log.append(threadStream(threadId), [ending]);
          recorded();
          return;
        }
        const held: Queue = {
          ...queue,
          held: { reason: status, turnId, ...(error === undefined ? {} : { error }), at: now() },
        };
        await log.append(
          threadStream(threadId),
          [ending, { type: ThreadEvents.queueUpdated, payload: viewOf(held) as unknown as Json }],
          {
            records: [
              { namespace: NAMESPACE, key: queueKey(threadId), value: held as unknown as Json },
            ],
          },
        );
        recorded();
      });

    /** Holds the queue of a thread whose turn was stopped or failed (T3's queueHeld). */
    function holdQueue(
      threadId: string,
      turnId: string,
      status: TurnStatus,
      error?: string,
    ): Promise<void> {
      if (status !== "interrupted" && status !== "failed") return Promise.resolve();
      return changeQueue(threadId, async (queue) => {
        if (queue.messages.length === 0 || queue.held !== undefined) return;
        await writeQueue(threadId, {
          ...queue,
          held: { reason: status, turnId, ...(error === undefined ? {} : { error }), at: now() },
        });
      }).catch(failed("could not hold a queue", threadId));
    }

    /**
     * Hands a message to the thread's running turn (D205). False when there
     * is none, or it ends before it took the message; throws for an agent that
     * cannot steer.
     */
    async function steerInto(
      threadId: string,
      messageId: string,
      /** The message, or `queued` to take it from the queue and out of it in the same write. */
      message: Pick<Outgoing, "text" | "attachments"> | "queued",
    ): Promise<boolean> {
      const current = active.get(threadId);
      if (current === undefined) return false;
      if (registry.get(current.agentId)?.steering !== true) {
        throw new ThreadsError("STEER_UNSUPPORTED", "The agent of this turn takes no steering", {
          threadId,
          agentId: current.agentId,
        });
      }
      // A turn still starting takes it once it has; nothing is locked meanwhile.
      await current.started;
      const steer = async (
        { text, attachments }: Pick<Outgoing, "text" | "attachments">,
        alongside?: { event: NewEvent; record: RecordWrite },
      ) => {
        const turn = current.turn;
        if (
          turn?.steer === undefined ||
          current.ending ||
          current.interrupted ||
          active.get(threadId) !== current
        ) {
          return false;
        }
        const input: TurnInput = { text, ...(attachments === undefined ? {} : { attachments }) };
        try {
          turn.steer(input);
        } catch {
          // It ended before it took the message.
          return false;
        }
        // Recorded at once, before anything the agent answers to it; a queued
        // message leaves its queue in the same write.
        const recording = log
          .append(
            threadStream(threadId),
            [
              {
                type: ThreadEvents.turnSteered,
                payload: { turnId: current.turnId, messageId, input: input as unknown as Json },
              },
              ...(alongside === undefined ? [] : [alongside.event]),
            ],
            alongside === undefined ? undefined : { records: [alongside.record] },
          )
          .catch(async (error: unknown) => {
            failed("could not record a steer", threadId)(error);
            // The agent has the message: it must not run again from the queue.
            if (alongside !== undefined) {
              await log
                .append(threadStream(threadId), [alongside.event], { records: [alongside.record] })
                .catch((again: unknown) => {
                  failed("could not take a steered message out of its queue", threadId)(again);
                  // Still queued on storage: the node drops it before it would start.
                  taken.add(`${threadId}:${messageId}`);
                });
            }
          });
        current.steering.add(recording);
        await recording;
        current.steering.delete(recording);
        return true;
      };
      if (message !== "queued") return steer(message);
      // Locked only now, with the agent ready: the message as it is, taken out
      // of the queue in the write that records the steer.
      return changeQueue(threadId, async (queue) => {
        const queued = queue.messages.find((item) => item.id === messageId);
        if (queued === undefined) throw notQueued(threadId, messageId);
        const { event, record } = queueWrite(threadId, {
          ...queue,
          messages: queue.messages.filter((item) => item.id !== messageId),
        });
        return steer(queued, { event, record });
      });
    }

    /**
     * Queues a message, or starts it at once on a free thread whose queue is
     * empty and not held (D201). `first` puts it at the head (a steer that
     * came too late).
     */
    function enqueue(
      threadId: string,
      messageId: string,
      message: Outgoing,
      first = false,
    ): Promise<{ messageId: string; turnId?: string }> {
      return changeQueue(threadId, async (queue) => {
        if (queue.messages.some((item) => item.id === messageId)) return { messageId };
        if (!active.has(threadId) && queue.messages.length === 0 && queue.held === undefined) {
          try {
            return { messageId, turnId: await startTurn(threadId, message, { messageId }) };
          } catch (error) {
            // Taken by a turn meanwhile: the message waits for it.
            if (codeOf(error) !== "TURN_IN_PROGRESS") throw error;
          }
        }
        const item: QueuedMessage = { id: messageId, ...message, createdAt: now() };
        await writeQueue(threadId, {
          ...queue,
          messages: first ? [item, ...queue.messages] : [...queue.messages, item],
        });
        // A free thread whose earlier message is still to start: this one follows it.
        if (!active.has(threadId)) void deliver(threadId);
        return { messageId };
      });
    }

    /** What every way of sending checks first: a message, a known agent, a live thread. */
    const checkOutgoing = async (threadId: string, message: Outgoing) => {
      assertMessage(message.text, message.attachments);
      if (message.agentId !== undefined && registry.get(message.agentId) === undefined) {
        throw new ThreadsError("AGENT_NOT_FOUND", `No agent ${message.agentId} on this node`, {
          agentId: message.agentId,
        });
      }
      const thread = await getThread(threadId);
      if (thread.archivedAt !== undefined) throw archivedError(threadId);
    };

    const QueueTarget = z.object({ threadId: z.string(), messageId: z.string() });
    const Sent = z.object({ messageId: z.string(), turnId: z.string().optional() });

    context.commands.register({
      name: "threads.queue.add",
      description:
        "Queues a message for a thread's next turn; on a free thread with nothing queued it starts the turn at once. Agent, model and modes go with the message",
      input: Outgoing.extend({ messageId: MessageIdInput.optional() }),
      output: Sent,
      permissions: ["threads.write"],
      handler: async ({ threadId, messageId, ...message }) => {
        await checkOutgoing(threadId, message);
        return enqueue(threadId, messageId ?? Crypto.randomUUID(), message);
      },
    });

    context.commands.register({
      name: "threads.queue.list",
      description: "A thread's queued messages, in the order they go, with their images",
      input: z.object({ threadId: z.string() }),
      output: Queue.omit({ resumedPast: true }),
      permissions: ["threads.read"],
      handler: async ({ threadId }) => {
        await getThread(threadId);
        const { resumedPast: _resumedPast, ...queue } = await readQueue(threadId);
        return queue;
      },
    });

    context.commands.register({
      name: "threads.queue.edit",
      description: "Changes the text, and the images if given, of a queued message",
      input: QueueTarget.extend({ text: z.string(), attachments: Attachments.optional() }),
      output: QueueView,
      permissions: ["threads.write"],
      handler: ({ threadId, messageId, text, attachments }) =>
        changeQueue(threadId, async (queue) => {
          const message = queue.messages.find((item) => item.id === messageId);
          if (message === undefined) throw notQueued(threadId, messageId);
          const next: QueuedMessage = {
            ...message,
            text,
            ...(attachments === undefined ? {} : { attachments }),
            updatedAt: now(),
          };
          assertMessage(next.text, next.attachments);
          return viewOf(
            await writeQueue(threadId, {
              ...queue,
              messages: queue.messages.map((item) => (item.id === messageId ? next : item)),
            }),
          );
        }),
    });

    context.commands.register({
      name: "threads.queue.reorder",
      description:
        "Moves a queued message before another one (`beforeMessageId`), or to the end (`null`)",
      input: QueueTarget.extend({ beforeMessageId: z.string().nullable() }),
      output: QueueView,
      permissions: ["threads.write"],
      handler: ({ threadId, messageId, beforeMessageId }) =>
        changeQueue(threadId, async (queue) => {
          const moving = queue.messages.find((item) => item.id === messageId);
          if (moving === undefined) throw notQueued(threadId, messageId);
          if (beforeMessageId === messageId) return viewOf(queue);
          const rest = queue.messages.filter((item) => item.id !== messageId);
          const index =
            beforeMessageId === null
              ? rest.length
              : rest.findIndex((item) => item.id === beforeMessageId);
          if (index === -1) throw notQueued(threadId, beforeMessageId!);
          const messages = [...rest.slice(0, index), moving, ...rest.slice(index)];
          if (messages.every((item, position) => item === queue.messages[position])) {
            return viewOf(queue);
          }
          return viewOf(await writeQueue(threadId, { ...queue, messages }));
        }),
    });

    context.commands.register({
      name: "threads.queue.cancel",
      description: "Removes a message from a thread's queue",
      input: QueueTarget,
      output: QueueView,
      permissions: ["threads.write"],
      handler: ({ threadId, messageId }) =>
        changeQueue(threadId, async (queue) => {
          if (!queue.messages.some((item) => item.id === messageId)) {
            throw notQueued(threadId, messageId);
          }
          return viewOf(
            await writeQueue(threadId, {
              ...queue,
              messages: queue.messages.filter((item) => item.id !== messageId),
            }),
          );
        }),
    });

    context.commands.register({
      name: "threads.queue.resume",
      description:
        "Lets a queue held after a stopped or failed turn, or a refused message, go on: its first message starts when the thread is free",
      input: z.object({ threadId: z.string() }),
      output: QueueView,
      permissions: ["threads.write"],
      handler: async ({ threadId }) => {
        const last = (await getThread(threadId)).lastTurn;
        const view = await changeQueue(threadId, async (queue) => {
          if (queue.held === undefined) return viewOf(queue);
          const { held, ...rest } = queue;
          const past = held.turnId ?? last?.turnId;
          return viewOf(
            await writeQueue(threadId, {
              ...rest,
              ...(past === undefined ? {} : { resumedPast: past }),
            }),
          );
        });
        void deliver(threadId);
        return view;
      },
    });

    context.commands.register({
      name: "threads.queue.steer",
      description:
        "Sends a queued message into the thread's running turn instead (a steer); it leaves the queue once the agent took it",
      input: QueueTarget,
      output: z.object({ messageId: z.string(), turnId: z.string() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, messageId }) => {
        const queue = await readQueue(threadId);
        if (!queue.messages.some((item) => item.id === messageId)) {
          throw notQueued(threadId, messageId);
        }
        // Promoted once at a time: a second call would clear the guard early.
        if (steering.has(`${threadId}:${messageId}`)) {
          throw new ThreadsError(
            "STEER_IN_PROGRESS",
            "This queued message is already being steered into the turn",
            { threadId, messageId },
          );
        }
        // Not delivered as a turn of its own while the agent takes it.
        steering.add(`${threadId}:${messageId}`);
        try {
          const turnId = active.get(threadId)?.turnId;
          if (turnId === undefined || !(await steerInto(threadId, messageId, "queued"))) {
            throw new ThreadsError(
              "TURN_NOT_RUNNING",
              "No turn of this thread is running to steer",
              {
                threadId,
              },
            );
          }
          return { messageId, turnId };
        } finally {
          steering.delete(`${threadId}:${messageId}`);
          // A turn that ended meanwhile left the queue to go on.
          if (!active.has(threadId)) void deliver(threadId);
        }
      },
    });

    context.commands.register({
      name: "threads.steer",
      description:
        "Sends a message into the thread's running turn (a steer). On a free thread it starts a turn; when the turn ends before the agent took it, it is queued first",
      input: Outgoing.extend({ messageId: MessageIdInput.optional() }),
      output: Sent.extend({ outcome: z.enum(["steered", "started", "queued"]) }),
      permissions: ["threads.write"],
      handler: async ({ threadId, messageId: given, ...message }) => {
        await checkOutgoing(threadId, message);
        const messageId = given ?? Crypto.randomUUID();
        const turnId = active.get(threadId)?.turnId;
        if (turnId !== undefined && (await steerInto(threadId, messageId, message))) {
          return { messageId, turnId, outcome: "steered" as const };
        }
        if (turnId === undefined) {
          // Nothing runs: the user's newest message starts a turn now, past a
          // held queue too, as a send would.
          try {
            const started = await startTurn(threadId, message, { messageId });
            return { messageId, turnId: started, outcome: "started" as const };
          } catch (error) {
            if (codeOf(error) !== "TURN_IN_PROGRESS") throw error;
          }
        }
        // The turn ended before it took the message: it goes first, as T3
        // starts the follow-up turn (held after a stop, as the rest are).
        const sent = await enqueue(threadId, messageId, message, true);
        return {
          ...sent,
          outcome: sent.turnId === undefined ? ("queued" as const) : ("started" as const),
        };
      },
    });

    // --- History (D220–D221) ----------------------------------------------------
    /** How a turn ended, by the type of its last event. */
    const ENDINGS: Record<string, TurnStatus> = {
      [ThreadEvents.turnCompleted]: "completed",
      [ThreadEvents.turnInterrupted]: "interrupted",
      [ThreadEvents.turnFailed]: "failed",
    };
    const turnIdOf = (event: { payload: unknown }) =>
      (event.payload as { turnId?: unknown } | null)?.turnId;

    /** The record's `lastTurn` for a turn of the thread's visible events, once it ended. */
    function endedTurn(events: readonly StoredEvent[], turnId: string): Thread["lastTurn"] {
      const ofTurn = events.filter((event) => turnIdOf(event) === turnId);
      const started = ofTurn.find((event) => event.type === ThreadEvents.turnStarted);
      const ended = ofTurn.findLast((event) => ENDINGS[event.type] !== undefined);
      const agentId = (started?.payload as { agentId?: unknown } | null)?.agentId;
      return {
        turnId,
        // A turn with no end recorded was closed by a restart (or never got one): stopped.
        status: ended === undefined ? "interrupted" : ENDINGS[ended.type]!,
        at: (ended ?? started)?.at ?? now(),
        agentId: typeof agentId === "string" ? agentId : "",
      };
    }

    /** The events a thread still shows and its visible turns, oldest first. */
    async function visibleTurns(threadId: string) {
      const events = visibleThreadEvents(await log.read(threadStream(threadId)));
      const turns = events
        .filter((event) => event.type === ThreadEvents.turnStarted)
        .map(turnIdOf)
        .filter((turnId): turnId is string => typeof turnId === "string");
      return { events, turns };
    }

    const turnNotFound = (threadId: string, turnId: string) =>
      new ThreadsError("TURN_NOT_FOUND", `The thread shows no turn ${turnId}`, {
        threadId,
        turnId,
      });

    /**
     * Drops the turns after `toTurnId` (every turn without it): one event on the
     * thread's stream, the log itself untouched. The caller holds the thread, so
     * no turn starts, and no archive or deletion writes, meanwhile.
     */
    async function dropTurns(
      thread: Thread,
      toTurnId: string | undefined,
    ): Promise<{ thread: Thread; turnIds: string[] }> {
      const { events, turns } = await visibleTurns(thread.id);
      const kept = toTurnId === undefined ? 0 : turns.indexOf(toTurnId) + 1;
      if (toTurnId !== undefined && kept === 0) throw turnNotFound(thread.id, toTurnId);
      const dropped = turns.slice(kept);
      if (dropped.length === 0) {
        // Nothing to drop, but a rollback whose record update failed after its
        // event was written left the record naming a dropped turn: mend it.
        const last = turns.at(-1);
        if (thread.lastTurn === undefined || thread.lastTurn.turnId === last) {
          return { thread, turnIds: [] };
        }
        const shown = last === undefined ? undefined : endedTurn(events, last);
        const mended = await updateThread(thread.id, (latest) => {
          const { lastTurn: _lastTurn, ...rest } = latest;
          return { ...rest, ...(shown === undefined ? {} : { lastTurn: shown }) };
        });
        return { thread: mended, turnIds: [] };
      }
      return context.hooks.run(
        ThreadHooks.rollback,
        { thread, turnIds: dropped, ...(toTurnId === undefined ? {} : { toTurnId }) },
        // A hook may wrap, delay or refuse the rollback, not change what it drops: the
        // event and the record are written from what the thread shows.
        async () => {
          await log.append(threadStream(thread.id), [
            {
              type: ThreadEvents.threadRolledBack,
              payload: {
                turnIds: dropped,
                ...(toTurnId === undefined ? {} : { toTurnId: toTurnId }),
              },
            },
          ]);
          const last = toTurnId === undefined ? undefined : endedTurn(events, toTurnId);
          // A dropped turn that delivered a fork's merge gives the mark back (D226): the
          // next message, or the turn run again, delivers it again. Of several, the
          // newest merge, as a newer merge replaces an older one.
          const droppedIds = new Set(dropped);
          const merged = events
            .filter(
              (event) =>
                event.type === ThreadEvents.turnStarted &&
                droppedIds.has(String(turnIdOf(event))) &&
                // A turn copied into a fork delivered its merge to the parent, not here.
                (event.payload as { inheritedAt?: unknown }).inheritedAt === undefined,
            )
            .map(
              (event) =>
                (event.payload as { handoff?: { threadId?: unknown; turnId?: unknown } }).handoff,
            )
            .findLast(
              (handoff) =>
                typeof handoff?.threadId === "string" && typeof handoff.turnId === "string",
            );
          const next = await updateThread(thread.id, (latest) => {
            const { lastTurn: _lastTurn, ...rest } = latest;
            return {
              ...rest,
              updatedAt: now(),
              ...(last === undefined ? {} : { lastTurn: last }),
              ...(merged !== undefined && latest.pendingMergeBack === undefined
                ? {
                    pendingMergeBack: {
                      id: Crypto.randomUUID(),
                      threadId: merged.threadId as string,
                      turnId: merged.turnId as string,
                      at: now(),
                    },
                  }
                : {}),
            };
          });
          return { thread: next, turnIds: dropped };
        },
      );
    }

    /**
     * A rollback on its own: it holds the thread while it drops, so no turn
     * starts and no archive or deletion writes meanwhile (they wait for it).
     */
    async function rollback(
      threadId: string,
      to: { turnId?: string | undefined } | { beforeTurnId: string },
    ): Promise<{ thread: Thread; turnIds: string[] }> {
      const read = await getThread(threadId);
      if (read.archivedAt !== undefined) throw archivedError(threadId);
      // Checking that the thread is free and holding it is one synchronous step.
      if (active.has(threadId)) {
        throw new ThreadsError("TURN_IN_PROGRESS", "The thread is running a turn", { threadId });
      }
      if (rollingBack.has(threadId)) {
        throw new ThreadsError("TURN_IN_PROGRESS", "The thread is rolling back its turns", {
          threadId,
        });
      }
      if (deleted.has(threadId)) {
        throw new ThreadsError("THREAD_NOT_FOUND", `No thread ${threadId}`, { threadId });
      }
      if (archiving.has(threadId)) throw archivedError(threadId);
      let release!: () => void;
      rollingBack.set(threadId, new Promise<void>((done) => (release = done)));
      try {
        const thread = await getThread(threadId);
        if (thread.archivedAt !== undefined) throw archivedError(threadId);
        if (!("beforeTurnId" in to)) return await dropTurns(thread, to.turnId);
        // Resolved under the hold: no turn comes or goes in between.
        const { turns } = await visibleTurns(threadId);
        const index = turns.indexOf(to.beforeTurnId);
        if (index === -1) throw turnNotFound(threadId, to.beforeTurnId);
        return await dropTurns(thread, turns[index - 1]);
      } finally {
        rollingBack.delete(threadId);
        release();
        // Messages queued while it held the thread go on (D202).
        void deliver(threadId);
      }
    }

    context.commands.register({
      name: "threads.rollback",
      description:
        "Drops the turns of a thread after `turnId` (every turn without it), or `beforeTurnId` and every turn after it; their events stay in the log, marked dropped. Refused while a turn runs",
      input: z
        .object({
          threadId: z.string(),
          turnId: z.string().optional(),
          beforeTurnId: z.string().optional(),
        })
        .refine(
          (input) => input.turnId === undefined || input.beforeTurnId === undefined,
          "takes `turnId` or `beforeTurnId`, not both",
        ),
      output: z.object({ thread: Thread, turnIds: z.array(z.string()) }),
      permissions: ["threads.write"],
      handler: ({ threadId, turnId, beforeTurnId }) =>
        rollback(threadId, beforeTurnId === undefined ? { turnId } : { beforeTurnId }),
    });

    /** What a turn started with, as its first event says. */
    function startedWith(events: readonly StoredEvent[], turnId: string) {
      const started = events.find(
        (event) => event.type === ThreadEvents.turnStarted && turnIdOf(event) === turnId,
      );
      return (started?.payload ?? {}) as {
        agentId?: string;
        input?: { text?: string; attachments?: TurnAttachment[] };
        model?: string;
        runtimeMode?: RuntimeMode;
        interactionMode?: InteractionMode;
        /** A fork merged into the turn (D226). */
        handoff?: { kind?: string; threadId?: string; turnId?: string };
        /** Set on a turn copied into a fork: its handoff was the parent's. */
        inheritedAt?: string;
      };
    }

    context.commands.register({
      name: "threads.turn",
      description:
        "A turn the thread shows: the message it started with and the agent, model and modes it ran with",
      input: z.object({ threadId: z.string(), turnId: z.string() }),
      output: z.object({
        turnId: z.string(),
        input: z.object({ text: z.string(), attachments: z.array(Attachment).optional() }),
        ...AgentSettings,
        agentId: z.string(),
        /** The turn before it, which a rollback to before this one keeps last. */
        previousTurnId: z.string().optional(),
      }),
      permissions: ["threads.read"],
      handler: async ({ threadId, turnId }) => {
        await getThread(threadId);
        const { events, turns } = await visibleTurns(threadId);
        const index = turns.indexOf(turnId);
        if (index === -1) throw turnNotFound(threadId, turnId);
        const payload = startedWith(events, turnId);
        const previous = turns[index - 1];
        return {
          turnId,
          agentId: payload.agentId ?? "",
          input: {
            text: payload.input?.text ?? "",
            ...(payload.input?.attachments === undefined
              ? {}
              : { attachments: [...payload.input.attachments] }),
          },
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(payload.runtimeMode === undefined ? {} : { runtimeMode: payload.runtimeMode }),
          ...(payload.interactionMode === undefined
            ? {}
            : { interactionMode: payload.interactionMode }),
          ...(previous === undefined ? {} : { previousTurnId: previous }),
        };
      },
    });

    context.commands.register({
      name: "threads.regenerate",
      description:
        "Runs a turn's message again: drops the turn (the latest by default) and every later one, then starts a turn with its text, images, agent, model and modes",
      input: z.object({ threadId: z.string(), turnId: z.string().optional() }),
      output: z.object({ turnId: z.string(), turnIds: z.array(z.string()) }),
      permissions: ["threads.write"],
      handler: async ({ threadId, turnId }) => {
        // An unknown thread is THREAD_NOT_FOUND, not a thread without turns.
        await getThread(threadId);
        const { events, turns } = await visibleTurns(threadId);
        const target = turnId ?? turns.at(-1);
        if (target === undefined) {
          throw new ThreadsError("TURN_NOT_FOUND", "The thread has no turn to regenerate", {
            threadId,
          });
        }
        if (!turns.includes(target)) throw turnNotFound(threadId, target);
        const payload = startedWith(events, target);
        // A turn whose message cannot be sent again is refused before anything is dropped.
        assertMessage(payload.input?.text ?? "", payload.input?.attachments);
        let dropped: string[] = [];
        // Its agent, unless that is gone from the node: then the thread's, as a send.
        const own = payload.agentId !== undefined && registry.get(payload.agentId) !== undefined;
        const next = await startTurn(
          threadId,
          {
            text: payload.input?.text ?? "",
            ...(payload.input?.attachments === undefined
              ? {}
              : { attachments: payload.input.attachments }),
            ...(own ? { agentId: payload.agentId } : {}),
            ...(own && payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.runtimeMode === undefined ? {} : { runtimeMode: payload.runtimeMode }),
            ...(payload.interactionMode === undefined
              ? {}
              : { interactionMode: payload.interactionMode }),
          },
          {
            prepare: async (thread) => {
              // Read again now that the thread is held: a rollback may have come first.
              const current = await visibleTurns(threadId);
              const index = current.turns.indexOf(target);
              if (index === -1) throw turnNotFound(threadId, target);
              const result = await dropTurns(thread, current.turns[index - 1]);
              dropped = result.turnIds;
              return result.thread;
            },
            // A fork merged into the turn is merged into its replacement too.
            ...(payload.inheritedAt === undefined &&
            payload.handoff?.threadId !== undefined &&
            payload.handoff.turnId !== undefined
              ? { merge: { threadId: payload.handoff.threadId, turnId: payload.handoff.turnId } }
              : {}),
          },
        );
        return { turnId: next, turnIds: dropped };
      },
    });

    /** A fork's turns of its own after its fork point, oldest first, and its visible events. */
    async function ownTurns(fork: Thread) {
      const { events, turns } = await visibleTurns(fork.id);
      // Copied turns carry their parent's time, also once the fork point is rolled back.
      const inherited = new Set(
        events
          .filter(
            (event) =>
              event.type === ThreadEvents.turnStarted &&
              (event.payload as { inheritedAt?: unknown } | null)?.inheritedAt !== undefined,
          )
          .map(turnIdOf),
      );
      return { events, own: turns.filter((turnId) => !inherited.has(turnId)) };
    }

    /**
     * The handoff of a fork merged back into `thread` (D226): what to tell the
     * agent, or `gone` when the fork or its merged turn no longer exists (the
     * mark is dropped), or `unreadable` (the mark stays for the next message).
     */
    async function mergeBackHandoff(
      thread: Thread,
      merge: { readonly threadId: string; readonly turnId: string; readonly id?: string },
      userText: string,
    ): Promise<{ payload: Json; text: string } | "gone" | "unreadable"> {
      try {
        // A mark whose turn started but whose clearing never got written (the node
        // stopped in between) was delivered: it is not delivered twice.
        if (merge.id !== undefined) {
          const { events: shown } = await visibleTurns(thread.id);
          const delivered = shown.some(
            (event) =>
              event.type === ThreadEvents.turnStarted &&
              (event.payload as { handoff?: { mergeId?: unknown } }).handoff?.mergeId === merge.id,
          );
          if (delivered) return "gone";
        }
        const fork = await getThread(merge.threadId);
        const { events, own } = await ownTurns(fork);
        const index = own.indexOf(merge.turnId);
        if (index === -1) return "gone";
        return {
          payload: {
            kind: "merge-back",
            threadId: fork.id,
            turnId: merge.turnId,
            ...(merge.id === undefined ? {} : { mergeId: merge.id }),
          },
          text: mergeBackMessage({
            fork,
            target: thread,
            events,
            turnIds: own.slice(0, index + 1),
            userText,
          }),
        };
      } catch (error) {
        if (error instanceof ThreadsError && error.code === "THREAD_NOT_FOUND") return "gone";
        context.log.warn("could not read a fork merged back; the message goes alone", {
          threadId: thread.id,
          forkId: merge.threadId,
          error: String(error),
        });
        return "unreadable";
      }
    }

    context.commands.register({
      name: "threads.fork",
      description:
        "Starts a thread from another one at a turn (the latest ended one by default): it copies the turns up to it and runs with the same agent, model and modes",
      input: z.object({
        threadId: z.string(),
        turnId: z.string().optional(),
        title: z.string().trim().min(1).max(200).optional(),
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ threadId, turnId, title }) => {
        const parent = await getThread(threadId);
        const { events, turns } = await visibleTurns(threadId);
        const current = active.get(threadId);
        const runningTurn = current?.turnId;
        const target = turnId ?? turns.findLast((id) => id !== runningTurn);
        if (target === undefined) {
          throw new ThreadsError("TURN_NOT_FOUND", "The thread has no ended turn to fork at", {
            threadId,
          });
        }
        if (!turns.includes(target)) throw turnNotFound(threadId, target);
        if (target === runningTurn) {
          throw new ThreadsError(
            "TURN_IN_PROGRESS",
            "The turn is still running: in-progress turns cannot be forked",
            { threadId, turnId: target },
          );
        }
        const kept = new Set(turns.slice(0, turns.indexOf(target) + 1));
        // The turns' own events; a fork's marker names a turn too, but is not one.
        const copied = events.filter((event) => {
          const id = turnIdOf(event);
          return event.type !== ThreadEvents.threadForked && typeof id === "string" && kept.has(id);
        });
        const { agentId, model, runtimeMode, interactionMode } = parent;
        return creatingIn(parent.projectId, () =>
          createThread(
            Crypto.randomUUID(),
            parent.projectId,
            title ?? `${parent.title} fork`,
            {
              ...(agentId === undefined ? {} : { agentId }),
              ...(model === undefined ? {} : { model }),
              ...(runtimeMode === undefined ? {} : { runtimeMode }),
              ...(interactionMode === undefined ? {} : { interactionMode }),
              forkedFrom: { threadId, turnId: target },
            },
            false,
            () => [
              // Each keeps the time it happened at in the parent.
              ...copied.map((event) => ({
                type: event.type,
                // A fork of a fork keeps the time its parent kept.
                payload: {
                  ...(event.payload as Record<string, Json>),
                  inheritedAt:
                    (event.payload as { inheritedAt?: string } | null)?.inheritedAt ?? event.at,
                },
              })),
              { type: ThreadEvents.threadForked, payload: { threadId, turnId: target } },
            ],
          ),
        );
      },
    });

    context.commands.register({
      name: "threads.merge-back",
      description:
        "Merges a fork back into the thread it was forked from: the fork's turns up to `turnId` (its latest ended one by default) go to that thread's agent with its next message",
      input: z.object({ threadId: z.string(), turnId: z.string().optional() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ threadId, turnId }) => {
        const fork = await getThread(threadId);
        if (fork.forkedFrom === undefined) {
          throw new ThreadsError("THREAD_NOT_FORK", "The thread is not a fork", { threadId });
        }
        const { own } = await ownTurns(fork);
        const current = active.get(threadId);
        const runningTurn = current?.turnId;
        const ended = own.filter((id) => id !== runningTurn);
        const target = turnId ?? ended.at(-1);
        if (target === undefined || !ended.includes(target)) {
          throw new ThreadsError(
            "TURN_NOT_FOUND",
            "Complete a run in this fork before merging it back",
            { threadId, ...(target === undefined ? {} : { turnId: target }) },
          );
        }
        const parentId = fork.forkedFrom.threadId;
        return updateThread(parentId, (parent) => {
          // An archived parent takes no message, so a mark there would never be delivered.
          if (parent.archivedAt !== undefined) throw archivedError(parentId);
          return {
            ...parent,
            // A newer merge of the same or another fork replaces one not yet delivered.
            pendingMergeBack: { id: Crypto.randomUUID(), threadId, turnId: target, at: now() },
          };
        });
      },
    });

    // --- Search (D227) -------------------------------------------------------------
    /**
     * Each thread's texts as of its stream head: a search reads only what came
     * since. Least recently searched threads go first once the texts held pass
     * SEARCH_CACHE_CHARS; a deleted or archived thread's go at once.
     */
    const searchCache = new Map<string, { head: number; texts: SearchText[]; size: number }>();
    let cachedChars = 0;
    /**
     * Reads under way, by thread: one whose thread is deleted or archived
     * meanwhile keeps nothing. An entry goes with its last read.
     */
    const reading = new Map<string, { count: number; dropped: boolean }>();
    const uncache = (threadId: string) => {
      const entry = searchCache.get(threadId);
      if (entry === undefined) return;
      cachedChars -= entry.size;
      searchCache.delete(threadId);
    };
    const forgetTexts = (threadId: string) => {
      const read = reading.get(threadId);
      if (read !== undefined) read.dropped = true;
      uncache(threadId);
    };
    async function textsOf(threadId: string): Promise<SearchText[]> {
      const read = reading.get(threadId) ?? { count: 0, dropped: false };
      read.count += 1;
      reading.set(threadId, read);
      try {
        return await readTexts(threadId, read);
      } finally {
        read.count -= 1;
        if (read.count === 0 && reading.get(threadId) === read) reading.delete(threadId);
      }
    }
    async function readTexts(
      threadId: string,
      read: { readonly dropped: boolean },
    ): Promise<SearchText[]> {
      const stream = threadStream(threadId);
      const cached = searchCache.get(threadId);
      const head = await log.head(stream);
      const added =
        cached !== undefined && cached.head === head
          ? []
          : await log.read(stream, { after: cached?.head ?? 0 });
      const dropped = new Set(
        added
          .filter((event) => event.type === ThreadEvents.threadRolledBack)
          .flatMap((event) => (event.payload as { turnIds?: string[] } | null)?.turnIds ?? []),
      );
      const kept = (cached?.texts ?? []).filter((text) => !dropped.has(text.turnId));
      const texts = [...kept, ...searchTexts(visibleThreadEvents(added))];
      // Deleted or archived while it was read: it matches nothing, and nothing is kept.
      if (read.dropped) return [];
      const readTo = added.at(-1)?.sequence ?? head;
      // A read that started earlier and ends later keeps the newer entry it finds.
      const newer = searchCache.get(threadId);
      if (newer !== undefined && newer.head > readTo) return texts;
      uncache(threadId);
      // Each text is held twice: as written and folded for matching.
      const size = texts.reduce((total, text) => total + text.text.length + text.folded.length, 0);
      // Last searched last: Map order is the eviction order.
      searchCache.set(threadId, { head: readTo, texts, size });
      cachedChars += size;
      for (const [id] of searchCache) {
        if (cachedChars <= SEARCH_CACHE_CHARS || id === threadId) break;
        uncache(id);
      }
      return texts;
    }
    context.subscriptions.add(
      log.subscribe(THREADS_STREAM, (event) => {
        const payload = event.payload as { id?: unknown; archivedAt?: unknown } | null;
        if (typeof payload?.id !== "string") return;
        if (
          event.type === ThreadEvents.threadDeleted ||
          (event.type === ThreadEvents.threadUpdated && typeof payload.archivedAt === "string")
        ) {
          forgetTexts(payload.id);
        }
      }),
    );

    const SearchMatch = z.object({
      threadId: z.string(),
      projectId: z.string(),
      source: z.enum(["user", "assistant"]),
      snippet: z.string().max(240),
      at: z.string(),
      /** The thread's last change, which orders the matches after their source. */
      updatedAt: z.string(),
    });

    context.commands.register({
      name: "threads.search",
      description:
        "Searches the messages of every thread that is not archived (case-insensitive): one match per thread, a user message first, user matches first, then the most recently changed threads",
      input: z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(50).default(50),
        projectId: z.string().optional(),
      }),
      output: z.object({ matches: z.array(SearchMatch) }),
      permissions: ["threads.read"],
      handler: async ({ query, limit, projectId }) => {
        const threads = (await listThreads()).filter(
          (thread) =>
            thread.archivedAt === undefined &&
            !deleted.has(thread.id) &&
            (projectId === undefined || thread.projectId === projectId),
        );
        const found: z.infer<typeof SearchMatch>[] = [];
        for (const thread of threads) {
          const match = matchTexts(await textsOf(thread.id), query);
          if (match === undefined) continue;
          found.push({
            threadId: thread.id,
            projectId: thread.projectId,
            ...match,
            updatedAt: thread.updatedAt ?? thread.createdAt,
          });
        }
        const matches = found
          .toSorted(
            (a, b) =>
              Number(a.source !== "user") - Number(b.source !== "user") ||
              b.updatedAt.localeCompare(a.updatedAt) ||
              a.threadId.localeCompare(b.threadId),
          )
          .slice(0, limit);
        return { matches };
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

    // Queues the node kept while it was down go on once every plugin is up,
    // so the agents they need are registered (D202). A turn the node closed
    // after a restart holds its thread's queue, as a stop does.
    const resumeQueues = async () => {
      for (const entry of await kv.list(NAMESPACE, { prefix: "queue/" })) {
        const threadId = entry.key.slice("queue/".length);
        const parsed = Queue.safeParse(entry.value);
        // One unreadable record costs its own queue, never the others'.
        const thread = Thread.safeParse(await kv.get(NAMESPACE, `thread/${threadId}`));
        if (!parsed.success || !thread.success) {
          context.log.warn("a queue left as it is: its record does not read", { threadId });
          continue;
        }
        const last = thread.data.lastTurn;
        if (
          (last?.status === "interrupted" || last?.status === "failed") &&
          last.turnId !== parsed.data.resumedPast
        ) {
          // holdQueue logs its own failure: the next queue is resumed all the same.
          await holdQueue(threadId, last.turnId, last.status);
        } else void deliver(threadId);
      }
    };
    const resume = () =>
      void resumeQueues().catch((error: unknown) =>
        context.log.error("could not resume the queues", { error: String(error) }),
      );
    if (context.state.get<boolean>("kernelStarted") === true) resume();
    else {
      const subscription = context.events.on("kernel.started", () => {
        subscription.dispose();
        context.state.set("kernelStarted", true);
        resume();
      });
    }
  },
});
