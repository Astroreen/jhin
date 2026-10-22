import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * The CSI queries xterm answers with input of its own (as if typed): device
 * status and attributes, mode reports and version. Each of these sequences
 * is only a query, so taking it whole loses nothing. XTWINOPS (`CSI … t`) is
 * not here: the same final byte also resizes and keeps the title stack, and
 * this xterm does not answer its reports (they are off by default).
 */
const CSI_QUERIES = [
  { final: "n" }, // DSR: status, cursor position (CPR)
  { prefix: "?", final: "n" }, // DEC DSR
  { final: "c" }, // DA1
  { prefix: ">", final: "c" }, // DA2
  { prefix: "=", final: "c" }, // DA3
  { intermediates: "$", final: "p" }, // DECRQM
  { prefix: "?", intermediates: "$", final: "p" }, // DECRQM, DEC modes
  { prefix: ">", final: "q" }, // XTVERSION
] as const;

/** Colour sequences, which may set and query in one: `OSC 4 ; 1 ; rgb:… ; 2 ; ?`. */
const COLOR_SEQUENCES = [4, 10, 11, 12] as const;

export interface ReplayMute extends IDisposable {
  /** Whether data xterm emits now is its reply to a replayed query, not typing. */
  isReply(): boolean;
}

/**
 * Keeps xterm from answering queries in output it replays: the answers were
 * meant for a program long gone and would reach the shell as typing. Only
 * the answers are muted, while `replaying()` says a replay is being parsed;
 * what the user types is never touched, and what a replayed sequence sets
 * still applies.
 */
export function muteRepliesWhileReplaying(
  terminal: Terminal,
  replaying: () => boolean,
): ReplayMute {
  let replyDue = false;
  /** Takes a pure query while replaying; past the replay, a live query's reply is never muted. */
  const takeQuery = () => {
    if (replaying()) return true;
    replyDue = false;
    return false;
  };
  // A handler that returns true takes the sequence, so xterm's own (the reply) does not run.
  const handlers: IDisposable[] = [
    ...CSI_QUERIES.map((id) => terminal.parser.registerCsiHandler(id, takeQuery)),
    terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, takeQuery),
    // A colour sequence is left to xterm, which applies its sets in place, and
    // only its reply is dropped. xterm emits that reply at once, in the task
    // that parses the sequence; typing never comes in the same task, so the
    // mark is cleared as soon as that task is over.
    ...COLOR_SEQUENCES.map((code) =>
      terminal.parser.registerOscHandler(code, (data) => {
        const asks = data.split(";").includes("?");
        if (!replaying() || !asks) {
          // Live (or only setting): its reply, if any, is meant for the shell.
          replyDue = false;
        } else if (!replyDue) {
          replyDue = true;
          queueMicrotask(() => {
            replyDue = false;
          });
        }
        return false;
      }),
    ),
  ];
  return {
    isReply: () => replyDue,
    dispose() {
      for (const handler of handlers) handler.dispose();
    },
  };
}
