// The Codex agent runtime (D310–D324). Its status probe is derived from T3 Code
// (https://github.com/pingdotgg/t3code), apps/server/src/provider/CodexProvider.ts at
// eb7b35ac (probeCodexAppServerProvider, checkCodexProviderStatus): the account, the model
// catalog and T3's messages for a Codex that does not start, is signed out or hangs.
import * as Os from "node:os";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
  THREADS_STREAM,
  ThreadEvents,
  type AgentAuth,
  type AgentModel,
  type AgentRegistry,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSkill,
  type AgentTurn,
  type AgentUsageLimits,
} from "@jhin/agent-api";
import {
  AGENT_PERMISSIONS,
  MCP_SERVER_CAPABILITY,
  MCP_SERVER_NAME,
  type McpServer,
} from "@jhin/mcp-api";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type KeyValueStore,
} from "@jhin/storage-api";

import {
  BUNDLED_MODELS,
  COMPACT_COMMAND,
  accountStatus,
  listedModels,
  listedSkills,
  withCustomModels,
  preferredDefault,
  type Account,
  type ListedModel,
} from "./mapping.ts";
import {
  CodexSpawnError,
  codexEnvironment,
  codexVersion,
  initialize,
  launchAppServer,
  type AppServerConnection,
} from "./rpc.ts";
import { GOAL_COMMAND } from "./goal.ts";
import { materializeShadowHome } from "./accounts.ts";
import { createSessions, type Launcher, type Sessions } from "./session.ts";
import {
  CODEX_AGENT_ID,
  codexTurn,
  type CodexThreadRecord,
  type RecordedTurn,
  type ThreadStore,
} from "./turn.ts";
import {
  RATE_LIMITS_FAILURE,
  codexRateLimitsToLimits,
  codexRateLimitsToWindows,
  codexUsageLimitResetAt,
  mergeCodexRateLimits,
  readRateLimitSnapshot,
  type CodexRateLimitSnapshot,
  type CodexRateLimitsRead,
} from "./usage-limits.ts";

export {
  CODEX_AGENT_ID,
  codexTurn,
  type CodexThreadRecord,
  type RecordedTurn,
  type ThreadStore,
} from "./turn.ts";
export { SessionTakenOver, createSessions, type Launcher, type Sessions } from "./session.ts";
export { launchAppServer, type AppServerConnection, type LaunchOptions } from "./rpc.ts";
export * from "./mapping.ts";
export * from "./usage-limits.ts";

export const CONFIG_SECTION = "jhin.agent-codex";
const NAMESPACE = "jhin.agent-codex";
/** Sent to Codex as the client's version in `initialize`. */
const VERSION = "0.1.0";

