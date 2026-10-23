import { MAX_MESSAGE_LENGTH } from "@jhin/agent-api";
import type { Mission, ProofItem, Slice } from "@jhin/missions-api";

/** How a mission's run ended for the owner (D1222): closed by the lead, or its orchestrator ended. */
export type ReportEnd = "done" | "dropped" | "failed" | "stopped";

const OUTPUT_LINES = 6;
const OUTPUT_CHARS = 600;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A fence longer than any backtick run in the text, so the text cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** The start of a command's output: the proof, not all of it. */
function cut(output: string): string {
  const lines = output.trimEnd().split("\n");
  let text = lines.slice(0, OUTPUT_LINES).join("\n");
  if (text.length > OUTPUT_CHARS) text = text.slice(0, OUTPUT_CHARS);
  return text.length < output.trimEnd().length ? `${text}\n…` : text;
}

function proofLines(item: ProofItem): string[] {
  if (item.kind === "command") return [fenced(`$ ${item.command}\n${cut(item.output)}`)];
  if (item.kind === "screenshot") return [`- Screenshot: <${item.url}>`];
  return [`- Link: <${item.url}>${item.title === undefined ? "" : ` (${oneLine(item.title)})`}`];
}

function sliceLines(slice: Slice): string[] {
  const facts = [
    slice.status,
    `wave ${slice.wave}`,
    slice.assignee === undefined ? "unassigned" : slice.assignee,
  ];
  const lines = [`#### ${oneLine(slice.title)}`, "", facts.join(" · "), ""];
  if (slice.proof === undefined) {
    if (slice.status !== "dropped") lines.push("No proof recorded.", "");
    return lines;
  }
  for (const item of slice.proof.items) lines.push(...proofLines(item), "");
  return lines;
}

const HEADLINE: Record<ReportEnd, string> = {
  done: "done",
  dropped: "dropped",
  failed: "its orchestrator failed",
  stopped: "its orchestrator was stopped",
};

/**
 * The lead's report to the owner when a mission closes, or its run fails or
 * stops (D1222): the mission, its slices with their proof, what the lead says
 * was committed or merged, and why a run ended. Built from the records, so it
 * does not depend on the lead remembering to write it.
 */
export function reportText(input: {
  readonly mission: Mission;
  readonly slices: readonly Slice[];
  readonly end: ReportEnd;
  /** What the lead said when it closed the mission (`missions.close`). */
  readonly summary?: string | undefined;
  /** The orchestrator run's error, for `failed`. */
  readonly error?: string | undefined;
}): string {
  const { mission, slices, end } = input;
  const closed = end === "done" || end === "dropped";
  const counts = new Map<string, number>();
  for (const slice of slices) counts.set(slice.status, (counts.get(slice.status) ?? 0) + 1);
  const lines = [
    // The first line is what the inbox lists and notifies.
    `Mission report: ${oneLine(mission.title)}, ${HEADLINE[end]}`,
    "",
    `Mission \`${mission.id}\` · ${mission.status} · ${
      slices.length === 0
        ? "no slices"
        : [...counts].map(([status, count]) => `${count} ${status}`).join(", ")
    }`,
    "",
    `**Outcome**: ${mission.outcome.trim()}`,
    "",
  ];
  if (!closed) {
    lines.push(
      "### Why it stopped",
      "",
      input.error === undefined ? "The run was stopped." : fenced(input.error),
      "",
      "The mission is still open: the lead runs the orchestrator again, or closes the mission.",
      "",
    );
  }
  lines.push("### Committed or merged", "");
  lines.push(
    input.summary === undefined || input.summary.trim() === ""
      ? closed
        ? "The lead said nothing about it when it closed the mission."
        : "Nothing yet: the mission is open."
      : input.summary.trim(),
    "",
  );
  if (slices.length > 0) lines.push("### Slices", "");
  for (const slice of slices.toSorted((a, b) => a.wave - b.wave)) lines.push(...sliceLines(slice));
  const text = lines.join("\n").trimEnd();
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const more = `\n\n… cut; \`missions.markdown\` has the whole mission.`;
  return text.slice(0, MAX_MESSAGE_LENGTH - more.length) + more;
}
