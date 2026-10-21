import * as Fs from "node:fs/promises";
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

import {
  OpenCodeError,
  realClock,
  type Clock,
  type ModelInfo,
  type OpenCodeClient,
} from "./client.ts";
import {
  createServerOwner,
  isSupportedVersion,
  probeVersion,
  unsupportedVersion,
  type Connection,
  type ServerOwner,
} from "./server.ts";
import {
  OPENCODE_AGENT_ID,
  attachmentsOf,
  openCodeTurn,
  type SessionRecord,
  type SessionStore,
} from "./turn.ts";

export { OpenCodeError, createClient, type StreamEvent } from "./client.ts";
export { createServerOwner, parseVersion, serverEnvironment } from "./server.ts";
export {
  OPENCODE_AGENT_ID,
  SESSION_GONE,
  STILL_STOPPING,
  STREAM_LOST,
  openCodeTurn,
} from "./turn.ts";
export * from "./mapping.ts";

export const CONFIG_SECTION = "jhin.agent-opencode";
const NAMESPACE = "jhin.agent-opencode";

/** How long a status probe is reused (as Claude's, D95). */
const STATUS_TTL_MS = 5 * 60_000;
const UNAVAILABLE_TTL_MS = 10_000;
/** A fresh server lists no models for its first moments (T3's model loader). */
const MODELS_WAIT_MS = 5_000;
const MODELS_RETRY_MS = 250;

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
export const Config = z
  .object({
    enabled: z.boolean().default(false).meta({
      title: "Enabled",
      description: "Run turns with OpenCode on this node; nothing starts OpenCode until this is on",
    }),
    binaryPath: z.string().default("opencode").meta({
      title: "Binary path",
      description: "Path to the OpenCode binary",
      advanced: true,
    }),
    serverUrl: z.string().optional().meta({
      title: "Server URL",
      description:
        "An OpenCode 2 server to use, e.g. http://127.0.0.1:4096; leave blank to let Jhin start one when needed",
      advanced: true,
    }),
    serverPassword: z.string().optional().meta({
      title: "Server password",
      description: "Password of the server at Server URL",
      writeOnly: true,
      advanced: true,
    }),
    defaultModel: z.string().optional().meta({
      title: "Default model",
      description:
        "Model of turns that name none, as provider/model; OpenCode's own default when unset",
    }),
    serverIdleMinutes: z.number().int().nonnegative().default(10).meta({
      title: "Idle minutes",
      description:
        "Minutes the OpenCode server Jhin started keeps running without a turn before it exits; 0 keeps it until the node stops",
      advanced: true,
    }),
  })
  .meta({ title: "OpenCode", description: "The OpenCode agent runtime of this node." });
export type Config = z.output<typeof Config>;

interface Probe {
  readonly status: AgentRuntimeStatus;
  readonly models?: readonly AgentModel[];
  readonly defaultModel?: string;
}

const slug = (model: ModelInfo) => `${model.providerID}/${model.id}`;
const windowOf = (model: ModelInfo) => model.limit?.input ?? model.limit?.context;

/** The models of a directory, waiting a little for a fresh server to list any. */
async function loadModels(
  client: OpenCodeClient,
  directory: string,
  clock: Clock,
): Promise<ModelInfo[]> {
  for (let waited = 0; ; waited += MODELS_RETRY_MS) {
    const models = await client.models(directory);
    if (models.length > 0 || waited >= MODELS_WAIT_MS) return models;
    await new Promise<void>((resolve) => clock.after(MODELS_RETRY_MS, resolve));
  }
}

