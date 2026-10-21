// The merge-back handoff follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/ContextHandoffService.ts (compactText,
// summarizeDeltaItem, makeForkDeltaSummary, providerMessageWithContextHandoffs).
import { contextReferencesAsLabels, ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";

/** Whitespace collapsed, cut at `maxLength` with "..." (T3's compactText). */
function compactText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 3)}...`;
}

const turnIdOf = (event: StoredEvent) => (event.payload as { turnId?: unknown } | null)?.turnId;

/** One line per user message, answer, command and file change of the given turns, in order. */
function deltaLines(events: readonly StoredEvent[], turnIds: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const turnId = turnIdOf(event);
    if (typeof turnId !== "string" || !turnIds.has(turnId)) continue;
    const payload = event.payload as Record<string, unknown>;
    if (event.type === ThreadEvents.turnStarted) {
      const text = (payload["input"] as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") {
        lines.push(`- User: ${compactText(contextReferencesAsLabels(text))}`);
      }
    } else if (event.type === ThreadEvents.itemCompleted && payload["kind"] === "message") {
      if (typeof payload["text"] === "string") {
        lines.push(`- Assistant: ${compactText(payload["text"])}`);
      }
    } else if (event.type === ThreadEvents.itemStarted && payload["kind"] === "tool") {
      const tool = payload["tool"] as { kind?: unknown; detail?: unknown } | undefined;
      const detail = typeof tool?.detail === "string" ? tool.detail : "";
      if (tool?.kind === "command") lines.push(`- Command: ${compactText(detail)}`);
      else if (tool?.kind === "file_change") lines.push(`- File change: ${compactText(detail)}`);
    }
  }
  return lines;
}

/**
 * What a parent's agent is told of a fork merged back (D226), T3's
 * fork_delta_summary: the fork's own turns after the fork point up to the
 * merged turn, before the user's message.
 */
export function mergeBackMessage(input: {
  readonly fork: { readonly id: string; readonly title: string };
  readonly target: { readonly id: string; readonly title: string };
  /** The fork's visible events. */
  readonly events: readonly StoredEvent[];
  /** The fork's own turns being merged, oldest first. */
  readonly turnIds: readonly string[];
  readonly userText: string;
}): string {
  const lines = deltaLines(input.events, new Set(input.turnIds));
  return [
    "Context handoff (merge_back / fork_delta_summary):",
    "Merge-back context from forked conversation.",
    `Source thread: ${input.fork.title} (${input.fork.id})`,
    `Target thread: ${input.target.title} (${input.target.id})`,
    `Covered fork turns: ${input.turnIds.length}`,
    "",
    "Fork delta:",
    ...(lines.length === 0 ? ["- No user-visible delta items."] : lines),
    "",
    "User message:",
    input.userText,
  ].join("\n");
}

// Searching thread contents follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/ThreadSearch.ts (the match per thread, its order and
// buildSearchSnippet).

/** A message a thread shows, as search reads it. */
export interface SearchText {
  readonly turnId: string;
  readonly source: "user" | "assistant";
  readonly text: string;
  /** The text as matched: whitespace collapsed, ASCII case folded (computed once). */
  readonly folded: string;
  readonly at: string;
}

/** The user messages and completed answers of a thread's visible events, oldest first. */
export function searchTexts(events: readonly StoredEvent[]): SearchText[] {
  const texts: SearchText[] = [];
  for (const event of events) {
    const turnId = turnIdOf(event);
    if (typeof turnId !== "string") continue;
    const payload = event.payload as Record<string, unknown>;
    const at = typeof payload["inheritedAt"] === "string" ? payload["inheritedAt"] : event.at;
    if (event.type === ThreadEvents.turnStarted) {
      const typed = (payload["input"] as { text?: unknown } | undefined)?.text;
      // A context reference is found by its label, as the message shows it (D1006).
      const text = typeof typed === "string" ? contextReferencesAsLabels(typed) : undefined;
      if (text !== undefined && text !== "") {
        texts.push({ turnId, source: "user", text, folded: foldForSearch(text), at });
      }
    } else if (
      event.type === ThreadEvents.itemCompleted &&
      payload["kind"] === "message" &&
      typeof payload["text"] === "string" &&
      payload["text"] !== ""
    ) {
      const text = payload["text"];
      texts.push({ turnId, source: "assistant", text, folded: foldForSearch(text), at });
    }
  }
  return texts;
}

/** ASCII case folding, as SQLite's LIKE matches in T3. */
const foldAsciiCase = (value: string) =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());
/**
 * What a text and a query are compared as: whitespace collapsed, as the
 * snippet shows it, so "foo bar" finds "foo\nbar", and ASCII case folded.
 */
const foldForSearch = (value: string) => foldAsciiCase(value.replace(/\s+/g, " ").trim());

/** T3's snippet: whitespace collapsed; past 240 characters a window from 72 before the match. */
export function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) return normalizedText;
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

/** A thread's one match: a user message first, else the newest answer (T3's order). */
export function matchTexts(
  texts: readonly SearchText[],
  query: string,
): { source: "user" | "assistant"; snippet: string; at: string } | undefined {
  const needle = foldForSearch(query);
  const matches = texts.filter((text) => text.folded.includes(needle));
  const best =
    matches.findLast((text) => text.source === "user") ??
    matches.findLast((text) => text.source === "assistant");
  return best === undefined
    ? undefined
    : { source: best.source, snippet: buildSearchSnippet(best.text, query), at: best.at };
}
