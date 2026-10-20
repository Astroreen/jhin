import type { StoredEvent } from "@jhin/storage-api";

/** `agent.runtime@1`: a node's single agent runtime (the simplest way to add one). */
export const AGENT_RUNTIME_CAPABILITY = "agent.runtime";
/**
 * `agent.registry@1`: every agent runtime of a node, provided by the threads
 * plugin. Runtime plugins require it and register themselves, so one node can
 * run several agents (Claude Code, Codex, an own loop) side by side.
 */
export const AGENT_REGISTRY_CAPABILITY = "agent.registry";

/**
 * How much an agent may do without asking, as in T3 Code:
 * - `approval-required` ("Supervised"): ask before commands and file changes;
 * - `auto-accept-edits`: approve file edits, ask before other actions;
 * - `full-access`: commands and edits run without prompts.
 */
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
/** The default when nobody chose one (T3 Code's default too). */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

/** `plan` asks the agent to propose a plan instead of changing anything. */
export const INTERACTION_MODES = ["default", "plan"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

/** A file sent with a message. Only images today, inlined as data URLs. */
export interface TurnAttachment {
  readonly kind: "image";
  readonly name: string;
  readonly mimeType: string;
  /** `data:<mime>;base64,…` */
  readonly dataUrl: string;
}

export interface TurnInput {
  readonly text: string;
  readonly attachments?: readonly TurnAttachment[];
}

export interface TurnRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: TurnInput;
  /** Every earlier event of the thread, oldest first. */
  readonly history: readonly StoredEvent[];
  /** The project's working directory. */
  readonly cwd: string;
  /** One of the runtime's `models`; its default model when absent. */
  readonly model?: string;
  /** `DEFAULT_RUNTIME_MODE` when absent. */
  readonly runtimeMode?: RuntimeMode;
  /** `default` when absent. */
  readonly interactionMode?: InteractionMode;
  /**
   * Since 1.2: values chosen for the model's `options`, only of those it
   * declares; its defaults for the rest.
   */
  readonly modelOptions?: readonly ModelOptionSelection[];
}

/** What kind of work a tool call does; clients pick icons and wording from it. */
export type ToolKind =
  | "command"
  | "file_change"
  | "file_read"
  | "search"
  | "web"
  | "mcp"
  | "agent"
  | "todo"
  | "other";

export interface ToolCall {
  /** The agent's own tool name, e.g. `Bash`, `Edit`. */
  readonly name: string;
  readonly kind: ToolKind;
  /** Short human label: "Ran command", "Edited file". */
  readonly title: string;
  /** The subject: a command line, a file path, a query. */
  readonly detail?: string;
  /** The raw tool input, as the agent sent it. */
  readonly input?: unknown;
}

/** One step of an agent's plan (a todo list). */
export interface PlanStep {
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  /** Tokens the conversation occupies in the model's context now. */
  readonly contextTokens?: number;
  /** Size of the model's context window. */
  readonly contextWindow?: number;
  readonly costUsd?: number;
}

export interface UserQuestion {
  readonly id: string;
  /** A short label, e.g. "Database". */
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
  /** Whether a free-text answer is accepted besides the options (default true). */
  readonly allowCustomAnswer?: boolean;
}

/** Something the agent needs from the user before it can go on. */
export type AgentRequest =
  | {
      readonly kind: "approval";
      /** The tool call waiting for permission. */
      readonly tool: ToolCall;
      readonly reason?: string;
    }
  | { readonly kind: "user-input"; readonly questions: readonly UserQuestion[] };

export const APPROVAL_DECISIONS = ["accept", "accept-for-session", "decline", "cancel"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type AgentResponse =
  | { readonly kind: "approval"; readonly decision: ApprovalDecision }
  | {
      readonly kind: "user-input";
      /** Answers by question id: an option label, several labels, or free text. */
      readonly answers: Readonly<Record<string, string | readonly string[]>>;
    };

/** One unit of an agent's response (D32: thread → turn → item). */
export type AgentItem =
  | { readonly kind: "message.delta"; readonly itemId: string; readonly text: string }
  | { readonly kind: "message.completed"; readonly itemId: string; readonly text: string }
  | { readonly kind: "reasoning.delta"; readonly itemId: string; readonly text: string }
  | { readonly kind: "reasoning.completed"; readonly itemId: string; readonly text: string }
  | { readonly kind: "tool.started"; readonly itemId: string; readonly tool: ToolCall }
  /** Streamed output of a running tool (a command's stdout). */
  | { readonly kind: "tool.output"; readonly itemId: string; readonly text: string }
  | {
      readonly kind: "tool.completed";
      readonly itemId: string;
      readonly status: "completed" | "failed" | "declined";
      readonly output?: string;
      readonly error?: string;
    }
  /** The turn waits until `AgentTurn.respond` answers it (or the turn is interrupted). */
  | { readonly kind: "request.opened"; readonly requestId: string; readonly request: AgentRequest }
  | { readonly kind: "plan.updated"; readonly steps: readonly PlanStep[] }
  /**
   * Since 1.2: a plan the agent proposes for the user to accept (plan mode),
   * as markdown. The latest one of a thread's latest turn can be implemented.
   */
  | { readonly kind: "plan.proposed"; readonly itemId: string; readonly markdown: string }
  | { readonly kind: "usage"; readonly usage: TokenUsage };

export interface AgentTurn {
  /** Ends when the turn completes; throws when it fails. */
  readonly items: AsyncIterable<AgentItem>;
  /** Asks the agent to stop; `items` then ends early. */
  interrupt(): void;
  /**
   * Answers a request this turn opened; needed only by runtimes that open
   * requests. It may come as soon as `request.opened` is yielded, before the
   * next item is pulled, so a runtime listens for it before yielding.
   */
  respond?(requestId: string, response: AgentResponse): void;
}

/** One choice of a `select` model option (T3 Code's `ProviderOptionChoice`). */
export interface ModelOptionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** What the model does when nobody chose: one choice at most. */
  readonly isDefault?: boolean;
}

