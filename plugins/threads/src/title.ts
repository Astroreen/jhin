// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/provider-core/src/server/threadTitleContext.ts (limitTitleMessage,
// formatThreadTitleContext) and textGenerationPrompts.ts (regenerateThreadTitlePrompt,
// buildThreadTitlePrompt). Decisions: docs/plans/t3-parity.md (D1174).
import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";

/** A message of a thread as its title reads it. */
export interface TitleMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: readonly string[];
}

const MAX_CONTEXT = 8_000;
const MAX_MESSAGE = 2_000;
const OMITTED = "[Earlier content truncated]\n\n";
const TRUNCATED = "\n[Content truncated]\n";

/** T3's limitTitleMessage: the start and the end of a long text, cut in the middle. */
export function limitTitleMessage(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return "";
  const available = budget - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${text.slice(0, head)}${TRUNCATED}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** The user's messages (with their steers) and the agent's answers of a thread, oldest first. */
export function titleMessages(events: readonly StoredEvent[]): TitleMessage[] {
  const messages: TitleMessage[] = [];
  for (const event of events) {
    const payload = (event.payload ?? {}) as {
      input?: { text?: unknown; attachments?: { name?: unknown }[] };
      kind?: unknown;
      text?: unknown;
    };
    if (event.type === ThreadEvents.turnStarted || event.type === ThreadEvents.turnSteered) {
      const text = typeof payload.input?.text === "string" ? payload.input.text : "";
      const attachments = (payload.input?.attachments ?? []).flatMap((attachment) =>
        typeof attachment.name === "string" ? [attachment.name] : [],
      );
      messages.push({ role: "user", text, ...(attachments.length > 0 ? { attachments } : {}) });
    } else if (
      event.type === ThreadEvents.itemCompleted &&
      payload.kind === "message" &&
      typeof payload.text === "string"
    ) {
      messages.push({ role: "assistant", text: payload.text });
    }
  }
  return messages;
}

/**
 * T3's formatThreadTitleContext: the first user message, then the latest user
 * messages and the latest answers, within 8 000 characters.
 */
export function formatThreadTitleContext(messages: readonly TitleMessage[]): string {
  const sections = messages.flatMap((message, index) =>
    !message.text.trim() && !message.attachments?.length
      ? []
      : [{ index, message, prefix: `${message.role.toUpperCase()}:\n` }],
  );
  const formatted = new Map<number, string>();
  const contentsFor = (section: (typeof sections)[number]) => {
    const cached = formatted.get(section.index);
    if (cached !== undefined) return cached;
    const names = section.message.attachments?.join(", ");
    const contents = [section.message.text.trim(), ...(names ? [`[Attachments: ${names}]`] : [])]
      .filter(Boolean)
      .join("\n");
    formatted.set(section.index, contents);
    return contents;
  };
  const selected = new Map<number, string>();
  let remaining = MAX_CONTEXT - OMITTED.length;
  const add = (section: (typeof sections)[number], budget: number) => {
    if (selected.has(section.index)) return;
    const limit = Math.min(budget, remaining) - section.prefix.length - 2;
    if (limit <= TRUNCATED.length) return;
    const contents = limitTitleMessage(contentsFor(section), limit);
    if (!contents) return;
    const text = section.prefix + contents;
    selected.set(section.index, text);
    remaining -= text.length + 2;
  };
  const firstUser = sections.find((section) => section.message.role === "user");
  if (firstUser) add(firstUser, MAX_MESSAGE);
  for (const section of sections.toReversed()) {
    if (section.message.role === "user") add(section, Math.min(MAX_MESSAGE, remaining - 2_000));
  }
  for (const section of sections.toReversed()) {
    if (section.message.role === "assistant") add(section, MAX_MESSAGE);
  }
  for (const role of ["user", "assistant"] as const) {
    for (const section of sections.toReversed()) {
      const previous = selected.get(section.index);
      if (section.message.role !== role || previous === undefined) continue;
      const expanded =
        section.prefix +
        limitTitleMessage(
          contentsFor(section),
          previous.length + remaining - section.prefix.length,
        );
      remaining -= expanded.length - previous.length;
      selected.set(section.index, expanded);
    }
  }
  const retained = sections.filter((section) => selected.has(section.index));
  const truncated = retained.some(
    (section) => selected.get(section.index) !== section.prefix + contentsFor(section),
  );
  return `${truncated || retained.length < sections.length ? OMITTED : ""}${retained
    .map((section) => selected.get(section.index))
    .join("\n\n")}`;
}

/** T3's prompt to regenerate a thread's title, its wording for a Jhin thread. */
export function regenerateTitlePrompt(previousTitle: string, contents: string): string {
  return `Regenerate the title for an existing Jhin thread so the user can recognize it weeks later.
The previous title was ${JSON.stringify(previousTitle)}.
Return JSON with keys title and needsRefinement. Set needsRefinement to false.

Determine the title in this order:
1. Read the USER messages first. Identify the latest explicit durable goal. The original subject remains the subject until the user clearly changes what the thread is about.
2. Use ASSISTANT messages to resolve vague links, unnamed code, and discovered product nouns. Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.
3. Compare that subject with the previous title. Preserve accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, artifact-based, a completion update, or contradicted by the thread.
4. Title the durable subject and desired outcome, not the current workflow state.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Preserve the umbrella subject when later messages focus on one finding, provider, platform, or implementation detail.
- A thread progressing through research, planning, implementation, review, CI, merge, and monitoring has usually not changed subjects.
- Ignore deliverables and operations such as mocks, plans, HTML, branches, PRs, tests, CI, commits, merging, and monitoring unless they are the actual topic.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- Treat final operational follow-ups and assistant completion summaries as weak evidence of subject.
- For reviews, name the reviewed feature or system and its durable concern, not one finding from the review.
- For research, name the question domain rather than the research process.
- Do not claim the work is complete.
- Do not copy and truncate a thread message.
- Avoid project names already visible in the UI, PR numbers, quotes, labels, filler, and trailing punctuation.
- Use attached images as primary context for UI issues.
- When a URL or attachment is the only source of the subject, use available tools to inspect it directly.
- Local git history is not evidence of what a linked PR or issue is about. Never title the thread after branch names, commit messages, or merged commits found in the checkout.
- If a linked PR or issue cannot be read, fall back to the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.
- Keep the previous title unchanged if it is already accurate. Otherwise return a meaningfully improved title, not a cosmetic paraphrase.

Examples of the distinction:
- A subagent-monitoring review that finds a Codex roster bug remains "Review Subagent Monitoring Risks," not "Codex Roster Bug Review."
- A vague failing-test request later identified as a lazy thread-feed mismatch becomes "Fix Lazy Thread Feed Test," not "Prevent Mobile Feed Regressions."
- A QR-sharing overhaul that ends with CI and merge work remains about QR sharing, not the PR lifecycle.

Thread contents:
${contents.length <= 8_000 ? contents : `${OMITTED}${contents.slice(-8_000)}`}`;
}
