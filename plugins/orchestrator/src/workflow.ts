/**
 * The orchestrator workflow (docs/plans/agents.md D706, D707): a W10 workflow
 * script that walks one mission wave by wave. It keeps the plan out of the
 * lead's head and decides nothing itself: it hands each ready slice to its
 * assignee, waits for the mission to change, and ends with what the lead has
 * to decide or run (the mission's own steps between waves, the project's
 * after the last). Its end wakes the lead like any workflow's (D376); running
 * it again goes on from what the mission says, so it holds no state.
 */
export const ORCHESTRATOR_WORKFLOW = `export const meta = {
  name: "mission",
  description: "Walks a mission wave by wave: hands each ready slice to its assignee, waits for the proofs, and comes back to the lead for every decision",
  whenToUse: "Run through missions.orchestrate, one per mission",
};

const { missionId, waitMs } = args;
const handed = [];
// The wave this run saw at work: once it is over, the mission's steps between waves are the lead's.
let watched = null;
for (;;) {
  const next = await command("missions.next", { missionId });
  const end = (outcome, more) => ({ outcome, missionId, title: next.mission.title, handed, ...more });
  if (next.mission.status === "done" || next.mission.status === "dropped") {
    return end("closed", { status: next.mission.status });
  }
  if (next.total === 0) {
    return end("decide", { decisions: [], note: "The mission has no slices yet: plan them with slices.create." });
  }
  if (next.slicesDone) {
    return end("slices-done", {
      steps: next.steps,
      projectSteps: next.projectSteps,
      note: "Every slice is done or dropped. Run the mission's steps, then set the mission done with missions.update once its outcome holds.",
    });
  }
  if (watched !== null && next.wave !== watched && next.steps.length > 0) {
    return end("wave-done", {
      wave: watched,
      steps: next.steps,
      note: "Run the mission's steps for this wave, then run the orchestrator again for the next one.",
    });
  }
  watched = next.wave;
  phase("Wave " + next.wave);
  const failed = [];
  for (const sliceId of next.ready) {
    try {
      const done = await command("slices.handoff", { sliceId });
      handed.push(sliceId);
      log("Handed " + done.slice.title + " to " + done.slice.assignee);
    } catch (error) {
      failed.push({ sliceId, reason: "handoff-failed", code: error.code, message: error.message });
    }
  }
  const decisions = [...next.decisions, ...failed];
  if (decisions.length > 0) return end("decide", { wave: next.wave, decisions });
  await command("missions.wait", { missionId, after: next.head, ...(waitMs === undefined ? {} : { timeoutMs: waitMs }) });
}
`;