/**
 * Something a turn can choose for its model (since 1.2, T3 Code's option
 * descriptors): a `select`, such as the reasoning effort, or a `boolean`,
 * such as fast mode.
 */
export type ModelOptionDescriptor =
  | {
      readonly type: "select";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly options: readonly ModelOptionChoice[];
      /**
       * Choices that are written into the prompt instead of being sent as an
       * option (Claude's "Ultrathink"): the client puts them there.
       */
      readonly promptInjectedValues?: readonly string[];
    }
  | {
      readonly type: "boolean";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
    };

/** A value chosen for one of a model's options. */
export interface ModelOptionSelection {
  readonly id: string;
  readonly value: string | boolean;
}

export interface AgentModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Since 1.2: what a turn can choose for this model; none when absent. */
  readonly options?: readonly ModelOptionDescriptor[];
}

/**
 * The selections that apply to `descriptors`: unknown ids, values a select
 * does not offer and values of the wrong type are dropped (D297).
 */
export function applicableModelOptions(
  descriptors: readonly ModelOptionDescriptor[] | undefined,
  selections: readonly ModelOptionSelection[] | undefined,
): ModelOptionSelection[] {
  if (descriptors === undefined || selections === undefined) return [];
  const result: ModelOptionSelection[] = [];
  for (const selection of selections) {
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined || result.some((kept) => kept.id === selection.id)) continue;
    if (descriptor.type === "boolean" && typeof selection.value === "boolean") {
      result.push({ id: selection.id, value: selection.value });
    } else if (
      descriptor.type === "select" &&
      typeof selection.value === "string" &&
      descriptor.options.some((option) => option.id === selection.value)
    ) {
      result.push({ id: selection.id, value: selection.value });
    }
  }
  return result;
}

export interface AgentRuntimeStatus {
  /** False when the runtime cannot run turns here now (not installed, signed out). */
  readonly available: boolean;
  readonly message?: string;
  readonly version?: string;
}

/**
 * `agent.runtime@1` (D33): anything that executes turns, an own agent loop or a
 * wrapper over an existing agent (Claude Code, Codex, OpenCode). Every field
 * but `agentId` and `startTurn` is optional (added in 1.1).
 */
export interface AgentRuntime {
  /** Recorded on every turn it runs (D52). */
  readonly agentId: string;
  /** Shown in model pickers; `agentId` when absent. */
  readonly name?: string;
  readonly models?: readonly AgentModel[];
  /** The model used when a turn names none; the first of `models` when absent. */
  readonly defaultModel?: string;
  /** Runtime modes it honours; `["full-access"]` when absent. */
  readonly runtimeModes?: readonly RuntimeMode[];
  /** Interaction modes it honours; `["default"]` when absent. */
  readonly interactionModes?: readonly InteractionMode[];
  /** Whether it can run turns now; assumed available when absent. */
  status?(): Promise<AgentRuntimeStatus>;
  startTurn(request: TurnRequest): AgentTurn;
}

/** `agent.registry@1`: the agent runtimes of a node. */
export interface AgentRegistry {
  /** Adds a runtime; its `agentId` must be unique on the node. */
  register(runtime: AgentRuntime): { dispose(): void };
  list(): readonly AgentRuntime[];
  get(agentId: string): AgentRuntime | undefined;
}

/** Event types of a thread's stream `thread/<id>` (D34) and of the `threads` index. */
export const ThreadEvents = {
  /** Thread stream and `threads` index: the thread record. */
  threadCreated: "threads.thread.created",
  /** `threads` index: the thread record after a change (title, archive, settings, last turn). */
  threadUpdated: "threads.thread.updated",
  /** Thread stream and `threads` index: `{ id }`. */
  threadDeleted: "threads.thread.deleted",
  /** `threads` index: the project record. */
  projectCreated: "threads.project.created",
  projectUpdated: "threads.project.updated",
  /** `threads` index: `{ id }`. */
  projectDeleted: "threads.project.deleted",
  /** `{ turnId, agentId, input, model?, runtimeMode?, interactionMode?, modelOptions? }` */
  turnStarted: "agent.turn.started",
  /** `{ turnId, itemId, kind: "tool", tool }`; messages and reasoning start with their first delta. */
  itemStarted: "agent.item.started",
  /** `{ turnId, itemId, kind: "message" | "reasoning" | "tool", text }` */
  itemDelta: "agent.item.delta",
  /** `{ turnId, itemId, kind, text? }`; tools add `status`, `output?`, `error?`. */
  itemCompleted: "agent.item.completed",
  /** `{ turnId, requestId, request }` */
  requestOpened: "agent.request.opened",
  /** `{ turnId, requestId, response? }`: answered, or closed with its turn (no response). */
  requestResolved: "agent.request.resolved",
  /** `{ turnId, steps }` */
  planUpdated: "agent.plan.updated",
  /** `{ turnId, itemId, markdown }`: a plan proposed for the user to accept (since 1.2). */
  planProposed: "agent.plan.proposed",
  /** `{ turnId, usage }` */
  usageUpdated: "agent.usage.updated",
  turnCompleted: "agent.turn.completed",
  turnInterrupted: "agent.turn.interrupted",
  turnFailed: "agent.turn.failed",
} as const;

export const threadStream = (threadId: string) => `thread/${threadId}`;
/** The node's index of projects and threads: one event per record created, changed or deleted. */
export const THREADS_STREAM = "threads";
