// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: one live query
// per native thread fed through a prompt queue (ClaudeAgentSdkQueryRunner.open), reused for
// the next turn when its launch options match (claudeEffectiveQueryPolicyKey, openQuery),
// the model and permission mode applied to it live (setModel, setPermissionMode, including
// the mode Claude switched to by itself), replaced otherwise; and ProviderSessionManager's
// release of an idle session. T3's continuation turns, wake buffers and background-work
// guards are not ported.
import type {
  CanUseTool,
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
}

/** One turn's hold on its thread's Claude Code: its message went in, its messages come out. */
export interface Lease {
  /** The turn's messages up to its result; they end early when Claude Code exits. */
  readonly messages: AsyncIterable<SDKMessage>;
  /** Whether Claude Code was already running for an earlier turn. */
  readonly reused: boolean;
  interrupt(): Promise<unknown>;
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
  }): Promise<Lease>;
  /** Ends a thread's live session, if any; a turn holding it ends too. */
  close(threadId: string): boolean;
  list(): LiveSessionInfo[];
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
  /** As Claude Code last reported it: Claude can switch it by itself (plan mode). */
  permissionMode: PermissionMode | undefined;
  /** Taken by a turn, from its lease until its release. */
  busy: boolean;
  holder: Holder | undefined;
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
    ...launch
  } = options;
  return JSON.stringify(launch);
}

/** The longest delay setTimeout takes. */
const MAX_TIMER = 2 ** 31 - 1;

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

  const close = (live: Live) => {
    if (live.closed) return;
    live.closed = true;
    clearTimeout(live.timer);
    if (sessions.get(live.threadId) === live) sessions.delete(live.threadId);
    live.input.end();
    live.holder?.end();
    try {
      live.query.close();
    } catch (error) {
      options.log?.("could not close claude code", {
        threadId: live.threadId,
        error: String(error),
      });
    }
  };

  const open = (threadId: string, key: string, launch: Options): Live => {
    // At most one Claude Code per thread: a lease that raced this one (two turns of a
    // thread at once) loses its session rather than leaving it out of reach.
    const existing = sessions.get(threadId);
    if (existing !== undefined) close(existing);
    const input = queue<SDKUserMessage>();
    let live!: Live;
    const query = options.query({
      prompt: input.read(),
      options: {
        ...launch,
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
      permissionMode: launch.permissionMode,
      busy: true,
      holder: undefined,
      idleSince: undefined,
      timer: undefined,
      closed: false,
    };
    sessions.set(threadId, live);
    // One reader per process, for its whole life: what Claude Code sends between turns is
    // dropped, and an exit while idle closes the session, so the next turn resumes.
    void (async () => {
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
    return live;
  };

  /** Puts the turn's model and mode on a running session; false when it cannot. */
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
    async lease({ threadId, options: launch, message }) {
      const key = launchKey(launch);
      let live = sessions.get(threadId);
      if (live !== undefined && (live.closed || live.busy || live.key !== key)) {
        close(live);
        live = undefined;
      }
      if (live !== undefined) {
        live.busy = true;
        clearTimeout(live.timer);
        live.timer = undefined;
        live.idleSince = undefined;
        if (!(await adapt(live, launch))) {
          close(live);
          live = undefined;
        }
      }
      const reused = live !== undefined;
      const session = live ?? open(threadId, key, launch);

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
      return {
        reused,
        messages: (async function* () {
          for await (const sent of received.read()) {
            yield sent;
            if (sent.type === "result") return;
          }
          if (failure !== undefined) throw failure.error;
        })(),
        interrupt: () => session.query.interrupt(),
        release(keep) {
          if (released) return;
          released = true;
          // The turn reads no more: its messages end, also when it lets go mid-turn.
          holder.end();
          if (session.holder === holder) session.holder = undefined;
          session.busy = false;
          const policy = options.keepAlive();
          if (!keep || !policy.keepAlive || session.closed) return close(session);
          session.idleSince = new Date();
          if (policy.idleMs > 0) {
            // setTimeout fires at once past its limit (about 24.8 days): that is the most.
            session.timer = setTimeout(() => close(session), Math.min(policy.idleMs, MAX_TIMER));
            session.timer.unref?.();
          }
        },
      };
    },
    close(threadId) {
      const live = sessions.get(threadId);
      if (live === undefined) return false;
      close(live);
      return true;
    },
    list: () =>
      [...sessions.values()].map((live) => ({
        threadId: live.threadId,
        ...(live.model === undefined ? {} : { model: live.model }),
        ...(live.permissionMode === undefined ? {} : { permissionMode: live.permissionMode }),
        busy: live.busy,
        ...(live.idleSince === undefined ? {} : { idleSince: live.idleSince.toISOString() }),
      })),
    dispose() {
      // Closing deletes from the map: safe while iterating it.
      for (const live of sessions.values()) close(live);
    },
  };
}
