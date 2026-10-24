/**
 * The orchestrator workflow (docs/plans/agents.md D706, D707): a W10 workflow
 * script that walks one mission wave by wave. It keeps the plan out of the
 * lead's head and decides nothing itself: it hands each ready slice to its
 * assignee, waits for the mission to change, and ends with what the lead has
 * to decide or run (the mission's own steps between waves, the project's
 * after the last), with whether the slices were reviewed after their last
 * change (D1241). Its end wakes the lead like any workflow's (D376); running
 * it again goes on from what the mission says, so it holds no state. With
 * `node` the mission lives on another node, and each command names it (D1545).
 */
export const ORCHESTRATOR_WORKFLOW = `export const meta = {
  name: "mission",
  description: "Walks a mission wave by wave: hands each ready slice to its assignee, waits for the proofs, and comes back to the lead for every decision",
  whenToUse: "Run through missions.orchestrate, one per mission",
};

const { missionId, waitMs, node } = args;
// A mission of another node is reached there through each command (D1542).
const on = node === undefined ? {} : { node };
const nodeNote = node === undefined ? "" : " The mission lives on node " + node + ": pass node: " + JSON.stringify(node) + " with every missions_* and slices_* tool.";
const STEPS_NOTE = "Take each step with missions_update { missionId, step } before you run it: a step that needs a review (commit, merge) is refused while a slice changed after its last review, as review.unreviewed lists them; have them reviewed again with slices_review first." + nodeNote;
const handed = [];
// The wave this run saw at work: once it is over, the mission's steps between waves are the lead's.
let watched = null;
for (;;) {
  const next = await command("missions.next", { missionId, ...on });
  const end = (outcome, more) => ({ outcome, missionId, ...on, title: next.mission.title, handed, ...more });
  if (next.mission.status === "done" || next.mission.status === "dropped") {
    return end("closed", { status: next.mission.status });
  }
  if (next.held) {
    return end("waiting", {
      escalations: next.escalations,
      note: "You asked the owner and the answer has not come: the team waits for it. It comes to you as a message; run the orchestrator again then. If the ask is about some slices only, set them blocked (slices_update) and run the orchestrator again: the rest goes on.",
    });
  }
  if (next.total === 0) {
    return end("decide", { decisions: [], note: "The mission has no slices yet: plan them with slices.create." });
  }
  if (next.slicesDone) {
    return end("slices-done", {
      steps: next.steps,
      projectSteps: next.projectSteps,
      review: await command("missions.review.check", { missionId, ...on }),
      note: "Every slice is done or dropped. Run the mission's steps, then close it with missions.close once its outcome holds, saying what was committed or merged and where: the owner gets your report. " + STEPS_NOTE,
    });
  }
  if (watched !== null && next.wave !== watched && next.steps.length > 0) {
    return end("wave-done", {
      wave: watched,
      steps: next.steps,
      review: await command("missions.review.check", { missionId, ...on }),
      note: "Run the mission's steps for this wave, then run the orchestrator again for the next one. " + STEPS_NOTE,
    });
  }
  watched = next.wave;
  phase("Wave " + next.wave);
  const failed = [];
  for (const sliceId of next.ready) {
    try {
      const done = await command("slices.handoff", { sliceId, ...on });
      handed.push(sliceId);
      log("Handed " + done.slice.title + " to " + done.slice.assignee);
    } catch (error) {
      failed.push({ sliceId, reason: "handoff-failed", code: error.code, message: error.message });
    }
  }
  const decisions = [...next.decisions, ...failed];
  if (decisions.length > 0) return end("decide", { wave: next.wave, decisions });
  await command("missions.wait", { missionId, after: next.head, ...on, ...(waitMs === undefined ? {} : { timeoutMs: waitMs }) });
}
`;