/** How long a status probe (it starts Codex) is reused. */
const STATUS_TTL_MS = 5 * 60_000;
/** How long a probe that found Codex unavailable is reused: a sign-in shows soon. */
const UNAVAILABLE_TTL_MS = 10_000;
/** How long a turn that names no model waits for a first probe before it takes the bundled default. */
const MODEL_WAIT_MS = 3_000;
/** A probe that takes longer reports Codex as unavailable (T3's CODEX_AUTH_PROBE_TIMEOUT_MS). */
const PROBE_TIMEOUT_MS = 20_000;
/** Sign-ins kept to answer a late `wait`. */
const MAX_LOGINS = 20;
/** How old a usage read `/usage-limits` answers from before it reads them again. */
const USAGE_TTL_MS = 60_000;
/** A usage read that takes longer is reported as failed (T3's RATE_LIMITS_PROBE_TIMEOUT_MS). */
const RATE_LIMITS_TIMEOUT_MS = 5_000;

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
export const Config = z
  .object({
    binaryPath: z.string().min(1).default("codex").meta({
      title: "Codex executable",
      description: "Path to the `codex` executable, or its name on the node's PATH",
      advanced: true,
    }),
    homePath: z.string().optional().meta({
      title: "CODEX_HOME path",
      description: "Codex's home (its login, sessions and config); Codex's own default when unset",
      advanced: true,
    }),
    args: z.array(z.string()).optional().meta({
      title: "Launch arguments",
      description: "Extra arguments after `codex app-server`, e.g. `-c` config overrides",
      advanced: true,
    }),
    customModels: z
      .array(
        z.union([
          z.string().trim().min(1),
          z.object({ slug: z.string().trim().min(1), name: z.string().trim().min(1).optional() }),
        ]),
      )
      .default([])
      .meta({
        title: "Custom models",
        description:
          "Model slugs Codex takes that it does not list, e.g. a newer model; an entry with a name also renames a listed model",
      }),
    defaultModel: z
      .string()
      .optional()
      .meta({ title: "Default model", description: "Model of turns that name none" }),
    effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
      .optional()
      .meta({ title: "Reasoning effort", description: "Codex's default for the model when unset" }),
    env: z.record(z.string(), z.string()).optional().meta({
      title: "Environment",
      description:
        "Environment variables for Codex. Config is readable by anyone holding the node's token: keep secrets such as OPENAI_API_KEY in the node's own environment",
      // The settings page hides the values (D83); host.config.get still returns them.
      writeOnly: true,
      advanced: true,
    }),
    inheritEnv: z.array(z.string()).default(["*"]).meta({
      title: "Inherited environment",
      description:
        "The node's environment variables Codex gets: names, or prefixes ending in * (e.g. LC_*). * passes all of them; a narrower list keeps variables meant for the node away from Codex and the commands it runs",
      advanced: true,
    }),
    mcp: z.boolean().default(true).meta({
      title: "Jhin tools",
      description:
        "Give Codex this node's MCP server, so it can work with Jhin's threads and projects when asked",
    }),
    // T3's several Codex provider instances with shadow homes (D1319).
    accounts: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits and dashes")
            .meta({
              title: "Id",
              description: "Part of the account's agent id: jhin.agent-codex:<id>",
            }),
          name: z
            .string()
            .trim()
            .min(1)
            .meta({ title: "Name", description: "Shown in the agent picker" }),
          homePath: z.string().trim().min(1).meta({
            title: "Shadow home",
            description:
              "The account's own CODEX_HOME: its sign-in stays here, everything else is linked from the main home",
          }),
        }),
      )
      .default([])
      .meta({
        title: "More accounts",
        description:
          "Other Codex accounts on this node, each an agent of its own that shares the main home's threads, skills and config but signs in apart",
      }),
    sessionIdleMinutes: z.number().int().nonnegative().default(10).meta({
      title: "Idle minutes",
      description:
        "Minutes a thread's Codex keeps running after a turn, waiting for the next; 0 keeps it until the thread is archived or deleted or the node stops",
    }),
  })
  .meta({ title: "Codex", description: "The Codex agent runtime of this node." });
export type Config = z.output<typeof Config>;

/** `~` and `~/…` expanded, as T3 does for CODEX_HOME (spawn does not expand it). */
export function expandHome(path: string | undefined): string | undefined {
  if (path === undefined || path.trim().length === 0) return undefined;
  if (path === "~") return Os.homedir();
  if (path.startsWith("~/")) return Path.join(Os.homedir(), path.slice(2));
  return path;
}

/** What a status probe learnt: whether Codex runs and is signed in, and its models. */
interface Probe {
  readonly status: AgentRuntimeStatus;
  readonly models?: readonly AgentModel[];
  readonly defaultModel?: string;
  /** The account's usage limits (D1142), when it has any to read. */
  readonly usageLimits?: AgentUsageLimits;
  /** The snapshot they were read from, which `account/rateLimits/updated` merges onto. */
  readonly rateLimits?: CodexRateLimitSnapshot;
}

/**
 * The account's usage limits (T3's probe): none to read for an API key, a failure kept as
 * `probeFailed` so the client tells it apart.
 */
