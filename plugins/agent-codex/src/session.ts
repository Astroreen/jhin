// A thread's `codex app-server`, kept running between its turns (D311). T3 Code keeps an
// app-server per provider session and releases idle ones (ProviderSessionManager at
// eb7b35ac); Jhin keeps one per thread, as its Claude Code live sessions do.
import {
  CodexEnded,
  initialize,
  launchAppServer,
  type AppServerConnection,
  type LaunchOptions,
} from "./rpc.ts";

/** The node's MCP server for one app-server: its config, and its credential's revocation. */
export interface McpAttachment {
  readonly servers: Readonly<Record<string, unknown>>;
  dispose(): void;
}

/** Starts an app-server; `launchAppServer` unless a test replaces it. */
export type Launcher = (
  options: LaunchOptions & {
    readonly log?: (message: string, data?: Record<string, unknown>) => void;
  },
) => AppServerConnection;

/** Reported to the turn that held a thread's app-server when a later turn took it over. */
export class SessionTakenOver extends Error {
  constructor() {
    super("A later turn of this thread took its Codex over.");
  }
}

/** The turn that holds an app-server: it gets what Codex sends while it holds it. */
interface Holder {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  /** The app-server ended (exited, closed, taken over) while the turn held it. */
  end(error: Error): void;
}

interface Session {
  readonly threadId: string;
  readonly connection: AppServerConnection;
  /** The Codex thread this process started or resumed; a new process has none yet. */
  codexThreadId: string | undefined;
  /** Kinds of request accepted for the rest of the session (T3's session allowance). */
  readonly allowed: Set<string>;
  model: string | undefined;
  /** A message of the thread reached `codexThreadId` (its turn/start answered). */
  delivered: boolean;
  /**
   * The node's MCP server for this app-server (D889): `thread/start`'s and `thread/resume`'s
   * `mcp_servers`, with a credential revoked when the app-server ends.
   */
  mcpServers?: Readonly<Record<string, unknown>>;
}

export interface Lease {
  readonly session: Session;
  /** Whether the app-server was started for this lease. */
  readonly started: boolean;
  hold(holder: Holder): void;
  /** Lets go of the app-server: kept for the thread's next turn, or ended. */
  release(keep: boolean): void;
}

interface SessionInfo {
  readonly threadId: string;
  readonly model?: string;
  readonly busy: boolean;
  readonly idleSince?: string;
}

export interface Sessions {
  /** `key`: what a running app-server cannot change; all of `launch` when absent. */
  lease(
    threadId: string,
    launch: LaunchOptions & {
      readonly version: string;
      readonly key?: string;
      /** Called once for a new app-server; revoked when it is closed or exits (D889). */
      readonly mcp?: () => McpAttachment;
    },
  ): Promise<Lease>;
  /** Ends a thread's app-server unless a turn holds it (or `force`); whether one ended. */
  close(threadId: string, force?: boolean): boolean;
  closeIdle(): number;
  rearmIdle(): void;
  list(): SessionInfo[];
  /** Ends every app-server of the node, busy or not; how many there were. */
  closeAll(): number;
  dispose(): void;
}

/** setTimeout fires at once past this (about 24.8 days). */
const MAX_TIMER = 2 ** 31 - 1;

interface Live extends Session {
  readonly key: string;
  busy: boolean;
  holder: Holder | undefined;
  idleSince: Date | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /** A later lease of the thread ended it. */
  takenOver: boolean;
  /** Revokes the app-server's MCP credential; does nothing the second time. */
  revoke: () => void;
}

