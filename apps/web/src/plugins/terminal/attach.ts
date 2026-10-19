import type { RpcClient } from "@jhin/rpc";
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
  /** Output of the process; `replay` for what it printed before this client attached. */
  write(data: string, replay: boolean): void;
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

  /** The session as the node has it, or undefined when it has none under these ids. */
  async function readSnapshot(): Promise<TerminalSnapshot | undefined> {
    try {
      return await client.call<TerminalSnapshot>("terminals.get", { threadId, terminalId });
    } catch (error) {
      if ((error as { code?: unknown }).code === "TERMINAL_NOT_FOUND") return undefined;
      throw error;
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
      const found = await readSnapshot();
      if (found !== undefined) {
        snapshot = found;
      } else {
        await client.call<TerminalSummary>("terminals.open", {
          threadId,
          terminalId,
          cwd: options.cwd,
          ...options.size(),
        });
        snapshot = await client.call<TerminalSnapshot>("terminals.get", { threadId, terminalId });
      }
    } catch (error) {
      if (!stale()) sink.system((error as Error).message);
      return;
    }
    if (stale()) return;
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
        onError: (error) => {
          if (!stale()) sink.system(error.message);
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
            sink.write((event.payload as { data: string }).data, false);
            break;
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

  let wasOpen = client.state === "open";
  const state = client.onState((next) => {
    const reopened = next === "open" && !wasOpen;
    wasOpen = next === "open";
    // Typing waits while the connection is away, then for the terminal to open again.
    if (next !== "open") attached = false;
    if (reopened && !disposed && !ended) void attach();
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
