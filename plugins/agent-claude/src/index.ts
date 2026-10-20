import * as Crypto from "node:crypto";
import * as Os from "node:os";

import {
  AGENT_REGISTRY_CAPABILITY,
  THREADS_STREAM,
  ThreadEvents,
  type AgentModel,
  type AgentRegistry,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentTurn,
} from "@jhin/agent-api";
import { MCP_SERVER_CAPABILITY, type McpServer } from "@jhin/mcp-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";
import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { claudeConfigDir, deleteSessionFiles } from "./files.ts";
import {
  BUNDLED_DEFAULT_MODEL,
  BUNDLED_MODELS,
  manifestContextWindow,
  withOptions,
} from "./models.ts";
import {
  createLiveSessions,
  type Attachment,
  type LiveSessions,
  type QueryFunction,
} from "./session.ts";
import {
  CLAUDE_AGENT_ID,
  MCP_SERVER_NAME,
  claudeEnvironment,
  claudeTurn,
  type SessionStore,
} from "./turn.ts";

export {
  CLAUDE_AGENT_ID,
  JHIN_MCP_INSTRUCTIONS,
  MCP_SERVER_NAME,
  claudeTurn,
  permissionMode,
  transcript,
  type QueryFunction,
} from "./turn.ts";
export {
  BackgroundWorkRunning,
  SessionTakenOver,
  createLiveSessions,
  type Attachment,
  type LiveSessionInfo,
  type LiveSessions,
} from "./session.ts";
export * from "./mapping.ts";

export const CONFIG_SECTION = "jhin.agent-claude";
const NAMESPACE = "jhin.agent-claude";

/** How long a status probe (it starts Claude Code) is reused. */
const STATUS_TTL_MS = 5 * 60_000;
/** How long a probe that found Claude Code unavailable is reused: a sign-in shows soon. */
const UNAVAILABLE_TTL_MS = 10_000;
/** A probe that takes longer reports Claude Code as unavailable. */
const PROBE_TIMEOUT_MS = 25_000;

/** What a thread's Claude Code may do through the node's MCP server (D341). */
export const AGENT_PERMISSIONS: readonly string[] = [
  "threads.read",
  "threads.write",
  "projects.read",
  "projects.write",
  "projects.browse",
  "git.read",
  "git.write",
  "mesh.read",
];

/** A permission that only reads: `threads.read`, `projects.browse`. */
const readsOnly = (permission: string) =>
  permission.endsWith(".read") || permission === "projects.browse";

/**
 * Claude Code aborts an HTTP MCP call after 60 s unless the server sets a timeout; a tool
 * that waits (a thread's turn, W10's tasks) may take up to an hour, so T3's budget.
 */
const MCP_TOOL_TIMEOUT_MS = 65 * 60_000;

/** The node's MCP server for one Claude Code: a credential of its own, revoked when it ends. */
export function mcpAttachment(server: McpServer, threadId: string): Attachment {
  const credential = server.issue({
    id: `${CLAUDE_AGENT_ID}:${threadId}`,
    permissions: AGENT_PERMISSIONS,
    threadId,
  });
  return {
    servers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: credential.url,
        headers: { ...credential.headers },
        timeout: MCP_TOOL_TIMEOUT_MS,
      },
    },
    dispose: () => credential.dispose(),
  };
}

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
export const Config = z
  .object({
    binaryPath: z.string().optional().meta({
      title: "Claude Code executable",
      description:
        "Path to the `claude` executable; the one bundled with the Claude Agent SDK when unset",
      advanced: true,
    }),
    defaultModel: z
      .string()
      .optional()
      .meta({ title: "Default model", description: "Model of turns that name none" }),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .meta({ title: "Effort", description: "Reasoning effort; Claude Code's default when unset" }),
    env: z.record(z.string(), z.string()).optional().meta({
      title: "Environment",
      description:
        "Environment variables for Claude Code, e.g. CLAUDE_CONFIG_DIR. Config is readable by anyone holding the node's token: keep secrets such as ANTHROPIC_API_KEY in the node's own environment",
      // The settings page hides the values (D83); host.config.get still returns them.
      writeOnly: true,
      advanced: true,
    }),
    inheritEnv: z.array(z.string()).default(["*"]).meta({
      title: "Inherited environment",
      description:
        "The node's environment variables Claude Code gets: names, or prefixes ending in * (e.g. LC_*). * passes all of them; a narrower list keeps variables meant for the node away from Claude Code and the commands it runs",
      advanced: true,
    }),
    appendSystemPrompt: z.string().optional().meta({
      title: "Appended system prompt",
      description: "Instructions appended to Claude Code's system prompt",
    }),
    session: z
      .union([
        z.literal("keep-alive").meta({ title: "Keep running between turns" }),
        z.literal("per-turn").meta({ title: "Start for every turn" }),
      ])
      .default("keep-alive")
      .meta({
        title: "Session",
        description:
          "Keep running: a thread's Claude Code stays up between turns, so the next answer starts sooner, at the cost of a process (and its memory) per thread with a recent turn. Start for every turn: each turn starts Claude Code and resumes the thread's session",
      }),
    mcp: z.boolean().default(true).meta({
      title: "Jhin tools",
      description:
        "Give Claude Code this node's MCP server, so it can work with Jhin's threads and projects when asked",
    }),
    maxLiveSessions: z.number().int().nonnegative().default(8).meta({
      title: "Live sessions",
      description:
        "How many threads' Claude Codes the node keeps running at most; the idle ones that waited longest end first. 0: no limit",
      advanced: true,
    }),
    sessionIdleMinutes: z.number().int().nonnegative().default(10).meta({
      title: "Idle minutes",
      description:
        "Minutes a kept Claude Code waits for the thread's next turn before it exits; 0 keeps it until the thread is archived or deleted or the node stops",
    }),
  })
  .meta({ title: "Claude Code", description: "The Claude Code agent runtime of this node." });
