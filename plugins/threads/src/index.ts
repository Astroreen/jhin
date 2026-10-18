import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  AGENT_RUNTIME_CAPABILITY,
  ThreadEvents,
  threadStream,
  type AgentRuntime,
  type AgentTurn,
} from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";

const NAMESPACE = "jhin.threads";
const DRAIN_TIMEOUT_MS = 5000;
/** One event per thread created on this node, in order. */
export const THREADS_STREAM = "threads";

/** Every node has this project for chats without a project (D51). */
export const SCRATCH_PROJECT = "scratch";

const Project = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute working directory on this node. */
  path: z.string(),
  scratch: z.boolean(),
  createdAt: z.string(),
});
type Project = z.infer<typeof Project>;

const Thread = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.string(),
});
type Thread = z.infer<typeof Thread>;

const StoredEventSchema = z.object({
  stream: z.string(),
  sequence: z.number(),
  type: z.string(),
  payload: z.unknown(),
  at: z.string(),
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
  /** Set once the agent started; an interrupt before that is applied when it does. */
  turn: AgentTurn | undefined;
  readonly done: Promise<void>;
  interrupted: boolean;
}

export default definePlugin({
  async activate(context) {
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
      const existing = (await kv.list(NAMESPACE, { prefix: "thread/" }))
        .map((entry) => Thread.parse(entry.value))
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
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

    /** Reserves the thread synchronously, so two sends can never both start a turn. */
    function reserve(threadId: string, turnId: string): { entry: Running; finish: () => void } {
      let finish!: () => void;
      const entry: Running = {
        turnId,
        turn: undefined,
        done: new Promise((resolve) => (finish = resolve)),
        interrupted: false,
      };
      active.set(threadId, entry);
      return {
        entry,
        finish: () => {
          if (active.get(threadId) === entry) active.delete(threadId);
          finish();
        },
      };
    }

    async function runTurn(
      thread: Thread,
      text: string,
      runtime: AgentRuntime,
      { entry, finish }: ReturnType<typeof reserve>,
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
            payload: { turnId, agentId: runtime.agentId, input: { text } },
          },
        ]);
        try {
          turn = runtime.startTurn({
            threadId: thread.id,
            turnId,
            input: { text },
            history,
            cwd: project.path,
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
          throw error;
        }
      } catch (error) {
        finish();
        throw error;
      }
      entry.turn = turn;
      if (entry.interrupted) turn.interrupt();
      /** Appends a turn's last event; a storage failure here is logged, never thrown. */
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
      void (async () => {
        try {
          let completed = false;
          for await (const item of turn.items) {
            if (item.kind === "message.completed") completed = true;
            const type =
              item.kind === "message.delta" ? ThreadEvents.itemDelta : ThreadEvents.itemCompleted;
            await log.append(stream, [
              { type, payload: { turnId, itemId: item.itemId, kind: "message", text: item.text } },
            ]);
          }
          await log.append(stream, [
            {
              // A turn that delivered its answer is complete even if an interrupt came late.
              type:
                entry.interrupted && !completed
                  ? ThreadEvents.turnInterrupted
                  : ThreadEvents.turnCompleted,
              payload: { turnId },
            },
          ]);
        } catch (error) {
          context.log.warn("turn failed", { threadId: thread.id, turnId, error: String(error) });
          await recordEnd(ThreadEvents.turnFailed, { turnId, error: String(error) });
        } finally {
          finish();
        }
      })();
    }

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
      description: "Registers a working directory on this node as a project",
      input: z.object({ name: z.string().min(1), path: z.string().min(1) }),
      output: Project,
      permissions: ["projects.write"],
      handler: async ({ name, path: given }) => {
        // Stored normalised: "/a/../b" becomes "/b".
        const path = Path.resolve(given);
        if (!Path.isAbsolute(given) || !Fs.existsSync(path) || !Fs.statSync(path).isDirectory()) {
          throw new ThreadsError(
            "PROJECT_PATH_INVALID",
            `${path} is not an existing absolute directory`,
            { path },
          );
        }
        const project: Project = {
          id: Crypto.randomUUID(),
          name,
          path,
          scratch: false,
          createdAt: now(),
        };
        await kv.set(NAMESPACE, `project/${project.id}`, project);
        return project;
      },
    });

    context.commands.register({
      name: "threads.list",
      description: "Threads on this node, oldest first, optionally of one project",
      input: z.object({ projectId: z.string().optional() }),
      output: z.array(Thread),
      permissions: ["threads.read"],
      handler: async ({ projectId }) =>
        (await kv.list(NAMESPACE, { prefix: "thread/" }))
          .map((entry) => Thread.parse(entry.value))
          .filter((thread) => projectId === undefined || thread.projectId === projectId)
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });

    context.commands.register({
      name: "threads.create",
      description: "Starts a thread in a project (the scratch project by default)",
      input: z.object({
        projectId: z.string().default(SCRATCH_PROJECT),
        title: z.string().min(1).default("New thread"),
      }),
      output: Thread,
      permissions: ["threads.write"],
      handler: async ({ projectId, title }) => {
        await getProject(projectId);
        const thread: Thread = { id: Crypto.randomUUID(), projectId, title, createdAt: now() };
        // The stream's first event comes first: a thread record never exists without it.
        await log.append(threadStream(thread.id), [
          { type: ThreadEvents.threadCreated, payload: thread as unknown as Json },
        ]);
        // The node's index of threads: other nodes follow it to mirror new threads (D26 eager).
        await log.append(THREADS_STREAM, [
          { type: ThreadEvents.threadCreated, payload: thread as unknown as Json },
        ]);
        await kv.set(NAMESPACE, `thread/${thread.id}`, thread);
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
        "Sends a message and starts a turn; the response arrives as events of the thread",
      input: z.object({ threadId: z.string(), text: z.string().min(1) }),
      output: z.object({ turnId: z.string() }),
      permissions: ["threads.write"],
      handler: async ({ threadId, text }) => {
        const thread = await getThread(threadId);
        const runtime = context.services.tryGet<AgentRuntime>(AGENT_RUNTIME_CAPABILITY);
        if (runtime === undefined) {
          throw new ThreadsError("NO_AGENT", "No agent runtime is installed on this node");
        }
        const current = active.get(threadId);
        if (current !== undefined) {
          throw new ThreadsError("TURN_IN_PROGRESS", "The thread is already running a turn", {
            threadId,
            turnId: current.turnId,
          });
        }
        const turnId = Crypto.randomUUID();
        await runTurn(thread, text, runtime, reserve(threadId, turnId));
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
  },
});
