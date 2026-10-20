import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * The queries xterm answers with input of its own (as if typed): device
 * status and attributes, window and mode reports, settings and version, and
 * colour queries.
 */
const CSI_QUERIES = [
  { final: "n" }, // DSR: status, cursor position (CPR)
  { prefix: "?", final: "n" }, // DEC DSR
  { final: "c" }, // DA1
  { prefix: ">", final: "c" }, // DA2
  { prefix: "=", final: "c" }, // DA3
  { final: "t" }, // window reports (XTWINOPS)
  { intermediates: "$", final: "p" }, // DECRQM
  { prefix: "?", intermediates: "$", final: "p" }, // DECRQM, DEC modes
  { prefix: ">", final: "q" }, // XTVERSION
] as const;
const COLOR_QUERIES = [4, 10, 11, 12, 17, 19] as const;

/**
 * Keeps xterm from answering queries in output it replays: the answers were
 * meant for a program long gone and would reach the shell as typing. Only
 * the answers are muted, while `replaying()` says a replay is being parsed;
 * what the user types is never touched.
 */
export function muteRepliesWhileReplaying(
  terminal: Terminal,
  replaying: () => boolean,
): IDisposable {
  // A handler that returns true takes the sequence, so xterm's own (the reply) does not run.
  const handlers: IDisposable[] = [
    ...CSI_QUERIES.map((id) => terminal.parser.registerCsiHandler(id, () => replaying())),
    terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => replaying()),
    ...COLOR_QUERIES.map((code) =>
      terminal.parser.registerOscHandler(code, (data) => replaying() && data.includes("?")),
    ),
  ];
  return {
    dispose() {
      for (const handler of handlers) handler.dispose();
    },
  };
}
