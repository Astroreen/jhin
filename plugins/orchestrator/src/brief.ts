import type { IntentChain, Mission, Slice } from "@jhin/missions-api";

/** Why an agent is refocused (D708). */
export type RefocusReason = "request" | "compaction" | "interval";

const steps = (mission: Mission) =>
  mission.process.slice.length === 0
    ? "none"
    : mission.process.slice.map((step) => step.id).join(" → ");

const intentLine = (intent: string | undefined) =>
  intent === undefined || intent.trim() === "" ? "No intent set yet." : intent.trim();

/**
 * What the assignee of a slice is sent when it is handed the slice (D703):
 * the slice, what it serves, its process, and how to close it. Tool names are
 * the MCP names of the commands, as an agent sees them.
 */
export function handoffText(input: {
  readonly slice: Slice;
  readonly mission: Mission;
  readonly intent: string | undefined;
  readonly step: string | undefined;
  readonly from: string | undefined;
}): string {
  const { slice, mission } = input;
  return [
    `[Slice handed to you${input.from === undefined ? "" : ` by ${input.from}`}]`,
    "",
    `You are the assignee of a slice of the mission "${mission.title}". Work on it until its spec works, then record its proof.`,
    "",
    `## Slice: ${slice.title}`,
    "",
    `Slice \`${slice.id}\`, wave ${slice.wave}.`,
    "",
    slice.spec.trim(),
    "",
    "## What it serves",
    "",
    `Mission outcome: ${mission.outcome.trim()}`,
    "",
    `Project intent: ${intentLine(input.intent)}`,
    "",
    "## Process",
    "",
    `The slice goes through ${steps(mission)}${input.step === undefined ? "" : `; it is at ${input.step}`}. Record each step you reach with slices_update { sliceId, step }.`,
    "When the spec works, record the proof once with slices_prove { sliceId, items }: the smallest proof that shows it works (a command with its output, a screenshot, a link).",
    `If you cannot go on, set the slice blocked with slices_update { sliceId, status: "blocked" } and say why: whoever runs the mission decides.`,
    "",
  ].join("\n");
}

const REASONS: Record<RefocusReason, string> = {
  request: "Refocus",
  compaction: "Refocus: your context was compacted",
  interval: "Refocus: a regular look back up",
};

/**
 * The refocus brief (D708): the intent chain from the slice up, and the
 * question the moonbase story asks. A brief, not a task: the agent goes on
 * with its work once it has checked it.
 */
export function refocusText(chain: IntentChain, reason: RefocusReason): string {
  return [
    `[${REASONS[reason]}]`,
    "",
    'Before your next step, walk back up to the intent ("moonbase"): does what you are doing now serve it? If it does, go on. If it does not, drop it and go back to the slice; anything else worth doing is for whoever runs the mission to plan.',
    "",
    `## Slice: ${chain.slice.title} (${chain.slice.status})`,
    "",
    chain.slice.spec.trim(),
    "",
    `## Mission: ${chain.mission.title}`,
    "",
    chain.mission.outcome.trim(),
    "",
    "## Project intent",
    "",
    intentLine(chain.project.intent),
    "",
  ].join("\n");
}