/** The OpenCode runtime over the node's OpenCode server. */
export function createOpenCodeRuntime(options: {
  readonly server: ServerOwner;
  readonly sessions: SessionStore;
  readonly config: () => Config;
  readonly env?: () => NodeJS.ProcessEnv;
  readonly attachmentsDir?: string;
  /** Waits for a fresh server's model list; tests pass one they fire themselves. */
  readonly clock?: Clock;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}): AgentRuntime & {
  settled(threadId: string): Promise<void>;
  forget(threadId: string): Promise<void>;
  dispose(): void;
} {
  const env = options.env ?? (() => process.env);
  const turns = new Map<AgentTurn, { threadId: string; done: Promise<void> }>();
  const windows = new Map<string, number>();
  let probed: { at: number; key: string; probe: Probe } | undefined;
  const probing = new Map<string, Promise<Probe>>();
  const probeKey = () => {
    const { enabled, binaryPath, serverUrl, serverPassword } = options.config();
    return JSON.stringify({ enabled, binaryPath, serverUrl, serverPassword });
  };

  const remember = (models: readonly ModelInfo[]) => {
    for (const model of models) {
      const window = windowOf(model);
      if (window !== undefined) windows.set(slug(model), window);
    }
  };

  const probe = async (): Promise<Probe> => {
    const config = options.config();
    if (!config.enabled) {
      return { status: { available: false, message: "OpenCode is disabled in Jhin settings." } };
    }
    try {
      const external = (config.serverUrl?.trim() ?? "").length > 0;
      if (!external) {
        const version = await probeVersion(config.binaryPath, env());
        if (!isSupportedVersion(version)) {
          return { status: { available: false, message: unsupportedVersion(version), version } };
        }
      }
      return await options.server.use(async ({ client, version }) => {
        // A configured server is checked here: only a binary has a version to probe first.
        if (!isSupportedVersion(version)) {
          return { status: { available: false, message: unsupportedVersion(version), version } };
        }
        const directory = Os.homedir();
        const models = await loadModels(client, directory, options.clock ?? realClock);
        remember(models);
        const own = await client.defaultModel(directory).catch(() => null);
        const listed = models
          .filter((model) => (model.name ?? "").trim().length > 0)
          .map((model) => ({
            id: slug(model),
            name: model.name!.trim(),
            description: model.providerID,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name));
        if (listed.length === 0) {
          return {
            status: {
              available: false,
              version,
              message: "OpenCode 2 is running, but it did not list any models yet.",
            },
          };
        }
        return {
          status: {
            available: true,
            version,
            message: `OpenCode ${version} lists ${listed.length} model${listed.length === 1 ? "" : "s"}.`,
          },
          models: listed,
          ...(own === null ? {} : { defaultModel: slug(own) }),
        };
      }, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: { available: false, message } };
    }
  };

  const models = () => probed?.probe.models ?? [];
  const configuredDefault = () =>
    // A field cleared on the settings page may be saved as "": unset.
    (options.config().defaultModel?.trim() || undefined) ??
    probed?.probe.defaultModel ??
    models()[0]?.id;

  const runtime: AgentRuntime & {
    settled(threadId: string): Promise<void>;
    /** Removes a deleted thread's attached images. */
    forget(threadId: string): Promise<void>;
    dispose(): void;
  } = {
    agentId: OPENCODE_AGENT_ID,
    name: "OpenCode",
    get models() {
      return models();
    },
    runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    interactionModes: ["default", "plan"],
    async status() {
      const key = probeKey();
      const refresh = () => {
        let running = probing.get(key);
        if (running === undefined) {
          running = probe()
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
      const ttl = probed.probe.status.available ? STATUS_TTL_MS : UNAVAILABLE_TTL_MS;
      if (Date.now() - probed.at >= ttl) void refresh().catch(() => undefined);
      return probed.probe.status;
    },
    startTurn(request) {
      if (!options.config().enabled) {
        return {
          interrupt: () => undefined,
          // Fails before its first item: nothing to yield.
          // oxlint-disable-next-line require-yield
          items: (async function* () {
            throw new Error("OpenCode is disabled in Jhin settings.");
          })(),
        };
      }
      const turn = openCodeTurn(request, {
        server: options.server,
        sessions: options.sessions,
        defaultModel: async (connection: Connection, directory: string) => {
          const configured = configuredDefault();
          if (configured !== undefined) return configured;
          const own = await connection.client.defaultModel(directory).catch(() => null);
          if (own !== null) return slug(own);
          const listed = await connection.client.models(directory);
          remember(listed);
          const first = listed[0];
          if (first === undefined) throw new OpenCodeError("OpenCode did not list any models.");
          return slug(first);
        },
        contextWindow: async (connection, directory, model) => {
          const known = windows.get(model);
          if (known !== undefined) return known;
          remember(await connection.client.models(directory));
          return windows.get(model);
        },
        ...(options.attachmentsDir === undefined ? {} : { attachmentsDir: options.attachmentsDir }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      turns.set(turn, { threadId: request.threadId, done: turn.done });
      void turn.done.then(() => turns.delete(turn));
      return turn;
    },
    forget: (threadId) =>
      Fs.rm(attachmentsOf(threadId, options.attachmentsDir), { recursive: true, force: true }),
    settled: async (threadId) => {
      const running = [...turns.values()].filter((turn) => turn.threadId === threadId);
      await Promise.all(running.map((turn) => turn.done));
    },
    dispose() {
      for (const turn of turns.keys()) turn.interrupt();
      options.server.dispose();
    },
  };
  // Absent until the config or a probe names one (D335): a getter, since a plain property
  // could not be left out once known.
  Object.defineProperty(runtime, "defaultModel", { get: configuredDefault, enumerable: true });
  return runtime;
}

/** Which OpenCode session each thread has, in `storage.kv`. */
export function sessionRecords(kv: KeyValueStore): SessionStore {
  const key = (threadId: string) => `session/${threadId}`;
  return {
    get: async (threadId) => {
      const value = (await kv.get(NAMESPACE, key(threadId))) as
        | (SessionRecord & { id?: unknown })
        | undefined;
      return typeof value?.id === "string" ? value : undefined;
    },
    set: async (threadId, record) => {
      await kv.set(NAMESPACE, key(threadId), {
        id: record.id,
        ...(record.unsettled === true ? { unsettled: true } : {}),
        ...(record.fresh === true ? { fresh: true } : {}),
        ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        ...(record.grants === undefined
          ? {}
          : { grants: record.grants.map((grant) => ({ ...grant })) }),
        at: new Date().toISOString(),
      });
    },
    delete: async (threadId) => {
      await kv.delete(NAMESPACE, key(threadId));
    },
  };
}

/** The plugin. Nothing starts OpenCode at activation, nor until the runtime is enabled. */
export function openCodePlugin(options: { readonly env?: () => NodeJS.ProcessEnv } = {}) {
  return definePlugin({
    activate(context) {
      context.config.define(CONFIG_SECTION, Config);
      const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
      const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
      const registry = context.services.get<AgentRegistry>(AGENT_REGISTRY_CAPABILITY);
      const config = () => context.config.get<Config>(CONFIG_SECTION);
      const env = options.env ?? (() => process.env);
      const warn = (message: string, data?: Record<string, unknown>) =>
        context.log.warn(message, data);
      const server = createServerOwner({
        settings: () => {
          const { binaryPath, serverUrl, serverPassword } = config();
          return { binaryPath, serverUrl, serverPassword };
        },
        env,
        idleMs: () => config().serverIdleMinutes * 60_000,
        log: warn,
      });
      const sessions = sessionRecords(kv);
      const runtime = createOpenCodeRuntime({ server, sessions, config, env, log: warn });
      context.subscriptions.add(registry.register(runtime));
      context.onDeactivate(() => runtime.dispose());
      // Turned off: the server Jhin started exits now (one a turn still uses ends after it).
      context.subscriptions.add(
        context.config.onDidChange(CONFIG_SECTION, () => {
          if (!config().enabled) server.close();
          // A new idle time counts for a server waiting idle now, too.
          else server.rearm();
        }),
      );
      // A deleted thread's record goes; its OpenCode session stays in OpenCode's database.
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          const payload = event.payload as { id?: unknown } | null;
          if (event.type !== ThreadEvents.threadDeleted || typeof payload?.id !== "string") return;
          const threadId = payload.id;
          void runtime
            .settled(threadId)
            .then(() => sessions.delete(threadId))
            .then(() => runtime.forget(threadId))
            .catch((error: unknown) =>
              context.log.warn("could not forget the opencode session", {
                threadId,
                error: String(error),
              }),
            );
        }),
      );
    },
  });
}

export default openCodePlugin();