export function createSessions(options: {
  readonly launch?: Launcher;
  /** Milliseconds an idle app-server stays up; 0 keeps it until something else ends it. */
  readonly idleMs: () => number;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}): Sessions {
  const launch = options.launch ?? launchAppServer;
  const sessions = new Map<string, Live>();

  const close = (live: Live, reason?: Error) => {
    if (live.closed) return;
    live.closed = true;
    live.revoke();
    clearTimeout(live.timer);
    if (sessions.get(live.threadId) === live) sessions.delete(live.threadId);
    const holder = live.holder;
    live.holder = undefined;
    live.connection.close();
    holder?.end(reason ?? new CodexEnded("Codex was ended while the turn was running."));
  };

  const arm = (live: Live) => {
    clearTimeout(live.timer);
    live.timer = undefined;
    const idleMs = options.idleMs();
    if (idleMs <= 0 || live.idleSince === undefined) return;
    const deadline = live.idleSince.getTime() + idleMs;
    // A wait longer than one timer goes in steps up to its deadline.
    const wait = () => {
      const left = Math.max(0, deadline - Date.now());
      live.timer = setTimeout(
        () => (left > MAX_TIMER ? wait() : close(live)),
        Math.min(left, MAX_TIMER),
      );
      live.timer.unref?.();
    };
    wait();
  };

  const open = (
    threadId: string,
    key: string,
    launchOptions: LaunchOptions,
    mcp: (() => McpAttachment) | undefined,
  ): Live => {
    const connection = launch({
      ...launchOptions,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    // The credential belongs to this process: issued with it, revoked when it ends.
    const attachment = mcp?.();
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      attachment?.dispose();
    };
    const live: Live = {
      threadId,
      key,
      connection,
      codexThreadId: undefined,
      allowed: new Set(),
      model: undefined,
      delivered: false,
      busy: true,
      holder: undefined,
      idleSince: undefined,
      timer: undefined,
      closed: false,
      takenOver: false,
      revoke,
      ...(attachment === undefined ? {} : { mcpServers: attachment.servers }),
    };
    connection.onNotification((method, params) => live.holder?.notification(method, params));
    connection.onRequest((method, params) =>
      live.holder === undefined
        ? Promise.reject(new Error("No turn of this thread is running."))
        : live.holder.request(method, params),
    );
    void connection.exited.then((exit) => {
      revoke();
      if (live.closed) return;
      if (live.holder === undefined) {
        options.log?.("codex exited while idle", { threadId, code: exit.code });
      }
      close(
        live,
        exit.error ??
          new Error(
            `Codex exited while the turn was running.${
              connection.stderr() === "" ? "" : `\n${connection.stderr()}`
            }`,
          ),
      );
    });
    sessions.set(threadId, live);
    return live;
  };

  return {
    async lease(threadId, { version, key: given, mcp, ...launchOptions }) {
      const key = given ?? JSON.stringify(launchOptions);
      const existing = sessions.get(threadId);
      if (existing !== undefined) {
        // A busy one belongs to a turn given up on: the newest turn wins.
        if (existing.busy) {
          existing.takenOver = true;
          close(existing, new SessionTakenOver());
        } else if (existing.key !== key) close(existing);
      }
      let live = sessions.get(threadId);
      const started = live === undefined;
      if (live === undefined) {
        live = open(threadId, key, launchOptions, mcp);
        try {
          await initialize(live.connection, version);
        } catch (error) {
          // Ended by a later lease while it started: that turn took it over. Anything else
          // (no such binary, a crash) is the error itself.
          if (live.takenOver) throw new SessionTakenOver();
          close(live);
          throw error;
        }
        if (live.closed) {
          throw live.takenOver
            ? new SessionTakenOver()
            : new CodexEnded("Codex was ended while it started.");
        }
      }
      clearTimeout(live.timer);
      live.timer = undefined;
      live.busy = true;
      live.idleSince = undefined;
      const held = live;
      let released = false;
      return {
        session: held,
        started,
        hold(holder) {
          held.holder = holder;
        },
        release(keep) {
          if (released) return;
          released = true;
          if (held.closed) return;
          held.holder = undefined;
          held.busy = false;
          if (!keep || !held.connection.running) {
            close(held);
            return;
          }
          held.idleSince = new Date();
          arm(held);
        },
      };
    },
    close(threadId, force = false) {
      const live = sessions.get(threadId);
      if (live === undefined || (live.busy && !force)) return false;
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
    rearmIdle() {
      for (const live of sessions.values()) if (!live.busy) arm(live);
    },
    list: () =>
      [...sessions.values()].map((live) => ({
        threadId: live.threadId,
        ...(live.model === undefined ? {} : { model: live.model }),
        busy: live.busy,
        ...(live.idleSince === undefined ? {} : { idleSince: live.idleSince.toISOString() }),
      })),
    closeAll() {
      let closed = 0;
      for (const live of sessions.values()) {
        close(live);
        closed++;
      }
      return closed;
    },
    dispose() {
      for (const live of sessions.values()) close(live);
    },
  };
}
