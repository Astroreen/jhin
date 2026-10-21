/**
 * Event types of delegated work (docs/plans/orchestration.md), shared by the
 * orchestration plugin that writes them and the clients that show them.
 */

/** The node's stream of task and workflow records: one event per change (D365, D376). */
export const ORCHESTRATION_STREAM = "orchestration";

export const OrchestrationEvents = {
  /** The task's record after a change. */
  taskUpdated: "orchestration.task.updated",
  /** The workflow's record after a change. */
  workflowUpdated: "orchestration.workflow.updated",
} as const;

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
