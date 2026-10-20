// The merge-back handoff follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/ContextHandoffService.ts (compactText,
// summarizeDeltaItem, makeForkDeltaSummary, providerMessageWithContextHandoffs).
import { ThreadEvents } from "@jhin/agent-api";
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
      if (typeof text === "string") lines.push(`- User: ${compactText(text)}`);
    } else if (event.type === ThreadEvents.itemCompleted && payload["kind"] === "message") {
      if (typeof payload["text"] === "string") {
        lines.push(`- Assistant: ${compactText(payload["text"])}`);
      }
    } else if (event.type === ThreadEvents.itemStarted && payload["kind"] === "tool") {
      const tool = payload["tool"] as { kind?: unknown; detail?: unknown } | undefined;
      const detail = typeof tool?.detail === "string" ? tool.detail : "";
      if (tool?.kind === "command") lines.push(`- Command: ${compactText(detail)}`);
      else if (tool?.kind === "file_change") lines.push(`- File change: ${detail}`);
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
