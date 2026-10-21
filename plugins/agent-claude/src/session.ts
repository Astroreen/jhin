// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: one live query
// per native thread fed through a prompt queue (ClaudeAgentSdkQueryRunner.open), reused for
// the next turn when its launch options match (claudeEffectiveQueryPolicyKey, openQuery),
// the model and permission mode applied to it live (setModel, setPermissionMode, including
// the mode Claude switched to by itself), replaced otherwise; messages bound to the turn
// whose prompt they answer by its uuid (T3's prompt uuids and echo tracking);
// ProviderSessionManager's release of an idle session; the node's MCP server registered
// over the control channel (ClaudeAgentSdkQueryRunner.open's setMcpServers); and steering
// a running turn with a message of priority "now", whose aborted result does not end the
// turn (steerTurn, isClaudeActiveSteeringAbortResult), with the turn's foreground subagents
// moved to the background first (backgroundForegroundSubagents). T3's continuation turns,
// wake buffers and background-work guards are not ported.
import { pickEnvironment } from "@jhin/agent-api";
import type {
  CanUseTool,
  EffortLevel,
  McpServerConfig,
  McpSetServersResult,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The part of the SDK's `Query` a turn and its live session use. */
interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Only with streaming input; a session that lacks them is replaced instead. */
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  setMcpServers?(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  applyFlagSettings?(settings: {
    effortLevel?: EffortLevel | null;
    fastMode?: boolean | null;
    ultracode?: boolean | null;
  }): Promise<void>;
  /** Moves a foreground task to the background (Ctrl+B); false when none matched. */
  backgroundTasks?(toolUseId?: string): Promise<boolean>;
}

/** MCP servers a Claude Code gets once started, and how to revoke their credentials. */
export interface Attachment {
  readonly servers: Record<string, McpServerConfig>;
  /** Called once that Claude Code ended. */
  dispose(): void;
}

/** The SDK's `query`, injected so tests can script Claude Code. */
export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

/** Whether a thread's Claude Code keeps running between turns, and for how long when idle. */
export interface KeepAlive {
  readonly keepAlive: boolean;
  /** Milliseconds an idle session stays open; 0 keeps it until something else closes it. */
  readonly idleMs: number;
  /** How many Claude Codes a node keeps (D347); 0: no cap. */
  readonly maxSessions?: number;
}

/** One turn's hold on its thread's Claude Code: its message went in, its messages come out. */
export interface Lease {
  /** The turn's messages up to its result; they end early when Claude Code exits. */
  readonly messages: AsyncIterable<SDKMessage>;
  /** Whether Claude Code was already running for an earlier turn. */
  readonly reused: boolean;
  interrupt(): Promise<unknown>;
  /**
   * Hands Claude Code another message for the running turn (a steer, D206): it stops what
   * it streams and goes on with the message. Throws once the turn's messages ended.
   */
  steer(message: SDKUserMessage): void;
  /**
   * Moves the turn's subagents still running in the foreground to the background, so a
   * steer does not cancel them (D805). Settles once Claude Code answered, or after 5 s.
   */
  backgroundSubagents(): Promise<void>;
  /**
   * Ends the turn's hold, once. `keep` (the turn reached its result) leaves Claude Code
   * running for the next turn when the setting keeps sessions; anything else ends it.
   */
  release(keep: boolean): void;
}

/** A live session as the `claude.sessions.list` command reports it. */
export interface LiveSessionInfo {
  readonly threadId: string;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  /** A turn holds it now. */
  readonly busy: boolean;
  /** When its last turn ended (ISO 8601); absent while busy. */
  readonly idleSince?: string;
  /** Background tasks it runs (D348): it is not ended for being idle while they run. */
  readonly background: number;
}

export interface LiveSessions {
  /**
   * Hands the turn's message to the thread's Claude Code: the running one when its launch
   * options match and its model and mode can change live, a new one otherwise.
   */
  lease(params: {
    readonly threadId: string;
    readonly options: Options;
    readonly message: SDKUserMessage;
    /**
     * The MCP servers a Claude Code started for this lease gets (D340); a running one
     * already has them. Whether there are any must show in `options` (the launch key).
     */
    readonly attach?: (threadId: string) => Attachment;
    /** The node's variables Claude Code gets (D346); every one when unset. */
    readonly inherit?: readonly string[];
  }): Promise<Lease>;
  /**
   * Ends a thread's live session when no turn holds it, or with `force` also one a turn
   * runs on (that turn fails). False when nothing was ended.
   */
  close(threadId: string, force?: boolean): boolean;
  /** Ends every live session no turn holds; held ones end with their turn's release. */
  closeIdle(): number;
  /**
   * Arms the idle timers of the sessions no turn holds again, with the idle time the
   * setting says now, counted from each one's last turn.
   */
  rearmIdle(): void;
  list(): LiveSessionInfo[];
  /**
   * Settles once every Claude Code of the thread has exited (its output ended), also one
   * a later one replaced: it writes its session file until then, after it was asked to close.
   */
  ended(threadId: string): Promise<void>;
  /** Ends every live session. */
  dispose(): void;
}

/** A queue read by one consumer until `end`. */
function queue<T>() {
  const buffer: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(value: T) {
      if (ended) return;
      buffer.push(value);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *read(): AsyncGenerator<T> {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

/** Where the messages of a session go while a turn holds it. */
interface Holder {
  readonly canUseTool: CanUseTool | undefined;
  push(message: SDKMessage): void;
  end(error?: { error: unknown }): void;
}

interface Live {
  readonly threadId: string;
  /** The launch options that need a new process to change. */
  readonly key: string;
  readonly query: ClaudeQuery;
  readonly input: ReturnType<typeof queue<SDKUserMessage>>;
  model: string | undefined;
  /** Changed live with applyFlagSettings (D349). */
  effort: EffortLevel | undefined;
  /** Fast Mode and Ultracode as last set, changed live too (t3-parity.md D298). */
  flags: { fastMode?: boolean; ultracode?: boolean };
  /** Its non-ambient background tasks, as `background_tasks_changed` last said (D348). */
  background: number;
  /** Ends once its background work does: per-turn, or turned to it while the work ran. */
  closeWhenDone: boolean;
  /** As Claude Code last reported it: Claude can switch it by itself (plan mode). */
  permissionMode: PermissionMode | undefined;
  /** Taken by a turn, from its lease until its release. */
  busy: boolean;
  /** The last lease that came for it: an earlier one still on its way gives up. */
  leasedBy: object | undefined;
  /**
   * Whether this Claude Code marks the frames of a turn with the uuid of the message it
   * answers (`user_message_uuid(s)`), as current CLIs do: then a turn takes only its own.
   */
  stamps: boolean;
  /** Whether it reports `session_state_changed` (running, idle), as asked at launch. */
  reportsState: boolean;
  /** Whether the last state it reported is idle: it has taken every message sent so far. */
  settled: boolean;
  holder: Holder | undefined;
  /** Settles once its MCP servers are registered (D340); rejects when Claude Code never answers. */
  ready: Promise<void>;
  /** Revokes what `ready` registered; called when it ends. */
  detach: (() => void) | undefined;
  idleSince: Date | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

/**
 * Options a running Claude Code cannot take: everything but the model, the permission
 * mode, the session to start or resume (a running one has it) and the permission callback
 * (routed to the turn holding the session). `allowDangerouslySkipPermissions` stays in, so
 * entering or leaving full access starts Claude Code again, as in T3.
 */
function launchKey(options: Options): string {
  const {
    model: _model,
    permissionMode: _permissionMode,
    resume: _resume,
    sessionId: _sessionId,
    canUseTool: _canUseTool,
    effort: _effort,
    settings,
    ...launch
  } = options;
  // Fast Mode and Ultracode are flags a running Claude Code takes (as T3 applies them).
  const {
    fastMode: _fast,
    ultracode: _ultra,
    ...kept
  } = typeof settings === "object" && settings !== null ? settings : {};
  return JSON.stringify({
    ...launch,
    ...(typeof settings === "string"
      ? { settings }
      : Object.keys(kept).length === 0
        ? {}
        : { settings: kept }),
  });
}

/** The flags of a turn's settings a running Claude Code takes (`applyFlagSettings`). */
function flagsOf(options: Options): { fastMode?: boolean; ultracode?: boolean } {
  const settings = typeof options.settings === "object" ? options.settings : undefined;
  return {
    ...(typeof settings?.fastMode === "boolean" ? { fastMode: settings.fastMode } : {}),
    ...(typeof settings?.ultracode === "boolean" ? { ultracode: settings.ultracode } : {}),
  };
}

/**
 * The node's variables Claude Code gets (D346): those `inherit` names, exactly or by a
 * prefix ending in `*`; `["*"]` is every one.
 */
export function inheritedEnvironment(
  inherit: readonly string[] = ["*"],
): Record<string, string | undefined> {
  return pickEnvironment(process.env, inherit);
}

/**
 * The environment Claude Code launches with: the node's variables the allow-list lets
 * through, the caller's `env` (the config's, which with the list is in the launch key) and
 * running and idle reports. Idle is Claude Code's own word that it took every message, the
 * way out for a turn whose frames it does not mark (D104). The node's own values are passed
 * through, not keyed on.
 */
function launchEnvironment(
  env: Options["env"],
  inherit: readonly string[] | undefined,
): Record<string, string | undefined> {
  return { ...inheritedEnvironment(inherit), ...env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" };
}

/** How long Claude Code may take to answer the MCP server registration (T3's limit). */
const MCP_REGISTRATION_TIMEOUT_MS = 90_000;

/** The longest delay setTimeout takes (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER = 2 ** 31 - 1;

/** The tools that start a subagent: `Agent`, and `Task` in older CLIs. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/** How long a steer waits for Claude Code to move the turn's subagents (T3's 5 s). */
const BACKGROUND_MOVE_MS = 5_000;

/**
 * Follows the main conversation's subagents that run in the foreground, by the tool
 * call that started each: added when Claude Code calls `Agent` without
 * `run_in_background`, gone once the call returned (T3's sessionSubagentsByTaskId).
 */
function trackForegroundSubagents(message: SDKMessage, running: Set<string>): void {
  if (message.type !== "assistant" && message.type !== "user") return;
  if (message.parent_tool_use_id) return;
  const content: unknown = message.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content as { type?: unknown }[]) {
    if (message.type === "assistant" && block.type === "tool_use") {
      const call = block as { id: string; name: string; input?: { run_in_background?: unknown } };
      if (SUBAGENT_TOOLS.has(call.name) && call.input?.run_in_background !== true) {
        running.add(call.id);
      }
    } else if (message.type === "user" && block.type === "tool_result") {
      running.delete((block as { tool_use_id: string }).tool_use_id);
    }
  }
}

/** The uuids of the messages a frame answers, when Claude Code marked it. */
function stampOf(message: SDKMessage): readonly string[] | undefined {
  const marked = message as { user_message_uuid?: unknown; user_message_uuids?: unknown };
  if (Array.isArray(marked.user_message_uuids) && marked.user_message_uuids.length > 0) {
    return marked.user_message_uuids as string[];
  }
  return typeof marked.user_message_uuid === "string" ? [marked.user_message_uuid] : undefined;
}

/** What a `session_state_changed` frame reports, if the frame is one. */
function stateOf(message: SDKMessage): "idle" | "running" | "requires_action" | undefined {
  return message.type === "system" && message.subtype === "session_state_changed"
    ? message.state
    : undefined;
}

/** Claude Code did not take the switch to full access it was started for (D343). */
class BypassRefused extends Error {
  constructor(cause: unknown) {
    super("Claude Code did not switch to bypassPermissions", { cause });
  }
}

/**
 * A result Claude Code sends when a steer stopped what it was doing: the turn goes on with
 * the steer (T3's isClaudeActiveSteeringAbortResult).
 */
const isSteerAbort = (message: SDKMessage) =>
  message.type === "result" &&
  (message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools");

/**
 * Results a turn ends with because a steer stopped the response and Claude Code had
 * nothing more to say: the turn is complete, not stopped (D206).
 */
const steeredAway = new WeakSet<SDKMessage>();
export const endedBySteer = (message: SDKMessage) => steeredAway.has(message);

/** Ends a turn whose message Claude Code took without answering it (nothing marked as its). */
class NoAnswer extends Error {
  constructor() {
    super("Claude Code finished without answering the turn's message.");
  }
}

/** A replacement would end the background work a session runs (D348, T3's message). */
export class BackgroundWorkRunning extends Error {
  constructor() {
    super(
      "Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again.",
    );
  }
}

/** The non-ambient tasks of a `background_tasks_changed` frame, if the frame is one. */
function backgroundOf(message: SDKMessage): number | undefined {
  const frame = message as { type: string; subtype?: string; tasks?: { ambient?: boolean }[] };
  if (frame.type !== "system" || frame.subtype !== "background_tasks_changed") return undefined;
  return (frame.tasks ?? []).filter((task) => task.ambient !== true).length;
}

/** What `Lease.steer` throws once the turn's messages ended. */
export class LeaseEnded extends Error {
  constructor() {
    super("The turn has ended: Claude Code takes no more messages for it.");
  }
}

/** Ends a turn that still held its thread's Claude Code when a later turn took it. */
export class SessionTakenOver extends Error {
  constructor() {
    super("A later turn of this thread took its Claude Code over.");
  }
}

const noTurn = (toolUseID: string): PermissionResult => ({
  behavior: "deny",
  message: "No turn of this thread is running.",
  toolUseID,
});

/**
 * The live sessions of a node: at most one running Claude Code per thread. With
 * `keepAlive` off every turn ends its Claude Code, so each turn starts one and resumes.
 */
export function createLiveSessions(options: {
  readonly query: QueryFunction;
  readonly keepAlive: () => KeepAlive;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}): LiveSessions {
  const sessions = new Map<string, Live>();
  /** The exits of each thread's Claude Codes still running, also those replaced. */
  const exits = new Map<string, Set<Promise<void>>>();

  const close = (live: Live, reason?: Error) => {
    if (live.closed) return;
    live.closed = true;
    clearTimeout(live.timer);
    if (sessions.get(live.threadId) === live) sessions.delete(live.threadId);
    live.input.end();
    live.detach?.();
    live.detach = undefined;
    live.holder?.end(reason === undefined ? undefined : { error: reason });
    try {
      live.query.close();
    } catch (error) {
      options.log?.("could not close claude code", {
        threadId: live.threadId,
        error: String(error),
      });
    }
  };

  /** Ends an idle session once it has waited `idleMs` since its last turn (0: never). */
  const arm = (live: Live, idleMs: number) => {
    clearTimeout(live.timer);
    live.timer = undefined;
    if (idleMs <= 0 || live.idleSince === undefined) return;
    const deadline = live.idleSince.getTime() + idleMs;
    // setTimeout fires at once past its limit (about 24.8 days): a longer wait goes in
    // steps of at most that, each counting what is left until the deadline.
    const wait = () => {
      const left = Math.max(0, deadline - Date.now());
      // Past its deadline already (its background work outlasted it): it ends now.
      if (left === 0 && live.background === 0) return close(live);
      // Background work keeps it past its deadline; it is armed again once the work ends.
      live.timer = setTimeout(
        () => (left > MAX_TIMER ? wait() : live.background > 0 ? undefined : close(live)),
        Math.min(left, MAX_TIMER),
      );
      live.timer.unref?.();
    };
    wait();
  };

  /**
   * Registers the servers over the control channel, never on the command line: the
   * credentials stay out of Claude Code's argv and its commands' environment (T3's reason).
   * A server it cannot connect is left out with a warning; no answer at all fails the turn.
   */
  const register = async (live: Live, attachment: Attachment) => {
    if (live.query.setMcpServers === undefined) {
      options.log?.("claude code takes no mcp servers, running without them", {
        threadId: live.threadId,
      });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Error texts can echo the headers: only server names are logged.
    const names = Object.keys(attachment.servers);
    const registered = live.query.setMcpServers(attachment.servers).then(
      (result) => Object.keys(result.errors ?? {}),
      () => names,
    );
    try {
      const failed = await Promise.race([
        registered,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude Code did not answer the MCP server registration.")),
            MCP_REGISTRATION_TIMEOUT_MS,
          );
        }),
      ]);
      if (failed.length > 0 && !live.closed) {
        options.log?.("claude code could not connect mcp servers", {
          threadId: live.threadId,
          servers: failed,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const open = (
    threadId: string,
    key: string,
    launch: Options,
    attach: ((threadId: string) => Attachment) | undefined,
    bypassAtLaunch = false,
    inherit?: readonly string[],
  ): Live => {
    // At most one Claude Code per thread, so none is ever out of reach.
    const existing = sessions.get(threadId);
    if (existing !== undefined) close(existing, new SessionTakenOver());
    const input = queue<SDKUserMessage>();
    let live!: Live;
    // The SDK warns on every query that starts in bypassPermissions with canUseTool, which
    // AskUserQuestion needs: start in default and switch before the first message (D343).
    const switchToBypass = launch.permissionMode === "bypassPermissions" && !bypassAtLaunch;
    const started: Options = switchToBypass ? { ...launch, permissionMode: "default" } : launch;
    const query = options.query({
      prompt: input.read(),
      options: {
        ...started,
        env: launchEnvironment(launch.env, inherit),
        // Set once per process: Claude Code asks whichever turn holds the session.
        canUseTool: (toolName, toolInput, permission) =>
          live.holder?.canUseTool?.(toolName, toolInput, permission) ??
          Promise.resolve(noTurn(permission.toolUseID)),
      },
    });
    live = {
      threadId,
      key,
      query,
      input,
      model: launch.model,
      effort: launch.effort,
      flags: flagsOf(launch),
      background: 0,
      closeWhenDone: false,
      permissionMode: started.permissionMode,
      busy: true,
      leasedBy: undefined,
      stamps: false,
      reportsState: false,
      settled: false,
      holder: undefined,
      ready: Promise.resolve(),
      detach: undefined,
      idleSince: undefined,
      timer: undefined,
      closed: false,
    };
    sessions.set(threadId, live);
    if (switchToBypass) {
      live.ready = (async () => {
        try {
          if (query.setPermissionMode === undefined) throw new Error("no setPermissionMode");
          await query.setPermissionMode("bypassPermissions");
          live.permissionMode = "bypassPermissions";
        } catch (error) {
          throw new BypassRefused(error);
        }
      })();
    }
    if (attach !== undefined) {
      const switched = live.ready;
      try {
        const attachment = attach(threadId);
        live.detach = () => attachment.dispose();
        live.ready = switched.then(() => register(live, attachment));
      } catch (error) {
        // The lease closes the session on a failed `ready`: no Claude Code is left behind.
        switched.catch(() => undefined);
        live.ready = Promise.reject(error);
      }
    }
    // One reader per process, for its whole life: what Claude Code sends between turns is
    // dropped, and an exit while idle closes the session, so the next turn resumes.
    const exited = (async () => {
      try {
        for await (const message of query) {
          if (
            message.type === "system" &&
            (message.subtype === "init" || message.subtype === "status") &&
            "permissionMode" in message &&
            message.permissionMode !== undefined
          ) {
            live.permissionMode = message.permissionMode;
          }
          if (!live.stamps && stampOf(message) !== undefined) live.stamps = true;
          const background = backgroundOf(message);
          if (background !== undefined) {
            live.background = background;
            // The work it waited for ended: per-turn ends it, otherwise its idle time runs.
            if (background === 0 && !live.busy && !live.closed) {
              if (live.closeWhenDone) close(live);
              else arm(live, options.keepAlive().idleMs);
            }
          }
          const state = stateOf(message);
          if (state !== undefined) {
            live.reportsState = true;
            live.settled = state === "idle";
          }
          live.holder?.push(message);
        }
        live.holder?.end();
      } catch (error) {
        if (live.holder === undefined && !live.closed) {
          options.log?.("claude code exited while idle", { threadId, error: String(error) });
        }
        live.holder?.end({ error });
      } finally {
        close(live);
      }
    })();
    const running = exits.get(threadId) ?? new Set<Promise<void>>();
    running.add(exited);
    exits.set(threadId, running);
    void exited.finally(() => {
      running.delete(exited);
      if (running.size === 0 && exits.get(threadId) === running) exits.delete(threadId);
    });
    return live;
  };

  /**
   * Ends the idle sessions that waited longest, without background work, until no more than
   * `maxSessions` run (D347); held ones and those running work are never ended for it.
   */
  const enforceCap = () => {
    const max = options.keepAlive().maxSessions ?? 0;
    if (max <= 0 || sessions.size <= max) return;
    const idle = [...sessions.values()]
      .filter((live) => !live.busy && live.background === 0 && live.idleSince !== undefined)
      .toSorted((a, b) => a.idleSince!.getTime() - b.idleSince!.getTime());
    for (const live of idle) {
      if (sessions.size <= max) return;
      close(live);
    }
  };

  /** Puts the turn's model, effort and mode on a running session; false when it cannot. */
  const adapt = async (live: Live, launch: Options) => {
    try {
      if (launch.model !== live.model) {
        if (live.query.setModel === undefined) return false;
        await live.query.setModel(launch.model);
        live.model = launch.model;
      }
      if (launch.permissionMode !== live.permissionMode) {
        if (live.query.setPermissionMode === undefined || launch.permissionMode === undefined) {
          return false;
        }
        await live.query.setPermissionMode(launch.permissionMode);
        live.permissionMode = launch.permissionMode;
      }
      const flags = flagsOf(launch);
      if (flags.fastMode !== live.flags.fastMode || flags.ultracode !== live.flags.ultracode) {
        if (live.query.applyFlagSettings === undefined) return false;
        await live.query.applyFlagSettings({
          fastMode: flags.fastMode ?? null,
          ultracode: flags.ultracode ?? null,
        });
        live.flags = flags;
      }
      // Last: a session the model or mode cannot go to keeps its effort when it is kept.
      if (launch.effort !== live.effort) {
        if (live.query.applyFlagSettings === undefined) return false;
        await live.query.applyFlagSettings({ effortLevel: launch.effort ?? null });
        live.effort = launch.effort;
      }
      return !live.closed;
    } catch (error) {
      options.log?.("claude code did not take the turn's settings, starting it again", {
        threadId: live.threadId,
        error: String(error),
      });
      return false;
    }
  };

  return {
    async lease({ threadId, options: launch, message, attach, inherit }) {
      // With or without the node's MCP server is a launch of its own (D340), and so is
      // another allow-list of the node's variables (D346).
      const key = `${launchKey(launch)}${attach === undefined ? "" : "+mcp"}${
        inherit === undefined ? "" : `+env:${JSON.stringify(inherit)}`
      }`;
      const self = {};
      let live = sessions.get(threadId);
      if (live !== undefined) live.leasedBy = self;
      // Busy means its turn was given up on: the threads plugin runs one turn of a thread
      // at a time and frees the thread only once a turn ended, or once a stop stopped
      // waiting for a turn that ignored its interrupt. The newer turn takes Claude Code
      // over; the turn still holding it ends (D98).
      if (live?.busy === true) {
        close(live, new SessionTakenOver());
        live = undefined;
      } else if (live !== undefined && (live.closed || live.key !== key)) {
        // Another launch would end the work it runs: the turn is refused instead (D348).
        if (!live.closed && live.background > 0) throw new BackgroundWorkRunning();
        close(live);
        live = undefined;
      }
      if (live !== undefined) {
        live.busy = true;
        const closeWhenDone = live.closeWhenDone;
        live.closeWhenDone = false;
        clearTimeout(live.timer);
        live.timer = undefined;
        const idleSince = live.idleSince;
        live.idleSince = undefined;
        const adapted = await adapt(live, launch);
        // A later turn of the thread came meanwhile and took the session: it wins.
        if (live.leasedBy !== self) throw new SessionTakenOver();
        if (!adapted && live.background > 0 && !live.closed) {
          // It stays as it was, idle with its work, and the turn is refused (D348).
          live.busy = false;
          live.closeWhenDone = closeWhenDone;
          live.idleSince = idleSince ?? new Date();
          if (!closeWhenDone) arm(live, options.keepAlive().idleMs);
          throw new BackgroundWorkRunning();
        }
        if (!adapted) {
          close(live);
          live = undefined;
        }
      }
      const reused = live !== undefined;
      let session = live ?? open(threadId, key, launch, attach, false, inherit);
      session.leasedBy = self;
      if (!reused) enforceCap();
      try {
        await session.ready;
      } catch (error) {
        close(session);
        if (!(error instanceof BypassRefused) || session.leasedBy !== self) throw error;
        options.log?.("claude code did not switch to full access, starting it in it", {
          threadId,
          error: String(error.cause),
        });
        session = open(threadId, key, launch, attach, true, inherit);
        session.leasedBy = self;
        try {
          await session.ready;
        } catch (failed) {
          close(session);
          throw failed;
        }
      }
      // A later turn of the thread came while its servers were registered: it wins.
      if (session.leasedBy !== self) throw new SessionTakenOver();

      const received = queue<SDKMessage>();
      let failure: { error: unknown } | undefined;
      const holder: Holder = {
        canUseTool: launch.canUseTool,
        push: (sent) => received.push(sent),
        end: (error) => {
          failure ??= error;
          received.end();
        },
      };
      // Holding before the message goes in: nothing Claude Code answers is missed.
      session.holder = holder;
      if (session.closed) holder.end();
      else session.input.push(message);

      let released = false;
      let stopping = false;
      /** Its first own frame came. */
      let begun = false;
      /** The interrupt came before Claude Code took the message: stop it once it starts (D350). */
      let interruptOnStart = false;
      /** The turn's messages ended: it takes no steer any more. */
      let ended = false;
      /** The uuids of the messages steered into the turn, oldest first. */
      const steers: string[] = [];
      /** The last result passed over because a steer goes on after it. */
      let passed: SDKMessage | undefined;
      /** The turn's subagents running in the foreground, by the tool call that started each. */
      const foreground = new Set<string>();
      /** Moves to the background asked of Claude Code: once per tool call, later steers wait on it. */
      const moves = new Map<string, Promise<void>>();
      /** The moves Claude Code answered. */
      const answered = new Set<string>();
      /** Moves still unanswered after a steer's wait: later steers do not wait on them again. */
      const unanswered = new Set<string>();
      const ours = (stamp: readonly string[]) =>
        (uuid !== undefined && stamp.includes(uuid)) ||
        steers.some((steer) => stamp.includes(steer));
      /** Ended on an idle report: nothing of the turn is left in flight. */
      let wentIdle = false;
      const uuid = message.uuid;
      const settledAtLease = session.settled;
      return {
        reused,
        messages: (async function* () {
          // Until the turn's own frames come, what Claude Code sends belongs elsewhere: an
          // earlier turn's (a message an interrupt did not stop still runs, and ends with a
          // result of its own) or Claude Code's own (a continuation after background work,
          // which marks nothing). Without marks (an older CLI) every frame is the turn's.
          /** Unmarked frames since the last unmarked init: the turn's, if Claude Code never marks it. */
          let unmarked: SDKMessage[] = [];
          /** An idle report counts once it cannot be the one before this message went in. */
          let idleCounts = settledAtLease;
          for await (const sent of received.read()) {
            if (!begun) {
              const stamp = stampOf(sent);
              const state = stateOf(sent);
              if (stamp === undefined ? !session.stamps : ours(stamp)) {
                begun = true;
                if (interruptOnStart) {
                  interruptOnStart = false;
                  void session.query.interrupt().catch(() => undefined);
                }
              } else if (stamp !== undefined) {
                unmarked = [];
                continue;
              } else if (state !== undefined) {
                if (state === "running") idleCounts = true;
                // Idle with nothing marked as this turn's: Claude Code took the message and
                // marked none of its frames, or it never answered. A stopped turn ends here too.
                if (state === "idle" && (idleCounts || stopping)) {
                  wentIdle = true;
                  if (unmarked.at(-1)?.type === "result") {
                    ended = true;
                    yield* unmarked;
                    return;
                  }
                  if (stopping) return;
                  throw new NoAnswer();
                }
                continue;
              } else {
                if (sent.type === "system" && sent.subtype === "init") unmarked = [sent];
                else unmarked.push(sent);
                // Without idle reports an unmarked result is the only end in sight.
                if (sent.type === "result" && (!session.reportsState || stopping)) {
                  ended = true;
                  yield* unmarked;
                  return;
                }
                continue;
              }
            }
            trackForegroundSubagents(sent, foreground);
            // A result passed over for a steer, then idle with nothing more: Claude Code
            // has nothing left to say for the turn, which ends with that result.
            if (passed !== undefined && stateOf(sent) === "idle") {
              ended = true;
              steeredAway.add(passed);
              yield passed;
              return;
            }
            if (sent.type === "result") {
              // Claude Code stopped to take a steer: the turn goes on with it.
              if (steers.length > 0 && !stopping && isSteerAbort(sent)) {
                passed = sent;
                continue;
              }
              // Answered before Claude Code took the last steer, which it answers next.
              const stamp = stampOf(sent);
              const last = steers.at(-1);
              if (last !== undefined && !stopping && stamp !== undefined && !stamp.includes(last)) {
                passed = sent;
                continue;
              }
              ended = true;
              yield sent;
              return;
            }
            if (stateOf(sent) === undefined) passed = undefined;
            yield sent;
          }
          ended = true;
          if (failure !== undefined) throw failure.error;
        })(),
        steer: (sent) => {
          if (ended || released || session.closed) {
            throw new LeaseEnded();
          }
          if (sent.uuid !== undefined) steers.push(sent.uuid);
          session.input.push({ ...sent, priority: "now" });
        },
        backgroundSubagents: async () => {
          const query = session.query;
          if (query.backgroundTasks === undefined || ended || foreground.size === 0) return;
          // A move Claude Code left unanswered past the wait holds no later steer.
          const asked = [...foreground].filter((toolUseId) => !unanswered.has(toolUseId));
          const waits = asked.map((toolUseId) => {
            let move = moves.get(toolUseId);
            if (move === undefined) {
              // A throw as well as a rejection is a refusal: the steer goes in regardless.
              move = Promise.resolve()
                .then(() => query.backgroundTasks!(toolUseId))
                .then(
                  (moved) => {
                    unanswered.delete(toolUseId);
                    if (moved) foreground.delete(toolUseId);
                  },
                  (error: unknown) =>
                    options.log?.("claude code did not move a subagent to the background", {
                      threadId,
                      toolUseId,
                      error: String(error),
                    }),
                );
              move = move.finally(() => answered.add(toolUseId));
              moves.set(toolUseId, move);
            }
            return move;
          });
          // Claude Code may never answer: the steer goes in after a while regardless.
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.all(waits),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, BACKGROUND_MOVE_MS);
            }),
          ]);
          clearTimeout(timer);
          for (const toolUseId of asked) if (!answered.has(toolUseId)) unanswered.add(toolUseId);
        },
        interrupt: async () => {
          stopping = true;
          const receipt = (await session.query.interrupt()) as
            | { still_queued?: readonly string[] }
            | undefined;
          // Still queued: it will run, so it is stopped again as soon as it starts, or now
          // when its first frame came before the receipt.
          if (uuid !== undefined && receipt?.still_queued?.includes(uuid) === true) {
            // Not once the turn let go: the session may run a later turn's message by then.
            if (released) return receipt;
            if (begun) void session.query.interrupt().catch(() => undefined);
            else interruptOnStart = true;
          }
          return receipt;
        },
        release(keep) {
          if (released) return;
          released = true;
          interruptOnStart = false;
          // The turn reads no more: its messages end, also when it lets go mid-turn.
          holder.end();
          if (session.holder === holder) session.holder = undefined;
          session.busy = false;
          const policy = options.keepAlive();
          if (!(keep || wentIdle) || session.closed) return close(session);
          session.idleSince = new Date();
          if (!policy.keepAlive) {
            // Per turn, but its background work goes on: it ends once the work does (D348).
            if (session.background === 0) return close(session);
            session.closeWhenDone = true;
            return;
          }
          arm(session, policy.idleMs);
        },
      };
    },
    close(threadId, force = false) {
      const live = sessions.get(threadId);
      if (live === undefined || ((live.busy || live.background > 0) && !force)) return false;
      close(live);
      return true;
    },
    rearmIdle() {
      const { idleMs } = options.keepAlive();
      for (const live of sessions.values()) if (!live.busy) arm(live, idleMs);
    },
    closeIdle() {
      let closed = 0;
      for (const live of sessions.values()) {
        if (live.busy) continue;
        // Its background work goes on; it ends with it (D348).
        if (live.background > 0) {
          live.closeWhenDone = true;
          continue;
        }
        close(live);
        closed++;
      }
      return closed;
    },
    ended: async (threadId) => {
      await Promise.all(exits.get(threadId) ?? []);
    },
    list: () =>
      [...sessions.values()].map((live) => ({
        threadId: live.threadId,
        ...(live.model === undefined ? {} : { model: live.model }),
        ...(live.permissionMode === undefined ? {} : { permissionMode: live.permissionMode }),
        busy: live.busy,
        ...(live.idleSince === undefined ? {} : { idleSince: live.idleSince.toISOString() }),
        background: live.background,
      })),
    dispose() {
      // Closing deletes from the map: safe while iterating it.
      for (const live of sessions.values()) close(live);
    },
  };
}
