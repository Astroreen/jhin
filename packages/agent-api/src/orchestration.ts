/**
 * Event types of delegated work (docs/plans/orchestration.md), shared by the
 * orchestration plugin that writes them and the clients that show them.
 */

/** The node's stream of task and workflow records: one event per change (D365, D376). */
export const ORCHESTRATION_STREAM = "orchestration";

export const OrchestrationEvents = {
  /** The task's record after a change. */
  taskUpdated: "orchestration.task.updated",
  /**
   * The workflow's whole record: when a run starts, ends, is resumed or its delivery
   * changes; other changes are `workflowPatched` (D1504).
   */
  workflowUpdated: "orchestration.workflow.updated",
  /** What changed in a running workflow's record, a `WorkflowPatch` (D1504). */
  workflowPatched: "orchestration.workflow.patched",
  /** An old task's record was pruned (D1503): `{ taskId, parentThreadId }`. */
  taskRemoved: "orchestration.task.removed",
  /** An old workflow's record was pruned (D1503): `{ workflowId, parentThreadId }`. */
  workflowRemoved: "orchestration.workflow.removed",
} as const;

/** How many log lines a workflow's record keeps (D376). */
export const MAX_WORKFLOW_LOGS = 200;

/** What changed in a workflow's record (D1504). */
export interface WorkflowPatch {
  readonly workflowId: string;
  readonly parentThreadId: string;
  readonly updatedAt: string;
  /** Top-level fields other than `agents` and `logs` that changed, with their new values. */
  readonly set?: Readonly<Record<string, unknown>>;
  /** Top-level fields that went away. */
  readonly unset?: readonly string[];
  /** Agents that are new or changed, by `index`. */
  readonly agents?: readonly ({ readonly index: number } & Readonly<Record<string, unknown>>)[];
  /** Log lines appended; the record keeps the last `MAX_WORKFLOW_LOGS`. */
  readonly logs?: readonly string[];
}

/** `record` with `patch` applied: the one fold the plugin and its clients share (D1504). */
export function applyWorkflowPatch<R extends object>(record: R, patch: WorkflowPatch): R {
  const before = record as Record<string, unknown>;
  const next: Record<string, unknown> = { ...before, ...patch.set, updatedAt: patch.updatedAt };
  for (const key of patch.unset ?? []) delete next[key];
  if (patch.agents !== undefined && patch.agents.length > 0) {
    const agents = [...((before.agents as { index: number }[] | undefined) ?? [])];
    for (const agent of patch.agents) {
      const at = agents.findIndex((entry) => entry.index === agent.index);
      if (at === -1) agents.push(agent);
      else agents[at] = agent;
    }
    next.agents = agents;
  }
  if (patch.logs !== undefined && patch.logs.length > 0) {
    next.logs = [...((before.logs as string[] | undefined) ?? []), ...patch.logs].slice(
      -MAX_WORKFLOW_LOGS,
    );
  }
  return next as R;
}

/**
 * Marks delegated work leaves in the calling thread's own stream, in its turn,
 * so the chat shows it there (D862).
 */
export const OrchestrationThreadEvents = {
  /** A task the thread delegated (not one of a workflow's agents). */
  taskDelegated: "orchestration.task.delegated",
  /** A workflow the thread started, with its script. */
  workflowStarted: "orchestration.workflow.started",
  /** A top-level thread the thread launched. */
  threadLaunched: "orchestration.thread.launched",
} as const;
