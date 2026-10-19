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
import { definePlugin, z } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type KeyValueStore,
} from "@jhin/storage-api";
import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { BUNDLED_DEFAULT_MODEL, BUNDLED_MODELS, manifestContextWindow } from "./models.ts";
import { createLiveSessions, type LiveSessions, type QueryFunction } from "./session.ts";
import { CLAUDE_AGENT_ID, claudeEnvironment, claudeTurn, type SessionStore } from "./turn.ts";

export {
  CLAUDE_AGENT_ID,
  claudeTurn,
  permissionMode,
  transcript,
  type QueryFunction,
} from "./turn.ts";
export { createLiveSessions, type LiveSessionInfo, type LiveSessions } from "./session.ts";
export * from "./mapping.ts";

export const CONFIG_SECTION = "jhin.agent-claude";
const NAMESPACE = "jhin.agent-claude";

/** How long a status probe (it starts Claude Code) is reused. */
const STATUS_TTL_MS = 5 * 60_000;
/** How long a probe that found Claude Code unavailable is reused: a sign-in shows soon. */
const UNAVAILABLE_TTL_MS = 10_000;
/** A probe that takes longer reports Claude Code as unavailable. */
const PROBE_TIMEOUT_MS = 25_000;

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
    sessionIdleMinutes: z.number().int().nonnegative().default(10).meta({
      title: "Idle minutes",
      description:
        "Minutes a kept Claude Code waits for the thread's next turn before it exits; 0 keeps it until the thread is archived or deleted or the node stops",
    }),
  })
  .meta({ title: "Claude Code", description: "The Claude Code agent runtime of this node." });
/** The section as written: unset fields take the defaults above. */
export type Config = z.input<typeof Config>;

/** What a status probe learnt: whether Claude Code runs and is signed in, and its models. */
interface Probe {
  readonly status: AgentRuntimeStatus;
  readonly models?: readonly AgentModel[];
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
        ...(config.env === undefined ? {} : { env: claudeEnvironment(config.env) }),
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
      .map((model) => ({
        id: model.value,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
      }));
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
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}): AgentRuntime & { readonly live: LiveSessions; dispose(): void } {
  const turns = new Set<AgentTurn>();
  const live = createLiveSessions({
    query: options.query,
    keepAlive: () => {
      const config = options.config();
      return {
        keepAlive: (config.session ?? "keep-alive") === "keep-alive",
        idleMs: (config.sessionIdleMinutes ?? 10) * 60_000,
      };
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  /** Context windows Claude Code reported in results, by model. */
  const windows = new Map<string, number>();
  /** The last probe and the config it ran with: another binary or environment probes again. */
  let probed: { at: number; key: string; probe: Probe } | undefined;
  const probeKey = () => {
    const { binaryPath, env } = options.config();
    return JSON.stringify({ binaryPath, env });
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
              return result;
            })
            .finally(() => probing.delete(key));
          probing.set(key, running);
        }
        return running;
      };
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
      const turn = claudeTurn(request, {
        query: options.query,
        live,
        sessions: options.sessions,
        settings: config,
        defaultModel: model,
        contextWindow: (name) => windows.get(name) ?? manifestContextWindow(name),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      turns.add(turn);
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
    dispose() {
      for (const turn of turns) turn.interrupt();
      live.dispose();
    },
  };
}

const LiveSession = z.object({
  threadId: z.string(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  busy: z.boolean().describe("A turn runs on it now"),
  idleSince: z.string().optional().describe("When its last turn ended (ISO 8601)"),
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
      const sessions: SessionStore = {
        has: async (threadId) => (await kv.get(NAMESPACE, `session/${threadId}`)) !== undefined,
        set: (threadId) =>
          kv.set(NAMESPACE, `session/${threadId}`, { at: new Date().toISOString() }),
        delete: async (threadId) => {
          await kv.delete(NAMESPACE, `session/${threadId}`);
        },
      };
      const runtime = createClaudeRuntime({
        query,
        sessions,
        config: () => context.config.get<Config>(CONFIG_SECTION),
        log: (message, data) => context.log.warn(message, data),
      });
      context.subscriptions.add(registry.register(runtime));
      context.onDeactivate(() => runtime.dispose());

      // A deleted or archived thread takes no more turns: its Claude Code exits. A deleted
      // thread's session record goes too (Claude Code's own session file stays).
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          const payload = event.payload as { id?: unknown; archivedAt?: unknown } | null;
          if (typeof payload?.id !== "string") return;
          if (event.type === ThreadEvents.threadDeleted) {
            runtime.live.close(payload.id);
            void sessions.delete(payload.id).catch((error: unknown) =>
              context.log.warn("could not forget the claude session", {
                threadId: payload.id,
                error: String(error),
              }),
            );
          } else if (
            event.type === ThreadEvents.threadUpdated &&
            payload.archivedAt !== undefined
          ) {
            runtime.live.close(payload.id);
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
          "Ends a thread's running Claude Code, or every one: a turn running on it fails, the thread's next turn resumes its session",
        input: z.object({ threadId: z.string().optional() }),
        output: z.object({ closed: z.number().int() }),
        permissions: ["threads.write"],
        handler: ({ threadId }) => {
          if (threadId !== undefined) return { closed: runtime.live.close(threadId) ? 1 : 0 };
          const closed = runtime.live.list().length;
          runtime.live.dispose();
          return { closed };
        },
      });
    },
  });
}

export default claudePlugin(sdkQuery as unknown as QueryFunction);
