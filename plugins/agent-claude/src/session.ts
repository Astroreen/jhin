// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: one live query
// per native thread fed through a prompt queue (ClaudeAgentSdkQueryRunner.open), reused for
// the next turn when its launch options match (claudeEffectiveQueryPolicyKey, openQuery),
// the model and permission mode applied to it live (setModel, setPermissionMode, including
// the mode Claude switched to by itself), replaced otherwise; messages bound to the turn
// whose prompt they answer by its uuid (T3's prompt uuids and echo tracking); and
// ProviderSessionManager's release of an idle session. T3's continuation turns, wake
// buffers and background-work guards are not ported.
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
  /** Ends every live session no turn holds; held ones end with their turn's release. */
  closeIdle(): number;
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

/** Ends a turn whose message Claude Code took without answering it (nothing marked as its). */
class NoAnswer extends Error {
  constructor() {
    super("Claude Code finished without answering the turn's message.");
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
  /** The latest lease of each thread: an earlier one still on its way gives up. */
  const latest = new Map<string, object>();

  const close = (live: Live, reason?: Error) => {
    if (live.closed) return;
    live.closed = true;
    clearTimeout(live.timer);
    if (sessions.get(live.threadId) === live) sessions.delete(live.threadId);
    live.input.end();
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

  const open = (threadId: string, key: string, launch: Options): Live => {
    // At most one Claude Code per thread, so none is ever out of reach.
    const existing = sessions.get(threadId);
    if (existing !== undefined) close(existing, new SessionTakenOver());
    const input = queue<SDKUserMessage>();
    let live!: Live;
    const query = options.query({
      prompt: input.read(),
      options: {
        ...launch,
        // Running and idle reports: idle is Claude Code's own word that it took every
        // message, the way out for a turn whose frames it does not mark (D104).
        env: { ...(launch.env ?? process.env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
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
      stamps: false,
      reportsState: false,
      settled: false,
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
          if (!live.stamps && stampOf(message) !== undefined) live.stamps = true;
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
      const self = {};
      latest.set(threadId, self);
      let live = sessions.get(threadId);
      // Busy means its turn was given up on: the threads plugin runs one turn of a thread
      // at a time and frees the thread only once a turn ended, or once a stop stopped
      // waiting for a turn that ignored its interrupt. The newer turn takes Claude Code
      // over; the turn still holding it ends (D98).
      if (live?.busy === true) {
        close(live, new SessionTakenOver());
        live = undefined;
      } else if (live !== undefined && (live.closed || live.key !== key)) {
        close(live);
        live = undefined;
      }
      if (live !== undefined) {
        live.busy = true;
        clearTimeout(live.timer);
        live.timer = undefined;
        live.idleSince = undefined;
        const adapted = await adapt(live, launch);
        // A later turn of the thread came meanwhile and took the session: it wins.
        if (latest.get(threadId) !== self) throw new SessionTakenOver();
        if (!adapted) {
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
      let stopping = false;
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
          let begun = false;
          /** Unmarked frames since the last unmarked init: the turn's, if Claude Code never marks it. */
          let unmarked: SDKMessage[] = [];
          /** An idle report counts once it cannot be the one before this message went in. */
          let idleCounts = settledAtLease;
          for await (const sent of received.read()) {
            if (!begun) {
              const stamp = stampOf(sent);
              const state = stateOf(sent);
              if (
                stamp === undefined ? !session.stamps : uuid !== undefined && stamp.includes(uuid)
              ) {
                begun = true;
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
                  yield* unmarked;
                  return;
                }
                continue;
              }
            }
            yield sent;
            if (sent.type === "result") return;
          }
          if (failure !== undefined) throw failure.error;
        })(),
        interrupt: () => {
          stopping = true;
          return session.query.interrupt();
        },
        release(keep) {
          if (released) return;
          released = true;
          // The turn reads no more: its messages end, also when it lets go mid-turn.
          holder.end();
          if (session.holder === holder) session.holder = undefined;
          session.busy = false;
          const policy = options.keepAlive();
          if (!(keep || wentIdle) || !policy.keepAlive || session.closed) return close(session);
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
    closeIdle() {
      let closed = 0;
      for (const live of sessions.values()) {
        if (live.busy) continue;
        close(live);
        closed++;
      }
      return closed;
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