async function readUsageLimits(
  connection: AppServerConnection,
  account: Account,
): Promise<Pick<Probe, "usageLimits" | "rateLimits">> {
  const checkedAt = new Date().toISOString();
  if (account.account?.type === "apiKey") {
    return { usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } } };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (await Promise.race([
      connection.request("account/rateLimits/read", null),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(RATE_LIMITS_FAILURE)), RATE_LIMITS_TIMEOUT_MS);
      }),
    ])) as CodexRateLimitsRead | null;
    const snapshot = readRateLimitSnapshot(read?.rateLimits) ?? {};
    const byLimitId: Record<string, CodexRateLimitSnapshot> = {};
    for (const [id, value] of Object.entries(read?.rateLimitsByLimitId ?? {})) {
      const parsed = readRateLimitSnapshot(value);
      if (parsed !== undefined) byLimitId[id] = parsed;
    }
    return {
      usageLimits: codexRateLimitsToLimits({
        snapshot,
        rateLimitsByLimitId: byLimitId,
        resetCredits: read?.rateLimitResetCredits,
        checkedAt,
      }),
      rateLimits: byLimitId["codex"] ?? snapshot,
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message:
            typeof code === "number"
              ? `Codex could not read usage (JSON-RPC ${code}).`
              : RATE_LIMITS_FAILURE,
        },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Starts `codex app-server` and reads its account and models (T3's provider probe). */
export async function probe(launch: Launcher, config: Config): Promise<Probe> {
  let connection: AppServerConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked = async (): Promise<Probe> => {
    connection = launch({
      binaryPath: config.binaryPath,
      args: config.args ?? [],
      cwd: Os.tmpdir(),
      env: codexEnvironment(config.env, expandHome(config.homePath), config.inheritEnv),
    });
    const running = connection;
    const init = await initialize(running, VERSION);
    const version = codexVersion(init.userAgent);
    const account = ((await running.request("account/read", {})) ?? {}) as Account;
    // Whether an account is signed in, for "Sign in" and "Sign out" (D1151).
    const status = {
      ...accountStatus(account),
      signedIn: account.account !== undefined && account.account !== null,
    };
    if (!status.available) {
      return { status: { ...status, ...(version === undefined ? {} : { version }) } };
    }
    // Read beside the models, as T3's probe does (`Effect.all`): the probe takes the longer of
    // the two, and a read that hangs is given up after RATE_LIMITS_TIMEOUT_MS.
    const usageRead = readUsageLimits(running, account);
    const listed: ListedModel[] = [];
    let cursor: string | undefined;
    do {
      const page = (await running.request(
        "model/list",
        cursor === undefined ? {} : { cursor },
      )) as {
        data?: ListedModel[];
        nextCursor?: string | null;
      } | null;
      listed.push(...(page?.data ?? []).filter((model) => typeof model?.model === "string"));
      cursor = page?.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const preferred = preferredDefault(listed);
    const usage = await usageRead;
    return {
      ...usage,
      status: { ...status, ...(version === undefined ? {} : { version }) },
      ...(listed.length === 0 ? {} : { models: listedModels(listed) }),
      ...(preferred === undefined ? {} : { defaultModel: preferred }),
    };
  };
  try {
    return await Promise.race([
      asked(),
      new Promise<Probe>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: {
                available: false,
                message: "Timed out while checking Codex app-server provider status.",
              },
            }),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof CodexSpawnError) {
      return {
        status: {
          available: false,
          message:
            `Could not start Codex CLI (\`${config.binaryPath}\`). Check the Codex executable in the node's settings.` +
            (config.binaryPath === "codex"
              ? " Installing ChatGPT or Codex desktop may not add codex to PATH."
              : " Make sure the configured executable exists and can be run."),
        },
      };
    }
    return {
      status: {
        available: false,
        message: `Codex app-server provider probe failed: ${error instanceof Error ? error.message : String(error)}.`,
      },
    };
  } finally {
    clearTimeout(timer);
    connection?.close();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A permission that only reads: `threads.read`, `projects.browse`. */
const readsOnly = (permission: string) =>
  permission.endsWith(".read") || permission === "projects.browse";

/**
 * Codex aborts an MCP call after its own default; a tool that waits (a thread's turn, W10's
 * tasks) may take up to an hour, so T3's budget (`CODEX_T3_MCP_TOOL_TIMEOUT_SEC`).
 */
const MCP_TOOL_TIMEOUT_SEC = 65 * 60;

/**
 * The node's MCP server for one app-server (T3's `codexThreadRuntimeParams`, D889): a
 * credential of its own, sent in the thread's config, so it is in neither Codex's argv nor
 * the environment of the commands it runs.
 */
export function mcpAttachment(
  server: McpServer,
  threadId: string,
  writes: boolean,
): { readonly servers: Record<string, unknown>; dispose(): void } {
  const credential = server.issue({
    id: `${CODEX_AGENT_ID}:${threadId}`,
    // Codex calls MCP tools without Jhin's approval: only a thread with full access writes.
    permissions: writes ? AGENT_PERMISSIONS : AGENT_PERMISSIONS.filter(readsOnly),
    threadId,
  });
  return {
    servers: {
      [MCP_SERVER_NAME]: {
        url: credential.url,
        tool_timeout_sec: MCP_TOOL_TIMEOUT_SEC,
        http_headers: { ...credential.headers },
      },
    },
    dispose: () => credential.dispose(),
  };
}

/** Starts `codex app-server` in `cwd` and lists its skills (T3's probeCodexSkillsForCwd). */
export async function probeSkills(
  launch: Launcher,
  config: Config,
  cwd: string,
): Promise<AgentSkill[]> {
  const connection = launch({
    binaryPath: config.binaryPath,
    args: config.args ?? [],
    cwd,
    env: codexEnvironment(config.env, expandHome(config.homePath), config.inheritEnv),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await initialize(connection, VERSION);
        return listedSkills(await connection.request("skills/list", { cwds: [cwd] }), cwd);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codex did not list its skills.")),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}

/** The Codex runtime; `launch` starts the real `codex app-server` unless a test replaces it. */
export function createCodexRuntime(options: {
  readonly threads: ThreadStore;
  readonly config: () => Config;
  /** Another account's runtime (D1319): its own id and name; Codex's when absent. */
  readonly agentId?: string;
  readonly name?: string;
  readonly launch?: Launcher;
  /** The node's MCP server, given to each app-server unless the config's `mcp` is off (D889). */
  readonly mcp?: McpServer;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}): AgentRuntime & {
  readonly sessions: Sessions;
  /** Settles once no turn of the thread started so far is running. */
  settled(threadId: string): Promise<void>;
  dispose(): void;
} {
  const launch = options.launch ?? launchAppServer;
  const turns = new Map<AgentTurn, { threadId: string; done: Promise<void> }>();
  /**
   * What `account/rateLimits/updated` said since the last probe, merged onto the probe's
   * snapshot (T3's mergeCodexRateLimits): Codex sends a part of the snapshot at a time.
   */
  let liveRateLimits: { at: string; key: string; snapshot: CodexRateLimitSnapshot } | undefined;
  /** The updates, while the config is the one Codex ran with: another home is another account. */
  const live = () => {
    if (liveRateLimits !== undefined && liveRateLimits.key !== probeKey()) {
      liveRateLimits = undefined;
    }
    return liveRateLimits;
  };
  const sessions = createSessions({
    launch,
    idleMs: () => options.config().sessionIdleMinutes * 60_000,
    ...(options.log === undefined ? {} : { log: options.log }),
    notified: (method, params) => {
      if (method !== "account/rateLimits/updated") return;
      const update = readRateLimitSnapshot((params as { rateLimits?: unknown } | null)?.rateLimits);
      if (update === undefined) return;
      const merged = mergeCodexRateLimits(live()?.snapshot ?? current()?.rateLimits, update);
      if (merged !== undefined) {
        liveRateLimits = { at: new Date().toISOString(), key: probeKey(), snapshot: merged };
      }
    },
  });
  /** The last probe and the config it ran with: another binary or environment probes again. */
  let probed: { at: number; key: string; probe: Probe } | undefined;
  const probing = new Map<string, Promise<Probe>>();
  const probeKey = () => {
    const { binaryPath, homePath, args, env, inheritEnv } = options.config();
    return JSON.stringify({ binaryPath, homePath, args, env, inheritEnv });
  };
  /** The last probe, if it ran with the config as it is now: another Codex lists other models. */
  const current = () => (probed?.key === probeKey() ? probed.probe : undefined);
  /** The skills of each folder Codex was asked about, by config and folder. */
  const skillProbes = new Map<string, { at: number; skills: Promise<AgentSkill[]> }>();
  /** The last list with the config's custom models, kept while neither changed. */
  let withCustom:
    | { listed: readonly AgentModel[]; custom: string; models: readonly AgentModel[] }
    | undefined;
  const models = () => {
    const listed = current()?.models ?? BUNDLED_MODELS;
    const custom = JSON.stringify(options.config().customModels);
    if (withCustom?.listed !== listed || withCustom.custom !== custom) {
      withCustom = {
        listed,
        custom,
        models: withCustomModels(listed, options.config().customModels),
      };
    }
    return withCustom.models;
  };
  const defaultModel = () =>
    options.config().defaultModel ??
    current()?.defaultModel ??
    models()[0]?.id ??
    BUNDLED_MODELS[0]!.id;
  /** Probes Codex again (once at a time per config): its status, models and usage. */
  const refresh = (key: string) => {
    let running = probing.get(key);
    if (running === undefined) {
      running = probe(launch, options.config())
        .then((result) => {
          probed = { at: Date.now(), key, probe: result };
          // A new read holds what the updates before it said; one that came while it was
          // read (it merged onto the older snapshot) is newer and stays.
          const readAt = result.usageLimits?.checkedAt;
          if (
            result.rateLimits !== undefined &&
            readAt !== undefined &&
            liveRateLimits !== undefined &&
            Date.parse(liveRateLimits.at) <= Date.parse(readAt)
          ) {
            liveRateLimits = undefined;
          }
          return result;
        })
        .finally(() => probing.delete(key));
      probing.set(key, running);
    }
    return running;
  };
  const status = async (): Promise<AgentRuntimeStatus> => {
    const key = probeKey();
    if (probed === undefined || probed.key !== key) return (await refresh(key)).status;
    // A stale answer is given at once while a new probe runs (D95).
    const ttl = probed.probe.status.available ? STATUS_TTL_MS : UNAVAILABLE_TTL_MS;
    if (Date.now() - probed.at >= ttl) void refresh(key).catch(() => undefined);
    return probed.probe.status;
  };

  // --- Signing in (D1151) -------------------------------------------------------------
  /** Codex's own login (`account/login/start`), on an app-server of its own while it runs. */
  const logins = new Map<
    string,
    { readonly done: Promise<{ success: boolean; error?: string }>; end(error?: string): void }
  >();
  /** An app-server for an account request, with the config's binary and home. */
  const accountServer = async () => {
    const config = options.config();
    const connection = launch({
      binaryPath: config.binaryPath,
      args: config.args ?? [],
      cwd: Os.tmpdir(),
      env: codexEnvironment(config.env, expandHome(config.homePath), config.inheritEnv),
    });
    try {
      await initialize(connection, VERSION);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  };
  /** The account changed: the next look at Codex probes it again. */
  const accountChanged = () => {
    probed = undefined;
    liveRateLimits = undefined;
  };
  const auth: AgentAuth = {
    methods: ["browser", "device-code"],
    async start(method) {
      const connection = await accountServer();
      let settle!: (result: { success: boolean; error?: string }) => void;
      const done = new Promise<{ success: boolean; error?: string }>((resolve) => {
        settle = resolve;
      });
      let loginId: string | undefined;
      connection.onNotification((notified, params) => {
        if (notified !== "account/login/completed" || !isRecord(params)) return;
        // One login per app-server: its end may come before `account/login/start` answered.
        if (
          loginId !== undefined &&
          typeof params["loginId"] === "string" &&
          params["loginId"] !== loginId
        ) {
          return;
        }
        settle({
          success: params["success"] === true,
          ...(typeof params["error"] === "string" ? { error: params["error"] } : {}),
        });
      });
      void connection.exited.then(() =>
        settle({ success: false, error: "Codex exited before the sign-in ended." }),
      );
      let started: Record<string, unknown>;
      try {
        started = ((await connection.request(
          "account/login/start",
          // T3's two interactions: Codex's own browser login, or a device code to enter.
          method === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" },
        )) ?? {}) as Record<string, unknown>;
      } catch (error) {
        connection.close();
        throw error;
      }
      loginId = typeof started["loginId"] === "string" ? started["loginId"] : undefined;
      const url =
        typeof started["authUrl"] === "string"
          ? started["authUrl"]
          : typeof started["verificationUrl"] === "string"
            ? started["verificationUrl"]
            : undefined;
      if (loginId === undefined || url === undefined) {
        connection.close();
        throw new Error("Codex started no sign-in.");
      }
      const flowId = loginId;
      logins.set(flowId, {
        done,
        end: (error) => settle({ success: false, ...(error === undefined ? {} : { error }) }),
      });
      // The last sign-ins stay, so a wait that comes after the end still learns it.
      for (const old of [...logins.keys()].slice(0, Math.max(0, logins.size - MAX_LOGINS))) {
        logins.delete(old);
      }
      void done.then((result) => {
        connection.close();
        if (result.success) accountChanged();
      });
      return {
        flowId,
        url,
        ...(typeof started["userCode"] === "string" ? { userCode: started["userCode"] } : {}),
      };
    },
    wait: async (flowId) =>
      (await logins.get(flowId)?.done) ?? { success: false, error: "No such sign-in." },
    async cancel(flowId) {
      const login = logins.get(flowId);
      if (login === undefined) return;
      login.end("Sign-in cancelled.");
    },
    async signOut() {
      const connection = await accountServer();
      try {
        await connection.request("account/logout", null);
      } finally {
        connection.close();
        accountChanged();
      }
    },
  };

  /** The latest snapshot: the updates since the last probe, else the probe's. */
  const rateLimits = () => live()?.snapshot ?? current()?.rateLimits;
  /** The usage limits as Codex last reported them (D1142): the probe's, then its updates. */
  const usageLimits = async (): Promise<AgentUsageLimits | undefined> => {
    // `/usage-limits` reads them again when what it knows (the last read or update, the newer)
    // is older than a minute, the read failed, or a window it shows has reset since (D1142),
    // instead of answering from the status cache.
    const key = probeKey();
    const last = probed?.key === key ? probed : undefined;
    live();
    const now = Date.now();
    const known = Math.max(
      last?.at ?? 0,
      liveRateLimits === undefined ? 0 : Date.parse(liveRateLimits.at),
    );
    const shown =
      liveRateLimits === undefined
        ? (last?.probe.usageLimits?.windows ?? [])
        : codexRateLimitsToWindows(liveRateLimits.snapshot);
    const stale =
      last === undefined ||
      now - known >= USAGE_TTL_MS ||
      last.probe.usageLimits?.unavailable?.reason === "probeFailed" ||
      shown.some((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now);
    // A new read drops the updates it is newer than (`refresh`).
    if (stale) await refresh(key).catch(() => undefined);
    else await status();
    const read = current()?.usageLimits;
    if (liveRateLimits === undefined) return read;
    return {
      checkedAt: liveRateLimits.at,
      windows: codexRateLimitsToWindows(liveRateLimits.snapshot),
      ...(read?.resetCredits === undefined ? {} : { resetCredits: read.resetCredits }),
    };
  };

  /**
   * The default model once Codex was asked for its own, waiting at most MODEL_WAIT_MS: a
   * Codex that hangs or cannot start leaves the bundled default, and the turn's own start
   * then reports what is wrong.
   */
  const waitedDefault = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      status().then(defaultModel, defaultModel),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(defaultModel()), MODEL_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  return {
    sessions,
    agentId: options.agentId ?? CODEX_AGENT_ID,
    name: options.name ?? "Codex",
    get models() {
      return models();
    },
    get defaultModel() {
      return defaultModel();
    },
    runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    interactionModes: ["default", "plan"],
    steering: true,
    // T3 lists /compact (D884) and /goal (D1149) for Codex, and the skills Codex finds in the
    // folder (D885).
    async commands({ cwd }) {
      const key = `${probeKey()}|${cwd}`;
      let entry = skillProbes.get(key);
      if (entry === undefined || Date.now() - entry.at > STATUS_TTL_MS) {
        // Folders not asked about for a while are forgotten.
        for (const [other, kept] of skillProbes) {
          if (Date.now() - kept.at > STATUS_TTL_MS) skillProbes.delete(other);
        }
        entry = { at: Date.now(), skills: probeSkills(launch, options.config(), cwd) };
        skillProbes.set(key, entry);
        // A probe that failed is not kept.
        const probing = entry;
        void probing.skills.catch(() => {
          if (skillProbes.get(key) === probing) skillProbes.delete(key);
        });
      }
      const skills = await entry.skills.catch((error: unknown) => {
        options.log?.("codex did not list its skills", { cwd, error: String(error) });
        return [];
      });
      return { commands: [COMPACT_COMMAND, GOAL_COMMAND], skills };
    },
    status,
    usageLimits,
    auth,
    startTurn(request) {
      const config = options.config();
      const turn = codexTurn(request, {
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        sessions,
        threads: options.threads,
        settings: config,
        // A turn that names no model before Codex was asked for its own waits for that
        // answer, so it does not go out with a bundled model the installed Codex lacks.
        model:
          request.model ??
          config.defaultModel ??
          (current() === undefined ? waitedDefault() : defaultModel()),
        modelOptions: (model) => models().find((listed) => listed.id === model)?.options,
        ...(config.mcp && options.mcp !== undefined
          ? {
              mcp: (threadId: string, writes: boolean) =>
                mcpAttachment(options.mcp!, threadId, writes),
            }
          : {}),
        version: VERSION,
        home: expandHome(config.homePath),
        // A reset time already past is no time to retry after (a probe read before it reset).
        usageLimitResetAt: () => {
          const at = codexUsageLimitResetAt(rateLimits());
          return at !== undefined && Date.parse(at) > Date.now() ? at : undefined;
        },
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      turns.set(turn, { threadId: request.threadId, done: turn.done });
      void turn.done.then(() => turns.delete(turn));
      return {
        items: turn.items,
        // Its subagents' work in the background after the turn (D1318).
        afterwards: turn.afterwards,
        interrupt: () => turn.interrupt(),
        ...(turn.respond === undefined ? {} : { respond: turn.respond }),
        ...(turn.steer === undefined ? {} : { steer: (input) => turn.steer!(input) }),
      };
    },
    settled: async (threadId) => {
      const running = [...turns.values()].filter((turn) => turn.threadId === threadId);
      await Promise.all(running.map((turn) => turn.done));
    },
    dispose() {
      for (const turn of turns.keys()) turn.interrupt();
      // A sign-in under way ends with its app-server.
      for (const login of logins.values()) login.end("Codex was stopped.");
      sessions.dispose();
    },
  };
}

/**
 * Which Codex thread each Jhin thread runs on, in `storage.kv`. Writes of one thread run one
 * after another, so `forget` (its thread was deleted) lands after a `set` already on its way,
 * and later `set`s write nothing until `settled` says no turn of the thread is left.
 */
export function threadRecords(kv: KeyValueStore): ThreadStore & {
  forget(threadId: string, settled?: Promise<void>): Promise<void>;
} {
  const forgotten = new Set<string>();
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
  const key = (threadId: string) => `thread/${threadId}`;
  const read = async (threadId: string): Promise<CodexThreadRecord | undefined> => {
    const record = (await kv.get(NAMESPACE, key(threadId))) as
      | { codexThreadId?: unknown; turns?: unknown }
      | undefined;
    if (typeof record?.codexThreadId !== "string") return undefined;
    const turns = Array.isArray(record.turns)
      ? record.turns.filter(
          (turn): turn is RecordedTurn =>
            typeof turn?.turnId === "string" && typeof turn?.codexTurnId === "string",
        )
      : [];
    return { codexThreadId: record.codexThreadId, turns };
  };
  return {
    get: async (threadId) => (await read(threadId))?.codexThreadId,
    read,
    set: (threadId, codexThreadId, turns) =>
      write(threadId, async () => {
        if (forgotten.has(threadId)) return;
        await kv.set(NAMESPACE, key(threadId), {
          codexThreadId,
          // A record older than D1147 has no turns: rollbacks before it start a new thread.
          ...(turns === undefined ? {} : { turns: turns.map((turn) => ({ ...turn })) }),
          at: new Date().toISOString(),
        });
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

const RunningCodex = z.object({
  threadId: z.string(),
  model: z.string().optional(),
  busy: z.boolean().describe("A turn runs on it now"),
  idleSince: z.string().optional().describe("When its last turn ended (ISO 8601)"),
});

/**
 * The plugin; `launch` starts `codex app-server` (the real one in the distribution). Nothing
 * starts Codex at activation: a one-shot CLI command boots the same plugins.
 */
export function codexPlugin(launch: Launcher = launchAppServer) {
  return definePlugin({
    activate(context) {
      context.config.define(CONFIG_SECTION, Config);
      const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
      const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
      const registry = context.services.get<AgentRegistry>(AGENT_REGISTRY_CAPABILITY);
      const threads = threadRecords(kv);
      const mcp = context.services.tryGet<McpServer>(MCP_SERVER_CAPABILITY);
      const runtime = createCodexRuntime({
        threads,
        launch,
        ...(mcp === undefined ? {} : { mcp }),
        config: () => context.config.get<Config>(CONFIG_SECTION),
        log: (message, data) => context.log.warn(message, data),
      });
      context.subscriptions.add(registry.register(runtime));
      context.onDeactivate(() => runtime.dispose());

      // Each further account is a runtime of its own over a shadow home (D1319).
      const accounts = new Map<
        string,
        { key: string; runtime: ReturnType<typeof createCodexRuntime>; registration: Disposable }
      >();
      const syncAccounts = () => {
        const config = context.config.get<Config>(CONFIG_SECTION);
        const wanted = new Map(config.accounts.map((account) => [account.id, account]));
        for (const [id, entry] of accounts) {
          const account = wanted.get(id);
          if (account !== undefined && JSON.stringify(account) === entry.key) continue;
          entry.registration.dispose();
          entry.runtime.dispose();
          accounts.delete(id);
        }
        for (const account of wanted.values()) {
          if (accounts.has(account.id)) continue;
          const shadowHome = expandHome(account.homePath)!;
          const accountRuntime = createCodexRuntime({
            threads,
            agentId: `${CODEX_AGENT_ID}:${account.id}`,
            name: `Codex · ${account.name}`,
            // Its home is linked over the main one before each Codex of it starts.
            launch: (launchOptions) => {
              const base = context.config.get<Config>(CONFIG_SECTION);
              materializeShadowHome(
                expandHome(base.homePath) ?? Path.join(Os.homedir(), ".codex"),
                shadowHome,
              );
              return launch(launchOptions);
            },
            ...(mcp === undefined ? {} : { mcp }),
            config: () => ({
              ...context.config.get<Config>(CONFIG_SECTION),
              homePath: shadowHome,
              accounts: [],
            }),
            log: (message, data) => context.log.warn(message, { account: account.id, ...data }),
          });
          accounts.set(account.id, {
            key: JSON.stringify(account),
            runtime: accountRuntime,
            registration: registry.register(accountRuntime),
          });
        }
      };
      syncAccounts();
      context.subscriptions.add(context.config.onDidChange(CONFIG_SECTION, syncAccounts));
      context.onDeactivate(() => {
        for (const entry of accounts.values()) {
          entry.registration.dispose();
          entry.runtime.dispose();
        }
        accounts.clear();
      });
      /** The runtimes of every account: the main one first. */
      const allRuntimes = () => [runtime, ...[...accounts.values()].map((entry) => entry.runtime)];
      // Another idle time: the app-servers already idle count it from their last turn.
      context.subscriptions.add(
        context.config.onDidChange(CONFIG_SECTION, () => runtime.sessions.rearmIdle()),
      );

      // A deleted or archived thread takes no more turns: its Codex exits. A deleted
      // thread's record goes too (Codex's own session files stay).
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          const payload = event.payload as { id?: unknown; archivedAt?: unknown } | null;
          if (typeof payload?.id !== "string") return;
          if (event.type === ThreadEvents.threadDeleted) {
            for (const each of allRuntimes()) each.sessions.close(payload.id, true);
            void threads.forget(payload.id, runtime.settled(payload.id)).catch((error: unknown) =>
              context.log.warn("could not forget the codex thread", {
                threadId: payload.id,
                error: String(error),
              }),
            );
          } else if (
            event.type === ThreadEvents.threadUpdated &&
            typeof payload.archivedAt === "string"
          ) {
            for (const each of allRuntimes()) each.sessions.close(payload.id, true);
          }
        }),
      );

      context.commands.register({
        name: "codex.sessions.list",
        description: "Threads whose Codex app-server keeps running between turns",
        input: z.object({}),
        output: z.array(RunningCodex),
        permissions: ["threads.read"],
        handler: () => allRuntimes().flatMap((each) => each.sessions.list()),
      });
      context.commands.register({
        name: "codex.sessions.close",
        description:
          "Ends the running Codex of a thread, or of every thread, that no turn runs on; `force` ends busy ones too (their turn fails). The thread's next turn resumes its Codex thread",
        input: z.object({
          threadId: z.string().optional(),
          force: z
            .boolean()
            .default(false)
            .describe("Also end a Codex a turn is running on; that turn fails"),
        }),
        output: z.object({ closed: z.number().int() }),
        permissions: ["threads.write"],
        handler: ({ threadId, force }) => {
          let closed = 0;
          for (const each of allRuntimes()) {
            if (threadId !== undefined) closed += each.sessions.close(threadId, force) ? 1 : 0;
            else closed += force ? each.sessions.closeAll() : each.sessions.closeIdle();
          }
          return { closed };
        },
      });
    },
  });
}

export default codexPlugin();
