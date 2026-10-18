import type { StoredEvent } from "@jhin/storage-api";

export const AGENT_RUNTIME_CAPABILITY = "agent.runtime";

export interface TurnInput {
  readonly text: string;
}

export interface TurnRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: TurnInput;
  /** Every earlier event of the thread, oldest first. */
  readonly history: readonly StoredEvent[];
  /** The project's working directory. */
  readonly cwd: string;
}

/** One unit of an agent's response (D32: thread → turn → item). */
export type AgentItem =
  | { readonly kind: "message.delta"; readonly itemId: string; readonly text: string }
  | { readonly kind: "message.completed"; readonly itemId: string; readonly text: string };

export interface AgentTurn {
  /** Ends when the turn completes; throws when it fails. */
  readonly items: AsyncIterable<AgentItem>;
  /** Asks the agent to stop; `items` then ends early. */
  interrupt(): void;
}

/**
 * `agent.runtime@1` (D33): anything that executes turns, an own agent loop or a
 * wrapper over an existing agent (Claude Code, Codex, OpenCode).
 */
export interface AgentRuntime {
  /** Recorded on every turn it runs (D52). */
  readonly agentId: string;
  startTurn(request: TurnRequest): AgentTurn;
}

/** Event types of a thread's stream `thread/<id>` (D34). */
export const ThreadEvents = {
  threadCreated: "threads.thread.created",
  turnStarted: "agent.turn.started",
  itemDelta: "agent.item.delta",
  itemCompleted: "agent.item.completed",
  turnCompleted: "agent.turn.completed",
  turnInterrupted: "agent.turn.interrupted",
  turnFailed: "agent.turn.failed",
} as const;

export const threadStream = (threadId: string) => `thread/${threadId}`;
