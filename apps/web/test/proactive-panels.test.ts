// T3's proactive panels (source-control.md D1426), as useProactivePanels decides them: a linked
// pull request opens the pull requests, a big finished turn opens "Changes", what is still
// loading is decided once it loads, and nothing opens once the user changed the panel.
import type { TurnCheckpoint } from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import {
  decideProactivePanels,
  turnDiffAction,
  type ProactiveInput,
  type ProactiveObservation,
} from "../src/plugins/source-control/proactive.tsx";

const checkpoint = (change: Partial<TurnCheckpoint> = {}): TurnCheckpoint => ({
  threadId: "t",
  turnId: "u1",
  turn: 1,
  ref: "refs/jhin/checkpoints/t/1",
  status: "ready",
  files: [],
  fileCount: 3,
  insertions: 1,
  deletions: 0,
  capturedAt: "2026-10-24T00:00:00.000Z",
  ...change,
});

const base: ProactiveInput = {
  threadKey: "n|t",
  enabled: true,
  userActionRevision: 0,
  latestTurn: undefined,
  pullRequestsKey: null,
  checkpoint: undefined,
  isGitRepo: true,
  activeKind: undefined,
};

/** Feeds the inputs in order, as the effect reruns, and gives each decision. */
function run(...inputs: Partial<ProactiveInput>[]) {
  let observation: ProactiveObservation | undefined;
  return inputs.map((input) => {
    const decision = decideProactivePanels(observation, { ...base, ...input });
    observation = decision.observation;
    return decision.open;
  });
}

const running = { turnId: "u1", status: "running" } as const;
const completed = { turnId: "u1", status: "completed" } as const;

describe("proactive panels", () => {
  it("opens the diff for edits to at least 3 files or 50 lines of a ready checkpoint", () => {
    const action = (change: Partial<TurnCheckpoint>) =>
      turnDiffAction({ checkpoint: checkpoint(change), isGitRepo: true, activeKind: undefined });
    expect(action({ fileCount: 3 })).toBe("open");
    expect(action({ fileCount: 1, insertions: 30, deletions: 20 })).toBe("open");
    expect(action({ fileCount: 2, insertions: 30, deletions: 19 })).toBe("ignore");
    expect(action({ fileCount: 0, insertions: 0 })).toBe("ignore");
    expect(action({ fileCount: 9, status: "error" })).toBe("ignore");
    expect(
      turnDiffAction({ checkpoint: checkpoint(), isGitRepo: false, activeKind: undefined }),
    ).toBe("ignore");
  });

  it("opens Changes when the turn it saw running ends with a big checkpoint", () => {
    expect(
      run({ latestTurn: running }, { latestTurn: completed, checkpoint: checkpoint() }),
    ).toEqual([undefined, "diff"]);
  });

  it("waits for the turn's checkpoint and the repository, then opens once", () => {
    expect(
      run(
        { latestTurn: running },
        { latestTurn: completed },
        { latestTurn: completed, checkpoint: checkpoint(), isGitRepo: undefined },
        { latestTurn: completed, checkpoint: checkpoint() },
        { latestTurn: completed, checkpoint: checkpoint() },
      ),
    ).toEqual([undefined, undefined, undefined, "diff", undefined]);
  });

  it("does not take an earlier turn's checkpoint for the one that ended", () => {
    expect(
      run(
        { latestTurn: running },
        { latestTurn: completed, checkpoint: checkpoint({ turnId: "u0" }) },
      ),
    ).toEqual([undefined, undefined]);
  });

  it("as T3, a thread coming on screen opens what it has: its pull requests, or its last turn", () => {
    expect(run({ pullRequestsKey: "gh#1" })).toEqual(["pull-requests"]);
    expect(run({ latestTurn: completed, checkpoint: checkpoint() })).toEqual(["diff"]);
    // Loaded after it came on screen, the same.
    expect(run({}, { pullRequestsKey: "gh#1" }, { pullRequestsKey: "gh#1" })).toEqual([
      undefined,
      "pull-requests",
      undefined,
    ]);
  });

  it("opens the pull requests for a new link, and not the diff while the thread has links", () => {
    expect(
      run(
        { pullRequestsKey: "gh#1" },
        { pullRequestsKey: "gh#1", latestTurn: running },
        { pullRequestsKey: "gh#1", latestTurn: completed, checkpoint: checkpoint() },
        { pullRequestsKey: "gh#1 gh#2", latestTurn: completed, checkpoint: checkpoint() },
      ),
    ).toEqual(["pull-requests", undefined, undefined, "pull-requests"]);
  });

  it("opens nothing with the setting off, outside a repository, or over the diff", () => {
    expect(
      run(
        { enabled: false, pullRequestsKey: "gh#1" },
        { enabled: false, latestTurn: completed, checkpoint: checkpoint() },
      ),
    ).toEqual([undefined, undefined]);
    expect(
      run(
        { latestTurn: running },
        { latestTurn: completed, checkpoint: checkpoint(), isGitRepo: false },
      ),
    ).toEqual([undefined, undefined]);
    expect(
      run(
        { latestTurn: running },
        { latestTurn: completed, checkpoint: checkpoint(), activeKind: "diff" },
      ),
    ).toEqual([undefined, undefined]);
  });

  it("counts the user's choices from the turn's start, and from the thread coming on screen", () => {
    let observation: ProactiveObservation | undefined;
    const step = (input: Partial<ProactiveInput>) => {
      const decision = decideProactivePanels(observation, { ...base, ...input });
      observation = decision.observation;
      return decision.observation.userActionRevision;
    };
    expect(step({ userActionRevision: 4 })).toBe(4);
    // The user changes the panel while idle: a new turn reads the revision anew.
    expect(step({ userActionRevision: 5, latestTurn: running })).toBe(5);
    // A change during the turn is kept: the panel does not open over it.
    expect(step({ userActionRevision: 6, latestTurn: running })).toBe(5);
    expect(step({ userActionRevision: 6, latestTurn: completed })).toBe(5);
    // Another thread reads its own.
    expect(step({ threadKey: "n|t2", userActionRevision: 1 })).toBe(1);
  });
});
