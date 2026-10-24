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
  /** The mission's node, for an assignee of another node: its tools name it (D1542). */
  readonly node?: string;
}): string {
  const { slice, mission } = input;
  const on = input.node === undefined ? "" : `, node: "${input.node}"`;
  return [
    "[Slice handed to you]",
    "",
    `You are the assignee of a slice of the mission "${mission.title}". Work on it until its spec works, then record its proof.`,
    "",
    `## Slice: ${slice.title}`,
    "",
    `Slice \`${slice.id}\`, wave ${slice.wave}.`,
    ...(input.node === undefined
      ? []
      : [
          "",
          `The mission lives on node \`${input.node}\`, not yours: pass \`node: "${input.node}"\` with every slices_* and missions_* tool you call about it.`,
        ]),
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
    `The slice goes through ${steps(mission)}${input.step === undefined ? "" : `; it is at ${input.step}`}. Record each step you reach with slices_update { sliceId, step${on} }.`,
    `When the spec works, record the proof once with slices_prove { sliceId, items${on} }: the smallest proof that shows it works (a command with its output, a screenshot, a link).`,
    `If you cannot go on, set the slice blocked with slices_update { sliceId, status: "blocked"${on} } and say why: whoever runs the mission decides.`,
    ...(slice.reviews === undefined || slice.reviews.length === 0
      ? []
      : [
          "",
          "## Review",
          "",
          `This slice reviews the work of ${slice.reviews.map((id) => `\`${id}\``).join(", ")}. Record each review with slices_review { sliceId, verdict, notes${on} }: approved or changes-requested, and in notes what you checked and what you found. A commit or merge of the mission is refused until each is approved after its last change.`,
        ]),
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
