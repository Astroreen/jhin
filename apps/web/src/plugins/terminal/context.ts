// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/terminalContext.ts and
// packages/shared/src/composerContextLegacySend.ts (the inline label and the
// `<terminal_context>` block T3 sends to agents that do not read inline contexts).
import { terminalContextRecord } from "../../lib/composer-context.ts";

/** What "Add to chat" takes from a terminal: its selected lines (1-based, in the buffer). */
export interface TerminalContextSelection {
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * The selection's buffer rows as 1-based lines (T3's terminalSelectionLineRange):
 * from its start row to its end row, wrapped rows included.
 */
export function terminalSelectionLines(position: { start: { y: number }; end: { y: number } }): {
  lineStart: number;
  lineEnd: number;
} {
  const lineStart = position.start.y + 1;
  return { lineStart, lineEnd: Math.max(lineStart, position.end.y + 1) };
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `  ${line}`))
    .join("\n");
}

/**
 * What goes into the composer: T3's inline label (`@terminal-1:3-5`) and,
 * after it, the `<terminal_context>` block with the numbered lines.
 */
export function formatTerminalContext(selection: TerminalContextSelection): string {
  const text = normalizeTerminalContextText(selection.text);
  const slug = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const span =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  const range =
    selection.lineStart === selection.lineEnd
      ? `line ${selection.lineStart}`
      : `lines ${selection.lineStart}-${selection.lineEnd}`;
  const body = text
    .split("\n")
    // A trailing newline would otherwise number a line past the range the label declares.
    .slice(0, selection.lineEnd - selection.lineStart + 1)
    .map((line, index) => `${selection.lineStart + index} | ${line}`)
    .join("\n");
  return `@${slug}:${span}\n\n<terminal_context>\n- ${selection.terminalLabel} ${range}:\n${indent(body)}\n</terminal_context>`;
}

/**
 * The command "Add to chat" runs (D473, D1009): the chat's `chat.composer.insert-context` with a
 * terminal record (T3's inline chip), else T3's legacy text through `chat.composer.insert`.
 */
export function addToChatCall(
  selection: TerminalContextSelection,
  hasCommand: (name: string) => boolean,
  id: string = crypto.randomUUID(),
): { readonly command: string; readonly input: Record<string, unknown> } {
  return hasCommand("chat.composer.insert-context")
    ? {
        command: "chat.composer.insert-context",
        input: { record: terminalContextRecord({ id, ...selection }) },
      }
    : { command: "chat.composer.insert", input: { text: formatTerminalContext(selection) } };
}
