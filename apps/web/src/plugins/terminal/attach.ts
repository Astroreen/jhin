import type { RpcClient } from "@jhin/rpc";

/** T3's output window: at most this much output is on its way to a terminal (D470). */
export const TERMINAL_OUTPUT_WINDOW = { events: 8, bytes: 64 * 1024 };
import type { Disposable } from "@jhin/sdk";
import {
  TerminalEvents,
  terminalStream,
  type TerminalSnapshot,
  type TerminalSummary,
} from "@jhin/terminal-api";

/** Where an attached terminal's output goes: an xterm.js instance, or a test's record. */
export interface TerminalSink {
  /** Clears the screen: a new process starts, or the session is read again. */
  reset(): void;
  /**
   * Output of the process; `replay` for what it printed before this client
   * attached. A promise says when it is shown: the node sends more output
   * as it is (D470).
   */
  write(data: string, replay: boolean): void | Promise<void>;
  /** A line of T3's `[terminal] …` messages. */
  system(message: string): void;
  /** The process exited, or the session was closed. */
  ended(reason: "exited" | "closed"): void;
}

/**
 * Follows one terminal of a node: reads it, or opens it (starting its shell)
 * when the node has none under these ids, shows what it still keeps, then
 * streams the rest. A session whose shell already exited ends at once. When the
 * connection comes back it does all that again, since the node may have
 * restarted and the session with it.
 */
export function attachTerminal(options: {
  readonly client: RpcClient;
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly size: () => { cols: number; rows: number };
  readonly sink: TerminalSink;
  /**
   * Starts a new shell for a session whose shell exited, instead of ending
   * there (T3's `restartIfNotRunning`, D463). The drawer does not: an exited
   * shell ends its tab, as in T3's web client.
   */
  readonly restartIfNotRunning?: boolean;
  /** The terminal's own variables (D462), for every shell this attach starts. */
  readonly env?: Readonly<Record<string, string>>;
}): Disposable & {
  /**
   * Types into the terminal. What is typed before the terminal is open (its
   * shell still starting, the connection coming back) waits and goes then.
   */
  write(data: string): void;
} {
  const { client, threadId, terminalId, sink } = options;
  let disposed = false;
  let ended = false;
  let subscription: Disposable | undefined;
  let attempt = 0;
  /** Open and followed: typing goes straight to the node. */
  let attached = false;
  let typed: string[] = [];
  /**
   * The run of the node's terminals this session was seen in, once one
   * attach succeeded: a later attach that finds no session tells from it
   * whether the session was closed meanwhile (same run) or the node started
   * over (another run, or none reported).
   */
  let seenIn: string | undefined;

  const send = (data: string) =>
    void client
      .call("terminals.write", { threadId, terminalId, data })
      .catch((error: unknown) => sink.system((error as Error).message));

  const end = (reason: "exited" | "closed") => {
    if (ended) return;
    ended = true;
    sink.system(reason === "closed" ? "Terminal closed" : "Process exited");
    sink.ended(reason);
  };

  /** The session as the node has it, or the run that has no session under these ids. */
  async function readSnapshot(): Promise<
    { found: TerminalSnapshot } | { missing: { instance: string | undefined } }
  > {
    try {
      return {
        found: await client.call<TerminalSnapshot>("terminals.get", { threadId, terminalId }),
      };
    } catch (error) {
      const failure = error as { code?: unknown; details?: { instance?: unknown } };
      if (failure.code !== "TERMINAL_NOT_FOUND") throw error;
      const instance = failure.details?.instance;
      return { missing: { instance: typeof instance === "string" ? instance : undefined } };
    }
  }

  async function attach(): Promise<void> {
    const current = ++attempt;
    attached = false;
    subscription?.dispose();
    subscription = undefined;
    const stale = () => disposed || current !== attempt;
    let snapshot: TerminalSnapshot;
    try {
      // Read first: a session whose shell ended while nobody watched ends its
      // tab, it is not started again; only a terminal the node lacks is opened.
      const read = await readSnapshot();
      if ("found" in read && read.found.status === "exited" && options.restartIfNotRunning) {
        // `terminals.open` starts a new shell for a session whose shell exited.
        await client.call<TerminalSummary>("terminals.open", {
          threadId,
          terminalId,
          cwd: options.cwd,
          ...options.size(),
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        snapshot = await client.call<TerminalSnapshot>("terminals.get", { threadId, terminalId });
      } else if ("found" in read) {
        snapshot = read.found;
      } else if (seenIn !== undefined && read.missing.instance === seenIn) {
        // Gone while the connection was away, in the same run of the node's
        // terminals: closed elsewhere. Only a first attach, or one after the
        // node started over, opens a shell.
        if (!stale()) end("closed");
        return;
      } else {
        await client.call<TerminalSummary>("terminals.open", {
          threadId,
          terminalId,
          cwd: options.cwd,
          ...options.size(),
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        snapshot = await client.call<TerminalSnapshot>("terminals.get", { threadId, terminalId });
      }
    } catch (error) {
      if (!stale()) sink.system((error as Error).message);
      return;
    }
    if (stale()) return;
    seenIn = snapshot.instance;
    sink.reset();
    if (snapshot.history.length > 0) sink.write(snapshot.history, true);
    if (snapshot.status === "exited") {
      end("exited");
      return;
    }
    subscription = client.subscribe(
      terminalStream(threadId, terminalId),
      {
        after: snapshot.sequence,
        window: TERMINAL_OUTPUT_WINDOW,
        onError: (error) => {
          if (stale()) return;
          // Too far behind the output: read the terminal again from what it keeps.
          if (error.code === "SUBSCRIPTION_OVERFLOW") void attach();
          else sink.system(error.message);
        },
      },
      (event) => {
        if (stale() || ended) return;
        switch (event.type) {
          case TerminalEvents.started:
            // Another process under the same ids: what was on screen was the old one's.
            sink.reset();
            break;
          case TerminalEvents.output:
            return sink.write((event.payload as { data: string }).data, false);
          case TerminalEvents.exited:
            end("exited");
            break;
          case TerminalEvents.closed:
            end("closed");
            break;
        }
      },
    );
    attached = true;
    const waiting = typed;
    typed = [];
    if (waiting.length > 0) send(waiting.join(""));
  }

  // The first attach waits for the connection by itself; a later one follows
  // a connection that was open, went away and came back.
  let wasOpen = client.state === "open";
  let lost = false;
  const state = client.onState((next) => {
    if (next !== "open") {
      // Typing waits while the connection is away, then for the terminal to open again.
      attached = false;
      if (wasOpen) lost = true;
      wasOpen = false;
      return;
    }
    wasOpen = true;
    if (!lost || disposed || ended) return;
    lost = false;
    void attach();
  });
  void attach();

  return {
    write(data) {
      if (disposed || ended) return;
      if (attached) send(data);
      else typed.push(data);
    },
    dispose() {
      disposed = true;
      subscription?.dispose();
      state.dispose();
    },
  };
}