export type Config = z.output<typeof Config>;

/** What a status probe learnt: whether Claude Code runs and is signed in, and its models. */
interface Probe {
  readonly status: AgentRuntimeStatus;
  readonly models?: readonly AgentModel[];
}

/** A probe as kept, with when it ran and the configuration (`key`) it ran with. */
export interface StoredProbe {
  readonly at: number;
  readonly key: string;
  readonly probe: Probe;
}

/** Where the last probe is kept across restarts (D344). */
export interface ProbeStore {
  load(): Promise<StoredProbe | undefined>;
  save(probe: StoredProbe): Promise<void>;
}

/**
 * Starts Claude Code without a prompt and reads its initialization (account and models),
 * as T3 Code's ClaudeProvider capability probe does; nothing reaches the API.
 */
async function probe(query: QueryFunction, config: Config): Promise<Probe> {
  let release!: () => void;
  const finished = new Promise<void>((resolve) => (release = resolve));
  // Sends nothing: the probe only needs Claude Code's initialization (T3 does the same).
  // oxlint-disable-next-line require-yield
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await finished;
  }
  type Initializing = ReturnType<QueryFunction> & {
    initializationResult?: () => Promise<{
      account?: {
        email?: string;
        tokenSource?: string;
        apiKeySource?: string;
        apiProvider?: string;
        subscriptionType?: string;
      };
      models?: { value: string; displayName: string; description?: string }[];
    }>;
  };
  let running: Initializing | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    running = query({
      prompt: prompt(),
      options: {
        cwd: Os.tmpdir(),
        ...(config.binaryPath === undefined
          ? {}
          : { pathToClaudeCodeExecutable: config.binaryPath }),
        env: claudeEnvironment(config.env, config.inheritEnv),
      },
    }) as Initializing;
    if (running.initializationResult === undefined) return { status: { available: true } };
    // Closing the query after a timeout rejects initializationResult(); the race already
    // listens to it, so that rejection is handled.
    const init = await Promise.race([
      running.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude Code did not start in time")),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    const account = init.account ?? {};
    // T3's claudeAuthStatus: tokenSource "none" is the one answer that disproves sign-in.
    // An account without fields (an API key or a third-party provider the CLI does not
    // describe) is signed in, as in T3; a wrong guess fails the first turn with Claude's error.
    const signedIn =
      (account.apiProvider !== undefined && account.apiProvider !== "firstParty") ||
      account.tokenSource !== "none" ||
      (account.apiKeySource !== undefined && account.apiKeySource !== "none") ||
      account.email !== undefined ||
      account.subscriptionType !== undefined;
    const models = (init.models ?? [])
      .filter((model) => model.value !== "default")
      .map((model) =>
        withOptions({
          id: model.value,
          name: model.displayName,
          ...(model.description ? { description: model.description } : {}),
        }),
      );
    return {
      status: signedIn
        ? {
            available: true,
            ...(account.email === undefined ? {} : { message: `Signed in as ${account.email}` }),
          }
        : {
            available: false,
            message: "Claude Code is not signed in. Run `claude auth login` and try again.",
          },
      ...(models.length === 0 ? {} : { models }),
    };
  } catch (error) {
    return {
      status: {
        available: false,
        message: `Claude Code could not start: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    clearTimeout(timer);
    release();
    running?.close();
  }
}

/** The Claude Code runtime; `query` is the SDK's unless a test scripts it. */
export function createClaudeRuntime(options: {
  readonly query: QueryFunction;
  readonly sessions: SessionStore;
  readonly config: () => Config;
  /** The last probe, kept so a restarted node answers its first look at once (D344). */
  readonly probes?: ProbeStore;
  /** The node's MCP server, when it runs one (D340). */
  readonly mcp?: McpServer;
  /** Whether a tool of the node's MCP server only reads: every permission it needs does. */
  readonly readOnlyTool?: (tool: string) => boolean;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}): AgentRuntime & {
  readonly live: LiveSessions;
  /** Settles once no turn of the thread started so far is running. */
  settled(threadId: string): Promise<void>;
  dispose(): void;
} {
  const turns = new Map<AgentTurn, { threadId: string; done: Promise<void> }>();
  const live = createLiveSessions({
    query: options.query,
    keepAlive: () => {
      const config = options.config();
      return {
        keepAlive: config.session === "keep-alive",
        idleMs: config.sessionIdleMinutes * 60_000,
        maxSessions: config.maxLiveSessions,
      };
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  /** Context windows Claude Code reported in results, by model. */
  const windows = new Map<string, number>();
  /** The last probe and the config it ran with: another binary or environment probes again. */
  let probed: StoredProbe | undefined;
  /** The stored probe, read once: what a restarted node answers while it probes again. */
  let stored: Promise<StoredProbe | undefined> | undefined;
  const probeKey = () => {
    const { binaryPath, env, inheritEnv } = options.config();
    // Kept in storage.kv (D344): a hash, never the config's environment (it can hold secrets).
    return Crypto.createHash("sha256")
      .update(JSON.stringify({ binaryPath, env, inheritEnv }))
      .digest("hex");
  };
  /** The probe running now, by the config it runs with: a probe is joined only for its config. */
  const probing = new Map<string, Promise<Probe>>();
  const models = () => probed?.probe.models ?? BUNDLED_MODELS;
  const defaultModel = () => {
    const configured = options.config().defaultModel;
    if (configured !== undefined) return configured;
    const all = models();
    return all.some((model) => model.id === BUNDLED_DEFAULT_MODEL)
      ? BUNDLED_DEFAULT_MODEL
      : (all[0]?.id ?? BUNDLED_DEFAULT_MODEL);
  };
  return {
    live,
    agentId: CLAUDE_AGENT_ID,
    name: "Claude Code",
    get models() {
      return models();
    },
    get defaultModel() {
      return defaultModel();
    },
    runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    interactionModes: ["default", "plan"],
    async status() {
      const key = probeKey();
      const refresh = () => {
        let running = probing.get(key);
        if (running === undefined) {
          running = probe(options.query, options.config())
            .then((result) => {
              probed = { at: Date.now(), key, probe: result };
              void options.probes
                ?.save(probed)
                .catch((error: unknown) =>
                  options.log?.("could not keep the claude code probe", { error: String(error) }),
                );
              return result;
            })
            .finally(() => probing.delete(key));
          probing.set(key, running);
        }
        return running;
      };
      if (probed === undefined && options.probes !== undefined) {
        stored ??= options.probes.load().catch(() => undefined);
        const kept = await stored;
        // A probe that ran meanwhile is newer than the kept one.
        if (probed === undefined && kept !== undefined) probed = kept;
      }
      if (probed === undefined || probed.key !== key) return (await refresh()).status;
      // A stale answer is given at once while a new probe runs: picking the default agent
      // (D96) never waits for Claude Code to start. "Unavailable" goes stale sooner, so a
      // sign-in shows on the next look.
      const ttl = probed.probe.status.available ? STATUS_TTL_MS : UNAVAILABLE_TTL_MS;
      if (Date.now() - probed.at >= ttl) void refresh().catch(() => undefined);
      return probed.probe.status;
    },
    startTurn(request) {
      const config = options.config();
      const model = request.model ?? defaultModel();
      const server = config.mcp ? options.mcp : undefined;
      const turn = claudeTurn(request, {
        query: options.query,
        live,
        sessions: options.sessions,
        settings: config,
        defaultModel: model,
        contextWindow: (name) => windows.get(name) ?? manifestContextWindow(name),
        ...(server === undefined
          ? {}
          : {
              mcp: {
                attach: (threadId: string) => mcpAttachment(server, threadId),
                readOnly: options.readOnlyTool ?? (() => false),
              },
            }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      turns.set(turn, { threadId: request.threadId, done: turn.done });
      // Forgotten once its query ended, whether or not anyone read its items.
      void turn.done.then(() => turns.delete(turn));
      const items = turn.items;
      return {
        interrupt: () => turn.interrupt(),
        ...(turn.respond === undefined ? {} : { respond: turn.respond }),
        items: (async function* () {
          for await (const item of items) {
            if (item.kind === "usage" && item.usage.contextWindow !== undefined) {
              windows.set(model, item.usage.contextWindow);
            }
            yield item;
          }
        })(),
      };
    },
    settled: async (threadId) => {
      const running = [...turns.values()].filter((turn) => turn.threadId === threadId);
      await Promise.all(running.map((turn) => turn.done));
    },
    dispose() {
      for (const turn of turns.keys()) turn.interrupt();
      live.dispose();
    },
  };
}

/**
 * Which threads have a Claude session, in `storage.kv`. Writes of one thread run one after
 * another, so `forget` (its thread was deleted) lands after any `set` already on its way,
 * and later `set`s write nothing: a turn still letting go of its session when the thread
 * was deleted would otherwise write the record back. The guard is dropped once `settled`
 * says no turn of the thread is left to write.
 */
export function sessionRecords(kv: KeyValueStore): SessionStore & {
  forget(threadId: string, settled?: Promise<void>): Promise<void>;
} {
  const forgotten = new Set<string>();
  /** The last write of each thread still running; the next waits for it. */
  const writes = new Map<string, Promise<void>>();
  const write = (threadId: string, run: () => Promise<unknown>): Promise<void> => {
    const next = (writes.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(run)
      .then(() => undefined);
    writes.set(threadId, next);
    const settle = () => {
      if (writes.get(threadId) === next) writes.delete(threadId);
    };
    next.then(settle, settle);
    return next;
  };
  const key = (threadId: string) => `session/${threadId}`;
  return {
    has: async (threadId) => (await kv.get(NAMESPACE, key(threadId))) !== undefined,
    set: (threadId) =>
      write(threadId, async () => {
        if (forgotten.has(threadId)) return;
        await kv.set(NAMESPACE, key(threadId), { at: new Date().toISOString() });
      }),
    delete: (threadId) => write(threadId, () => kv.delete(NAMESPACE, key(threadId))),
    forget: (threadId, settled = Promise.resolve()) => {
      forgotten.add(threadId);
      const removed = write(threadId, () => kv.delete(NAMESPACE, key(threadId)));
      void Promise.all([removed, settled]).then(
        () => forgotten.delete(threadId),
        () => forgotten.delete(threadId),
      );
      return removed;
    },
  };
}

/** A kept probe, as `storage.kv` gives it back: anything else is not used. */
const StoredProbe = z.object({
  at: z.number(),
  key: z.string(),
  probe: z.object({
    status: z.object({ available: z.boolean(), message: z.string().optional() }),
    models: z
      .array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }))
      .optional(),
  }),
});

/** The last probe in `storage.kv`, read back only when it has the shape of one (D344). */
export function probeRecords(kv: KeyValueStore): ProbeStore {
  return {
    load: async () => {
      const kept = await kv.get(NAMESPACE, "probe");
      return StoredProbe.safeParse(kept).data as StoredProbe | undefined;
    },
    // Plain data (status, models): JSON as it is.
    save: (kept) => kv.set(NAMESPACE, "probe", kept as unknown as Json),
  };
}

const LiveSession = z.object({
  threadId: z.string(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  busy: z.boolean().describe("A turn runs on it now"),
  idleSince: z.string().optional().describe("When its last turn ended (ISO 8601)"),
  background: z
    .number()
    .int()
    .describe("Background tasks it runs; it is not ended for being idle while they run"),
});

/**
 * The plugin, running Claude Code through `query` (the SDK's in the distribution).
 * Nothing starts Claude Code at activation: a one-shot CLI command boots the same plugins.
 */
export function claudePlugin(query: QueryFunction) {
  return definePlugin({
    activate(context) {
      context.config.define(CONFIG_SECTION, Config);
      const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
      const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
      const registry = context.services.get<AgentRegistry>(AGENT_REGISTRY_CAPABILITY);
      const mcp = context.services.tryGet<McpServer>(MCP_SERVER_CAPABILITY);
      const sessions = sessionRecords(kv);
      const runtime = createClaudeRuntime({
        query,
        sessions,
        probes: probeRecords(kv),
        ...(mcp === undefined ? {} : { mcp }),
        readOnlyTool: (tool) => {
          const command = context.commands
            .list()
            .find((candidate) => candidate.name.replaceAll(".", "_") === tool);
          // A command that names no permission is not known to read only: it asks.
          return (
            command !== undefined &&
            command.permissions.length > 0 &&
            command.permissions.every(readsOnly)
          );
        },
        config: () => context.config.get<Config>(CONFIG_SECTION),
        log: (message, data) => context.log.warn(message, data),
      });
      context.subscriptions.add(registry.register(runtime));
      context.onDeactivate(() => runtime.dispose());
      // Held sessions end with their turn or wait for their next one as the setting says then.
      context.subscriptions.add(
        context.config.onDidChange(CONFIG_SECTION, () => {
          // Turned to per-turn: kept sessions end now. Another idle time: theirs runs from
          // their last turn with the new length.
          if (context.config.get<Config>(CONFIG_SECTION).session === "per-turn") {
            runtime.live.closeIdle();
          } else {
            runtime.live.rearmIdle();
          }
        }),
      );

      // A deleted or archived thread takes no more turns: its Claude Code exits. A deleted
      // thread's session record goes too (Claude Code's own session file stays).
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          const payload = event.payload as { id?: unknown; archivedAt?: unknown } | null;
          if (typeof payload?.id !== "string") return;
          if (event.type === ThreadEvents.threadDeleted) {
            const threadId = payload.id;
            runtime.live.close(threadId, true);
            const settled = runtime.settled(threadId);
            void sessions.forget(threadId, settled).catch((error: unknown) =>
              context.log.warn("could not forget the claude session", {
                threadId,
                error: String(error),
              }),
            );
            // Its files too, once no turn of it is left to write them (D345).
            const { env, inheritEnv } = context.config.get<Config>(CONFIG_SECTION);
            const configDir = claudeConfigDir(env, inheritEnv);
            // Claude Code writes its last lines to the file while it shuts down.
            void Promise.all([settled, runtime.live.ended(threadId)])
              .then(() => deleteSessionFiles(threadId, configDir))
              .then(
                (removed) =>
                  context.events.emit("claude.session.files.deleted", { threadId, removed }),
                (error: unknown) =>
                  context.log.warn("could not delete the claude session files", {
                    threadId,
                    error: String(error),
                  }),
              );
          } else if (
            event.type === ThreadEvents.threadUpdated &&
            typeof payload.archivedAt === "string"
          ) {
            runtime.live.close(payload.id, true);
          }
        }),
      );

      context.commands.register({
        name: "claude.sessions.list",
        description:
          "Threads whose Claude Code keeps running between turns (the `session` setting keep-alive)",
        input: z.object({}),
        output: z.array(LiveSession),
        permissions: ["threads.read"],
        handler: () => runtime.live.list(),
      });
      context.commands.register({
        name: "claude.sessions.close",
        description:
          "Ends the running Claude Code of a thread, or of every thread, that no turn runs on and that runs no background work (one with work ends once it is done); `force` ends those too (a running turn fails, background work stops). The thread's next turn resumes its session",
        input: z.object({
          threadId: z.string().optional(),
          force: z
            .boolean()
            .default(false)
            .describe(
              "Also end a Claude Code a turn or background work runs on; the turn fails, the work stops",
            ),
        }),
        output: z.object({ closed: z.number().int() }),
        permissions: ["threads.write"],
        handler: ({ threadId, force }) => {
          if (threadId !== undefined) {
            return { closed: runtime.live.close(threadId, force) ? 1 : 0 };
          }
          if (!force) return { closed: runtime.live.closeIdle() };
          const closed = runtime.live.list().length;
          runtime.live.dispose();
          return { closed };
        },
      });
    },
  });
}

export default claudePlugin(sdkQuery as unknown as QueryFunction);
