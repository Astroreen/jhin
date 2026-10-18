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
  threadStream,
  type AgentItem,
  type AgentRegistry,
  type AgentResponse,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentTurn,
  type InteractionMode,
  type RuntimeMode,
  type TurnAttachment,
} from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
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
/** How long an agent runtime's `status()` answer is reused. */
const STATUS_TTL_MS = 30_000;
/** The title a thread gets until its first message names it. */
export const DEFAULT_THREAD_TITLE = "New thread";
const MAX_TITLE_LENGTH = 60;
/** Per image, as a data URL (base64 adds a third). */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_BROWSE_ENTRIES = 500;

/** Every node has this project for chats without a project (D51). */
export const SCRATCH_PROJECT = "scratch";

const Config = z.object({
  /** Agent of new threads; the first available runtime when unset. */
  defaultAgent: z.string().optional(),
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
});
type Thread = z.infer<typeof Thread>;

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
  /** Requests the agent opened that nobody answered yet. */
  readonly openRequests: Set<string>;
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

export default definePlugin({
  async activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const paths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
    const active = new Map<string, Running>();
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

    /** Changes to one thread's record run one at a time, so none overwrites another. */
    const pending = new Map<string, Promise<unknown>>();
    function updateThread(id: string, change: (thread: Thread) => Thread): Promise<Thread> {
      const run = async () => {
        const current = await getThread(id);
        const changed = change(current);
        if (changed === current) return current;
        const next = Thread.parse(changed);
        await kv.set(NAMESPACE, `thread/${id}`, next as unknown as Json);
        await log.append(THREADS_STREAM, [
          { type: ThreadEvents.threadUpdated, payload: next as unknown as Json },
        ]);
        return next;
      };
      const previous = pending.get(id) ?? Promise.resolve();
      const result = previous.then(run, run);
      const settled = result.catch(() => undefined);
      pending.set(id, settled);
      void settled.then(() => {
        if (pending.get(id) === settled) pending.delete(id);
      });
      return result;
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
        // A turn's late ending never overwrites the status of a newer turn.
        status !== "running" && thread.lastTurn !== undefined && thread.lastTurn.turnId !== turnId
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
    // (a crash) never got its last event: it is closed as interrupted now.
    for (const thread of await listThreads()) {
      const last = thread.lastTurn;
      if (last === undefined || (last.status !== "running" && last.status !== "waiting")) continue;
      const stream = threadStream(thread.id);
      const head = await log.head(stream);
      const tail = await log.read(stream, { after: Math.max(0, head - 50) });
      const endings: Record<string, TurnStatus> = {
        [ThreadEvents.turnCompleted]: "completed",
        [ThreadEvents.turnInterrupted]: "interrupted",
        [ThreadEvents.turnFailed]: "failed",
      };
      const ended = tail.findLast(
        (event) =>
          endings[event.type] !== undefined &&
          (event.payload as { turnId?: unknown } | null)?.turnId === last.turnId,
      );
      if (ended === undefined) {
        await log.append(stream, [
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
     * Reserves the thread synchronously, so two sends can never both start a
     * turn. `release` frees the thread once the turn's last event is recorded;
     * `finish` (which releases too) ends the turn's work for the shutdown drain.
     */
    function reserve(
      threadId: string,
      turnId: string,
      agentId: string,
    ): { entry: Running; release: () => void; finish: () => void } {
      let resolve!: () => void;
      const entry: Running = {
        turnId,
        agentId,
        turn: undefined,
        done: new Promise((done) => (resolve = done)),
        interrupted: false,
        openRequests: new Set(),
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
      { entry, release, finish }: ReturnType<typeof reserve>,
    ): Promise<void> {
      const { turnId } = entry;
      const stream = threadStream(thread.id);
      let turn: AgentTurn;
      try {
        const project = await getProject(thread.projectId);
        const history = await log.read(stream);
        await log.append(stream, [
          {
            type: ThreadEvents.turnStarted,
            payload: {
              turnId,
              agentId: runtime.agentId,
              input: input as unknown as Json,
              ...(settings as Record<string, Json>),
            },
          },
        ]);
        await setTurnStatus(thread.id, turnId, runtime.agentId, "running");
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
        const open = [...entry.openRequests];
        entry.openRequests.clear();
        for (const requestId of open) {
          await recordEnd(ThreadEvents.requestResolved, { turnId, requestId });
        }
      };
      void (async () => {
        let ending: { type: string; status: TurnStatus; error?: string };
        try {
          // A turn that delivered its answer is complete even if an interrupt came late.
          let answered = false;
          for await (const item of turn.items) {
            answered = item.kind === "message.completed";
            if (item.kind === "request.opened") entry.openRequests.add(item.requestId);
            const event = eventOf(turnId, item);
            await log.append(stream, [event]);
            if (item.kind === "request.opened" && entry.openRequests.size === 1) {
              await setTurnStatus(thread.id, turnId, runtime.agentId, "waiting", item.request.kind);
            }
          }
          ending =
            entry.interrupted && !answered
              ? { type: ThreadEvents.turnInterrupted, status: "interrupted" }
              : { type: ThreadEvents.turnCompleted, status: "completed" };
        } catch (error) {
          context.log.warn("turn failed", { threadId: thread.id, turnId, error: String(error) });
          ending = { type: ThreadEvents.turnFailed, status: "failed", error: String(error) };
        }
        try {
          await closeRequests();
          await recordEnd(ending.type, {
            turnId,
            ...(ending.error === undefined ? {} : { error: ending.error }),
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
      })();
    }

    /** Stops a thread's running turn, if any, and waits until it has ended. */
    async function stopTurn(threadId: string): Promise<void> {
      const current = active.get(threadId);
      if (current === undefined) return;
      current.interrupted = true;
      current.turn?.interrupt();
      await current.done;
    }

    async function deleteThread(thread: Thread): Promise<void> {
      await stopTurn(thread.id);
      await log.append(threadStream(thread.id), [
        { type: ThreadEvents.threadDeleted, payload: { id: thread.id } },
      ]);
      await kv.delete(NAMESPACE, `thread/${thread.id}`);
      await log.append(THREADS_STREAM, [
        { type: ThreadEvents.threadDeleted, payload: { id: thread.id } },
      ]);
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
        const expanded = given.startsWith("~") ? Path.join(Os.homedir(), given.slice(1)) : given;
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
      handler: async ({ projectId, name }) => {
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
      },
    });

    context.commands.register({
      name: "projects.delete",
      description:
        "Removes a project and deletes its threads; its directory stays on disk untouched",
      input: z.object({ projectId: z.string() }),
      output: z.object({ deletedThreads: z.number() }),
      permissions: ["projects.write"],
      handler: async ({ projectId }) => {
        const project = await getProject(projectId);
        if (project.scratch) {
          throw new ThreadsError("PROJECT_IS_SCRATCH", "The scratch project cannot be removed", {
            projectId,
          });
        }
        const threads = (await listThreads()).filter((thread) => thread.projectId === projectId);
        for (const thread of threads) await deleteThread(thread);
        await kv.delete(NAMESPACE, `project/${projectId}`);
        await projectEvent(ThreadEvents.projectDeleted, { id: projectId });
        return { deletedThreads: threads.length };
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
      permissions: ["projects.write"],
      handler: ({ path: given }) => {
        const home = Os.homedir();
        const raw = given === undefined || given.trim() === "" ? home : given.trim();
        const expanded = raw.startsWith("~") ? Path.join(home, raw.slice(1)) : raw;
        if (!Path.isAbsolute(expanded)) {
          throw new ThreadsError("PATH_INVALID", `${raw} is not an absolute path`, { path: raw });
        }
        const path = Path.resolve(expanded);
        let names: Fs.Dirent[];
        try {
          names = Fs.readdirSync(path, { withFileTypes: true });
        } catch {
          throw new ThreadsError("PATH_INVALID", `${path} cannot be read`, { path });
        }
        const entries = names
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name)
          .toSorted((a, b) => a.localeCompare(b))
          .slice(0, MAX_BROWSE_ENTRIES)
          .map((name) => {
            const full = Path.join(path, name);
            return { name, path: full, git: Fs.existsSync(Path.join(full, ".git")) };
          });
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
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ projectId, title, ...settings }) => {
        await getProject(projectId);
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
        // The node's index of threads: other nodes follow it to mirror new threads (D26 eager).
        await log.append(THREADS_STREAM, [
          { type: ThreadEvents.threadCreated, payload: thread as unknown as Json },
        ]);
        await kv.set(NAMESPACE, `thread/${thread.id}`, thread as unknown as Json);
        return thread;
      },
    });

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
      handler: ({ threadId, title, ...settings }) =>
        updateThread(threadId, (thread) => ({
          ...thread,
          ...(title === undefined ? {} : { title, updatedAt: now() }),
          ...settings,
        })),
    });

    context.commands.register({
      name: "threads.archive",
      description: "Hides a thread from lists until it is unarchived; stops its running turn",
      input: z.object({ threadId: z.string() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ threadId }) => {
        await getThread(threadId);
        await stopTurn(threadId);
        return updateThread(threadId, (thread) => ({ ...thread, archivedAt: now() }));
      },
    });

    context.commands.register({
      name: "threads.unarchive",
      description: "Brings an archived thread back into lists",
      input: z.object({ threadId: z.string() }),
      output: Thread,
      permissions: ["threads.write"],
      handler: ({ threadId }) =>
        updateThread(threadId, ({ archivedAt: _archivedAt, ...thread }) => thread),
    });

    context.commands.register({
      name: "threads.delete",
      description:
        "Deletes a thread: it leaves every list; its event stream keeps a final deleted event",
      input: z.object({ threadId: z.string() }),
      output: z.object({ deleted: z.boolean() }),
      permissions: ["threads.write"],
      handler: async ({ threadId }) => {
        await deleteThread(await getThread(threadId));
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
        attachments: z.array(Attachment).max(MAX_ATTACHMENTS).optional(),
        ...AgentSettings,
      }),
      output: z.object({ turnId: z.string() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, text, attachments, ...requested }) => {
        if (text.trim() === "" && (attachments ?? []).length === 0) {
          throw new ThreadsError("MESSAGE_EMPTY", "A message needs text or an attachment");
        }
        const thread = await getThread(threadId);
        const current = active.get(threadId);
        if (current !== undefined) {
          throw new ThreadsError("TURN_IN_PROGRESS", "The thread is already running a turn", {
            threadId,
            turnId: current.turnId,
          });
        }
        const agentId = requested.agentId ?? thread.agentId;
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
        // A model named for another agent does not carry over to this one.
        const sameAgent = thread.agentId === undefined || thread.agentId === runtime.agentId;
        const model = requested.model ?? (sameAgent ? thread.model : undefined);
        const runtimeMode = requested.runtimeMode ?? thread.runtimeMode;
        const interactionMode = requested.interactionMode ?? thread.interactionMode;
        const settings: TurnSettings = {
          ...(model === undefined ? {} : { model }),
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
          ...(interactionMode === undefined ? {} : { interactionMode }),
        };
        const turnId = Crypto.randomUUID();
        const reservation = reserve(threadId, turnId, runtime.agentId);
        // The first message names a thread that still has the default title.
        const named =
          thread.lastTurn === undefined && thread.title === DEFAULT_THREAD_TITLE
            ? await context.hooks
                .run("threads.title", { thread, text }, ({ text: input }) => titleFromText(input))
                .catch(() => titleFromText(text))
            : thread.title;
        const chosen = { agentId: runtime.agentId, ...settings };
        const changed =
          named !== thread.title ||
          Object.entries(chosen).some(
            ([key, value]) => (thread as Record<string, unknown>)[key] !== value,
          );
        try {
          if (changed) {
            await updateThread(threadId, (latest) => ({ ...latest, ...chosen, title: named }));
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
        if (current === undefined || !current.openRequests.has(requestId)) {
          throw new ThreadsError("REQUEST_NOT_FOUND", `No open request ${requestId}`, {
            threadId,
            requestId,
          });
        }
        const turn = current.turn;
        if (turn?.respond === undefined) {
          throw new ThreadsError("REQUEST_UNSUPPORTED", "The agent takes no answers", {
            threadId,
            requestId,
          });
        }
        current.openRequests.delete(requestId);
        await log.append(threadStream(threadId), [
          {
            type: ThreadEvents.requestResolved,
            payload: {
              turnId: current.turnId,
              requestId,
              response: response as unknown as Json,
            },
          },
        ]);
        turn.respond(requestId, response);
        if (current.openRequests.size === 0 && active.get(threadId) === current) {
          await setTurnStatus(threadId, current.turnId, current.agentId, "running");
        }
        return { resolved: true };
      },
    });
  },
});
