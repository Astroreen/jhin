// The progress of a new worktree's setup follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/worktreeSetup.ts.
import { z } from "@jhin/sdk";

/** Producers clamp free text to these before publishing (T3's limits). */
export const WORKTREE_SETUP_DETAIL_MAX_LENGTH = 200;
export const WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH = 400;
export const WORKTREE_SETUP_ERROR_MAX_LENGTH = 1000;
/** How many of the setup script's last output lines a snapshot keeps. */
export const WORKTREE_SETUP_TAIL_LINES = 4;

export const WorktreeSetupStageId = z.enum([
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
]);
export type WorktreeSetupStageId = z.infer<typeof WorktreeSetupStageId>;

export const WorktreeSetupStageStatus = z.enum([
  "pending",
  "running",
  "done",
  "skipped",
  "warning",
  "failed",
]);
export type WorktreeSetupStageStatus = z.infer<typeof WorktreeSetupStageStatus>;

export const WorktreeSetupStage = z.object({
  id: WorktreeSetupStageId,
  status: WorktreeSetupStageStatus,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  detail: z.string().max(WORKTREE_SETUP_DETAIL_MAX_LENGTH).nullable(),
  tail: z.array(z.string().max(WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)),
});
export type WorktreeSetupStage = z.output<typeof WorktreeSetupStage>;

export const WorktreeSetupPhase = z.enum(["running", "done", "failed", "cancelled"]);
export type WorktreeSetupPhase = z.infer<typeof WorktreeSetupPhase>;

/** A thread's worktree setup as it stands (D1123). */
export const WorktreeSetupSnapshot = z.object({
  threadId: z.string(),
  phase: WorktreeSetupPhase,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  worktreePath: z.string().nullable(),
  setupScript: z
    .object({ name: z.string(), command: z.string(), terminalId: z.string() })
    .nullable(),
  stages: z.array(WorktreeSetupStage),
  error: z.string().max(WORKTREE_SETUP_ERROR_MAX_LENGTH).nullable(),
  /** Grows with every change, across setups of one thread. */
  sequence: z.number().int().nonnegative(),
});
export type WorktreeSetupSnapshot = z.output<typeof WorktreeSetupSnapshot>;

/** Every thread's setup has a live stream of its own under this prefix (D1123). */
export const WORKTREE_SETUP_STREAM_PREFIX = "source-control/worktree-setup/";
export const worktreeSetupStream = (threadId: string): string =>
  `${WORKTREE_SETUP_STREAM_PREFIX}${threadId}`;
/** Event type of every `WorktreeSetupSnapshot` on a setup stream. */
export const WORKTREE_SETUP_CHANGED = "source-control.worktree-setup.changed";

export const WORKTREE_SETUP_STAGE_ORDER: readonly WorktreeSetupStageId[] = [
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
];

/** T3's label of a stage. */
export function worktreeSetupStageLabel(id: WorktreeSetupStageId): string {
  switch (id) {
    case "fetch":
      return "Fetch base branch";
    case "checkout":
      return "Check out files";
    case "submodules":
      return "Init submodules";
    case "setup-script":
      return "Run setup script";
    case "agent":
      return "Start agent";
  }
}

/** The agent has been handed the thread: its stage is past running. */
export const worktreeSetupAgentStarted = (snapshot: WorktreeSetupSnapshot): boolean =>
  snapshot.stages.some(
    (stage) => stage.id === "agent" && stage.status !== "pending" && stage.status !== "running",
  );
