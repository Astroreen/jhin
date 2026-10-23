import type { StoredEvent } from "@jhin/storage-api";

/** `agent.runtime@1`: a node's single agent runtime (the simplest way to add one). */
export const AGENT_RUNTIME_CAPABILITY = "agent.runtime";
/**
 * `agent.registry@1`: every agent runtime of a node, provided by the threads
 * plugin. Runtime plugins require it and register themselves, so one node can
 * run several agents (Claude Code, Codex, an own loop) side by side.
 */
export const AGENT_REGISTRY_CAPABILITY = "agent.registry";

export * from "./modes.ts";
export * from "./usage-limits.ts";
export * from "./agents.ts";
export * from "./messages.ts";
export * from "./teams.ts";
export * from "./orchestration.ts";
export * from "./context.ts";
export * from "./citations.ts";
export * from "./context-schema.ts";
export * from "./writer.ts";
export * from "./project-scripts.ts";

import { contextReferencesAsLabels } from "./context.ts";
import type { InteractionMode, RuntimeMode } from "./modes.ts";
import type { AgentUsageLimits } from "./usage-limits.ts";

/** D54's form: an image inlined as a data URL, still accepted and read from older events. */
export interface InlineImageAttachment {
  readonly kind: "image";
  readonly name: string;
  readonly mimeType: string;
  /** `data:<mime>;base64,…` */
  readonly dataUrl: string;
}

/**
 * Since 1.2: a file uploaded to the node (`attachments.*`), referred to by id
 * (D293). Images and any other file.
 */
export interface StoredAttachment {
  readonly kind: "image" | "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** A file sent with a message, as a turn's first event records it. */
export type TurnAttachment = InlineImageAttachment | StoredAttachment;

/** A stored attachment as a runtime gets it: with its bytes and, where there is one, its file (D294). */
export interface ResolvedAttachment extends StoredAttachment {
  read(): Promise<Uint8Array>;
  /** The local file that holds it, for an agent that reads files. */
  readonly path?: string;
}

export type RuntimeAttachment = InlineImageAttachment | ResolvedAttachment;

export interface TurnInput {
  readonly text: string;
  readonly attachments?: readonly TurnAttachment[];
}

export interface TurnRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: {
    readonly text: string;
    readonly attachments?: readonly RuntimeAttachment[];
  };
  /**
   * Every earlier event the thread still shows, oldest first: without the
   * turns a rollback dropped (`visibleThreadEvents`; since `agent.registry` 1.1). A runtime
   * that keeps its own conversation checks it against this.
   */
  readonly history: readonly StoredEvent[];
  /** Where the agent works: the thread's worktree, else its project's directory. */
  readonly cwd: string;
  /** One of the runtime's `models`; its default model when absent. */
  readonly model?: string;
  /** `DEFAULT_RUNTIME_MODE` when absent. */
  readonly runtimeMode?: RuntimeMode;
  /** `default` when absent. */
  readonly interactionMode?: InteractionMode;
  /**
   * Since 1.3: what the agent is told besides the conversation: a defined agent's
   * role, instructions and where its inherited knowledge is (D605). Runtimes
   * add it to their system prompt; one that cannot still runs the turn.
   */
  readonly instructions?: string;
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

/**
 * An MCP app a tool call returned (T3's `McpAppReference`, the MCP Apps extension's `ui://`
 * resource): its document, kept by the agent's runtime under `documentId`, is shown in a
 * sandboxed frame that may call the server's tools through the runtime (D1401, D1402).
 */
export interface AgentMcpApp {
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly documentId: string;
  /** The origins the document may reach, as its server declared them. */
  readonly csp?: {
    readonly connectDomains?: readonly string[];
    readonly resourceDomains?: readonly string[];
    readonly frameDomains?: readonly string[];
    readonly baseUriDomains?: readonly string[];
  };
  /** The browser features it asked for (`camera`, `microphone`, `geolocation`, `clipboardWrite`). */
  readonly permissions?: readonly ("camera" | "microphone" | "geolocation" | "clipboardWrite")[];
  readonly prefersBorder?: boolean;
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
  /**
   * Since 1.5: a prefilled answer for the user to edit (T3's `initialAnswer`, an editor
   * prompt). The answer goes back exactly as edited, white space and all (t3-parity.md D1001).
   */
  readonly initialAnswer?: string;
}

/** Something the agent needs from the user before it can go on. */
export type AgentRequest =
  | {
      readonly kind: "approval";
      /** The tool call waiting for permission. */
      readonly tool: ToolCall;
      readonly reason?: string;
      /**
       * Since 1.9: an app asks for access (T3's MCP elicitation, providers.md D1146): `app`
       * names it, the tool's `detail` is what it asks.
       */
      readonly access?: { readonly app: string };
      /**
       * Since 1.9: the decisions the agent takes; when absent, all of them but
       * `accept-always` (since 1.13), which an agent offers only by naming it.
       */
      readonly decisions?: readonly ApprovalDecision[];
      /**
       * Since 1.13: the agent's own words for a decision, e.g. an elicitation's label for
       * its session allowance (providers.md D1316).
       */
      readonly labels?: Readonly<Partial<Record<ApprovalDecision, string>>>;
    }
  | { readonly kind: "user-input"; readonly questions: readonly UserQuestion[] };

/**
 * The answers to an approval. `accept-always` (since 1.13, T3's "Always allow") approves
 * for good, as far as the agent keeps it (providers.md D1316).
 */
export const APPROVAL_DECISIONS = [
  "accept",
  "accept-for-session",
  "accept-always",
  "decline",
  "cancel",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** The decisions an approval offers: its own, else all of them but `accept-always`. */
export function approvalDecisions(
  request: Extract<AgentRequest, { kind: "approval" }>,
): readonly ApprovalDecision[] {
  return request.decisions ?? APPROVAL_DECISIONS.filter((decision) => decision !== "accept-always");
}

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
      /** Since 1.15: the MCP app the call returned, to show in its place (providers.md D1401). */
      readonly app?: AgentMcpApp;
    }
  /** The turn waits until `AgentTurn.respond` answers it (or the turn is interrupted). */
  | { readonly kind: "request.opened"; readonly requestId: string; readonly request: AgentRequest }
  | { readonly kind: "plan.updated"; readonly steps: readonly PlanStep[] }
  /**
   * Since 1.2: a plan the agent proposes for the user to accept (plan mode),
   * as markdown. The latest one of a thread's latest turn can be implemented.
   */
  | { readonly kind: "plan.proposed"; readonly itemId: string; readonly markdown: string }
  | { readonly kind: "usage"; readonly usage: TokenUsage }
  /**
   * Since 1.4: a subagent the agent started inside the turn (Claude Code's
   * `Agent` tool), shown as a child thread of the thread (orchestration.md
   * D876). `subagentId` names it in the items that follow.
   */
  | {
      readonly kind: "subagent.started";
      readonly subagentId: string;
      readonly title: string;
      readonly prompt: string;
      readonly model?: string;
    }
  /** Since 1.4: an item of a subagent's own work: its messages, reasoning and tool calls. */
  | { readonly kind: "subagent.item"; readonly subagentId: string; readonly item: SubagentWorkItem }
  /**
   * Since 1.7: the subagent goes on in the background; the turn's end leaves
   * it running and its later items come through `AgentTurn.afterwards`
   * (orchestration.md D1164).
   */
  | { readonly kind: "subagent.backgrounded"; readonly subagentId: string }
  /**
   * Since 1.12: a line on what a running subagent is doing now (Claude Code's
   * `task_progress`, orchestration.md D1343).
   */
  | { readonly kind: "subagent.progress"; readonly subagentId: string; readonly progress: string }
  /** Since 1.4: a subagent ended. */
  | {
      readonly kind: "subagent.ended";
      readonly subagentId: string;
      readonly status: "completed" | "failed" | "interrupted";
      readonly error?: string;
    }
  /**
   * Since 1.6: the agent compacted its context inside the turn (Claude Code's
   * compact boundary, Codex's context compaction): what it knew of the
   * conversation is now a summary. Refocus follows it (agents.md D709).
   */
  | { readonly kind: "context.compacted"; readonly trigger?: "auto" | "manual" }
  /**
   * Since 1.10: the thread's goal changed (Codex's `/goal`, providers.md D1149); `null` once
   * it is cleared.
   */
  | { readonly kind: "goal.updated"; readonly goal: AgentGoal | null };

/** A goal the agent keeps working toward across turns (T3's OrchestrationV2ProviderGoal). */
export interface AgentGoal {
  readonly objective: string;
  readonly status:
    | "active"
    | "paused"
    | "blocked"
    | "usage_limited"
    | "budget_limited"
    | "complete";
  readonly tokensUsed?: number;
  readonly tokenBudget?: number;
  readonly timeUsedSeconds?: number;
}

/** The kinds of items a subagent's thread shows (D877); a runtime's others stay in the turn. */
export const SUBAGENT_WORK_KINDS = [
  "message.delta",
  "message.completed",
  "reasoning.delta",
  "reasoning.completed",
  "tool.started",
  "tool.completed",
] as const;

export type SubagentWorkItem = Extract<
  AgentItem,
  { readonly kind: (typeof SUBAGENT_WORK_KINDS)[number] }
>;

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
  /**
   * Since 1.2, for runtimes with `steering`: hands a message to the running
   * turn, which takes it into the work it is doing (a steer). Throws when the
   * turn can take nothing more (it ended or is ending): the message then goes
   * to a turn of its own.
   */
  steer?(input: TurnRequest["input"]): void;
  /**
   * Since 1.7: the later work of the turn's backgrounded subagents
   * (`subagent.backgrounded`), read once `items` ended: their `subagent.item`,
   * `subagent.progress` (since 1.12) and `subagent.ended` items only. Ends
   * once each has ended, or when the runtime can no longer follow them; one
   * still open then ended `interrupted` (D1164).
   */
  readonly afterwards?: AsyncIterable<
    Extract<AgentItem, { readonly kind: "subagent.item" | "subagent.progress" | "subagent.ended" }>
  >;
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

/**
 * Claude's prompt-injected effort as T3 writes it (`applyClaudePromptEffortPrefix`):
 * "Ultrathink:" before the trimmed prompt, never before a slash command (it would
 * become prose) nor twice. The one rule both the composer and the runtime apply.
 */
export function applyUltrathinkPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || /^\/[^\s/]+(?:\s|$)/u.test(trimmed) || trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
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

/** A command the agent runs itself, typed as `/name` (since 1.2, T3's slash commands). */
export interface AgentSlashCommand {
  readonly name: string;
  readonly description?: string;
  /** What to type after it, e.g. `<file>`. */
  readonly input?: { readonly hint: string };
}

/**
 * A new global pattern of a skill mention in a message: any currency symbol, then the
 * name, not an amount (T3's SKILL_MENTION_PATTERN, the token the composer's chips
 * recognise). Group 1 is the space before it, group 2 the name. A new one per call, so no
 * caller shares another's `lastIndex`.
 */
export const skillMentionPattern = () =>
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/** A skill the user can invoke by name (`$name`, since 1.2). */
export interface AgentSkill {
  readonly name: string;
  readonly description?: string;
  /** Where its instructions are, e.g. a SKILL.md file. */
  readonly path: string;
  /** Where it comes from, e.g. `user` or `project`. */
  readonly scope?: string;
  readonly displayName?: string;
}

export interface AgentRuntimeStatus {
  /** False when the runtime cannot run turns here now (not installed, signed out). */
  readonly available: boolean;
  readonly message?: string;
  readonly version?: string;
  /** Since 1.11: whether an account is signed in, for a runtime with `auth`. */
  readonly signedIn?: boolean;
}

/** How a sign-in goes on (providers.md D1151): T3's browser and device-code interactions. */
export type AgentSignInMethod = "browser" | "device-code";

/** A sign-in under way: open `url`, and enter `userCode` there for a device code. */
export interface AgentSignIn {
  readonly flowId: string;
  readonly url: string;
  readonly userCode?: string;
}

/** Since 1.11: signing the runtime's account in and out from Jhin (T3's provider auth). */
export interface AgentAuth {
  readonly methods: readonly AgentSignInMethod[];
  start(method: AgentSignInMethod): Promise<AgentSignIn>;
  /** Settles once the sign-in ends: signed in, failed or cancelled. */
  wait(flowId: string): Promise<{ readonly success: boolean; readonly error?: string }>;
  cancel(flowId: string): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * `agent.runtime@1` (D33): anything that executes turns, an own agent loop or a
 * wrapper over an existing agent (Claude Code, Codex, OpenCode). Every field
 * but `agentId` and `startTurn` is optional (added in 1.1 to 1.3; 1.4 adds subagent items, 1.5 a question's `initialAnswer`, 1.6 `context.compacted`, 1.7 background subagents and `stopSubagent`, 1.8 `usageLimits`, 1.9 an approval's `access` and `decisions`, 1.10 `goal.updated`, 1.11 `auth`, 1.12 `subagent.progress`, 1.13 `accept-always` and an approval's `labels`, 1.14 `uploadFeedback`, 1.15 MCP apps: a tool call's `app` and `mcpApps`).
 */
export interface AgentRuntime {
  /** Recorded on every turn it runs (D52). */
  readonly agentId: string;
  /**
   * Since 1.3: the runtime that executes this agent's turns, when it is not a
   * runtime itself: a defined agent (D601, D603). Recorded on its turns next
   * to `agentId`; absent means `agentId`.
   */
  readonly runtimeId?: string;
  /** Since 1.3: what a defined agent does, a short job description (D603). */
  readonly role?: string;
  /** Shown in model pickers; `agentId` when absent. */
  readonly name?: string;
  readonly models?: readonly AgentModel[];
  /** The model used when a turn names none; the first of `models` when absent. */
  readonly defaultModel?: string;
  /** Runtime modes it honours; `["full-access"]` when absent. */
  readonly runtimeModes?: readonly RuntimeMode[];
  /** Interaction modes it honours; `["default"]` when absent. */
  readonly interactionModes?: readonly InteractionMode[];
  /** Since 1.2: its turns take messages while they run (`AgentTurn.steer`). */
  readonly steering?: boolean;
  /**
   * Since 1.2: the commands and skills a user can invoke in a folder, from the
   * agent's own initialization (D300). None when absent.
   */
  commands?(request: { readonly cwd: string }): Promise<{
    readonly commands: readonly AgentSlashCommand[];
    readonly skills: readonly AgentSkill[];
  }>;
  /** Whether it can run turns now; assumed available when absent. */
  status?(): Promise<AgentRuntimeStatus>;
  /**
   * Since 1.7: stops a subagent a turn of the thread started; false when it
   * cannot (it is unknown, ended or unstoppable). Its end comes as its
   * `subagent.ended` (D1166).
   */
  stopSubagent?(request: {
    readonly threadId: string;
    readonly subagentId: string;
  }): Promise<boolean>;
  /**
   * Since 1.8: what the account it runs on may still spend (providers.md D1141); undefined
   * when it cannot tell now. A runtime without it has no usage limits to show.
   */
  usageLimits?(): Promise<AgentUsageLimits | undefined>;
  /** Since 1.11: signing its account in and out (providers.md D1151). */
  readonly auth?: AgentAuth;
  /**
   * Since 1.14: sends a thread's conversation and the agent's logs to its maker (T3's
   * `uploadFeedback`, Codex's `feedback/upload`, providers.md D1317); answers the id the
   * maker knows it by. A runtime without it takes no feedback.
   */
  uploadFeedback?(request: {
    readonly threadId: string;
    readonly reason?: string;
  }): Promise<{ readonly feedbackId: string }>;
  /**
   * Since 1.15: the MCP apps its tool calls returned (D1401, D1402): an app's document, and
   * its calls on the thread's running agent, each named by the app's `documentId`: it goes to
   * the app's own server, and only to a tool the server lets apps call. One that cannot
   * throws an `McpAppRequestError`.
   */
  readonly mcpApps?: {
    document(request: {
      readonly threadId: string;
      readonly documentId: string;
    }): Promise<string | undefined>;
    callTool(request: {
      readonly threadId: string;
      readonly documentId: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
    readResource(request: {
      readonly threadId: string;
      readonly documentId: string;
      readonly uri: string;
    }): Promise<unknown>;
  };
  startTurn(request: TurnRequest): AgentTurn;
}

/** Why an MCP app's call was refused (T3's `McpAppRequestError` reasons, D1402). */
export type McpAppRequestReason = "not-an-app" | "tool-not-callable" | "session-stopped";

/** An MCP app's call the runtime refused: not an app of the thread, a tool apps may not call, or no running agent. */
export class McpAppRequestError extends Error {
  readonly reason: McpAppRequestReason;
  constructor(reason: McpAppRequestReason, message: string) {
    super(message);
    this.name = "McpAppRequestError";
    this.reason = reason;
  }
}

/** The reason an error an app's call threw carries, if any (also across copies of this package). */
export function mcpAppRequestReasonOf(error: unknown): McpAppRequestReason | undefined {
  if ((error as { name?: unknown } | null)?.name !== "McpAppRequestError") return undefined;
  const reason = (error as { reason?: unknown }).reason;
  return reason === "not-an-app" || reason === "tool-not-callable" || reason === "session-stopped"
    ? reason
    : undefined;
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
  /**
   * `{ turnId, agentId, runtimeId?, input, model?, runtimeMode?, interactionMode?, modelOptions?, messageId?,
   * handoff?, origin? }`; `runtimeId` only when the agent is not a runtime itself (D601).
   * `origin` (`MessageOrigin`) names the message between agents the turn answers (agents.md D623).
   * `handoff` (`{ kind: "merge-back", threadId, turnId }`) says the agent got a
   * fork's result before `input.text`. In a fork, events copied from its parent
   * carry `inheritedAt`, their original time.
   */
  turnStarted: "agent.turn.started",
  /** `{ turnId, messageId, input }`: a message the running turn took (a steer, D205). */
  turnSteered: "agent.turn.steered",
  /** Thread stream: the thread's queue after a change (D201). */
  queueUpdated: "threads.queue.updated",
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
  /** `{ turnId, trigger? }`: the agent compacted its context (since 1.6, agents.md D709). */
  contextCompacted: "agent.context.compacted",
  /** `{ turnId, goal }`: the thread's goal, `null` once cleared (since 1.10, providers.md D1149). */
  goalUpdated: "agent.goal.updated",
  turnCompleted: "agent.turn.completed",
  turnInterrupted: "agent.turn.interrupted",
  /** `{ turnId, error?, failure? }`; `failure` (since 1.8, `AgentTurnFailure`) says why. */
  turnFailed: "agent.turn.failed",
  /**
   * Thread stream: `{ turnIds, toTurnId? }`, the turns a rollback dropped
   * (oldest first) and the turn kept last. Their events stay in the log;
   * readers skip them (`visibleThreadEvents`).
   */
  threadRolledBack: "threads.thread.rolled-back",
  /**
   * Thread stream of a fork: `{ threadId, turnId }`, the parent and the turn it
   * was forked at, after the events copied from the parent.
   */
  threadForked: "threads.thread.forked",
  /**
   * Thread stream: a subagent the turn's agent started, shown as the child
   * thread `childThreadId` (`{ turnId, subagentId, childThreadId, title }`, D877).
   */
  subagentStarted: "threads.subagent.started",
} as const;

/**
 * Hooks of `jhin.threads` (kernel hooks: `before`, `around`, `after`). Other
 * plugins hook in here instead of following events, when they must act
 * before the agent starts or before clients learn that a turn ended.
 */
export const ThreadHooks = {
  /** `{ thread, text }` → the title of a thread named by its first message. */
  title: "threads.title",
  /**
   * `TurnHookInput`, run after `agent.turn.started` is recorded and before the
   * agent starts: whatever it does happens before the agent touches anything.
   * A hook that throws, or does not answer within `jhin.threads`'
   * `turnHookTimeoutSeconds`, fails the turn; the agent never starts. A hook
   * given up on is not cancelled: one that may still run when the thread's
   * next turn starts keeps its work apart (the checkpoints lock per directory).
   */
  turnStart: "threads.turn.start",
  /**
   * `TurnEndHookInput`, run once the agent is done (or given up on) and before
   * the turn's last event is recorded: clients that see the turn end see what
   * the hook did. A hook that throws, or does not answer in time, is logged;
   * the turn still ends.
   */
  turnEnd: "threads.turn.end",
  /**
   * `{ thread, turnIds, toTurnId?, restoreFiles? }`, around a rollback's
   * recording (D220): a hook may restore what the dropped turns changed (asked
   * to with `restoreFiles`, D257), delay or refuse it; it cannot change which
   * turns are dropped.
   */
  rollback: "threads.rollback",
} as const;

/** What the turn hooks get: the turn and where its agent runs. */
export interface TurnHookInput {
  readonly threadId: string;
  readonly projectId: string;
  readonly turnId: string;
  readonly agentId: string;
  /** The directory the agent runs in: the thread's worktree, else its project's. */
  readonly cwd: string;
}

export interface TurnEndHookInput extends TurnHookInput {
  /** How the turn ends. */
  readonly status: "completed" | "interrupted" | "failed";
}

/**
 * The events a thread still shows: those of turns a rollback dropped and the
 * rollback events themselves are left out (turn ids are never reused).
 */
export function visibleThreadEvents<T extends StoredEvent>(events: readonly T[]): T[] {
  const dropped = new Set<unknown>();
  for (const event of events) {
    if (event.type !== ThreadEvents.threadRolledBack) continue;
    const turnIds = (event.payload as { turnIds?: unknown } | null)?.turnIds;
    if (Array.isArray(turnIds)) for (const turnId of turnIds) dropped.add(turnId);
  }
  return events.filter(
    (event) =>
      event.type !== ThreadEvents.threadRolledBack &&
      (dropped.size === 0 || !dropped.has((event.payload as { turnId?: unknown } | null)?.turnId)),
  );
}

export const threadStream = (threadId: string) => `thread/${threadId}`;
/** The node's index of projects and threads: one event per record created, changed or deleted. */
export const THREADS_STREAM = "threads";

/**
 * The conversation an agent has not seen, as context for the first message it gets: every
 * earlier turn of a thread whose turns ran on other agents before this one joined (no
 * `since`), or the turns after the agent's last one (`since`: its agent id) of a thread that
 * went to another agent and came back; turns are told apart by `runtimeId ?? agentId`
 * (D610). `undefined` when there is none, also when `since`
 * names an agent with no turn in the history (its session already holds what it saw).
 * The text ends with a line saying the user's new message follows.
 */
/**
 * An earlier user message as a joining agent reads it: its references by their labels (D1006),
 * not their records again, which its own agent read then and which would be replayed with every
 * new session.
 */
function userText(input: unknown): string | undefined {
  const message = input as { text?: unknown } | undefined;
  if (typeof message?.text !== "string") return undefined;
  return contextReferencesAsLabels(message.text);
}

export function historyTranscript(
  history: readonly StoredEvent[],
  since?: string,
): string | undefined {
  const turns: { agentId: unknown; lines: string[] }[] = [];
  const byId = new Map<unknown, { agentId: unknown; lines: string[] }>();
  for (const event of history) {
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") continue;
    if (event.type === ThreadEvents.turnStarted) {
      // A defined agent's turn ran on its runtime (D601, D610): it counts as that runtime's.
      const turn = { agentId: payload["runtimeId"] ?? payload["agentId"], lines: [] as string[] };
      turns.push(turn);
      byId.set(payload["turnId"], turn);
      const text = userText(payload["input"]);
      if (text !== undefined) turn.lines.push(`User: ${text}`);
    } else if (event.type === ThreadEvents.turnSteered) {
      // A message steered into a turn is the user's too.
      const turn = byId.get(payload["turnId"]) ?? turns.at(-1);
      const text = userText(payload["input"]);
      if (text !== undefined) turn?.lines.push(`User: ${text}`);
    } else if (event.type === ThreadEvents.itemCompleted && payload["kind"] === "message") {
      const turn = byId.get(payload["turnId"]) ?? turns.at(-1);
      if (typeof payload["text"] === "string") turn?.lines.push(`Assistant: ${payload["text"]}`);
    }
  }
  const last = since === undefined ? -1 : turns.findLastIndex((turn) => turn.agentId === since);
  if (since !== undefined && last === -1) return undefined;
  const lines = turns.slice(last + 1).flatMap((turn) => turn.lines);
  if (lines.length === 0) return undefined;
  return [
    since === undefined
      ? "This thread started before you joined it. The conversation so far:"
      : "Since your last turn this thread went on with another agent. The conversation since then:",
    "",
    ...lines,
    "",
    "The user's new message follows.",
    "",
  ].join("\n");
}

/**
 * The variables of `source` an agent runtime passes on (D346): those `inherit` names, exactly
 * or by a prefix ending in `*`; `["*"]` is every one. Pure, so it stays isomorphic: a server
 * runtime hands it `process.env`.
 */
export function pickEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  inherit: readonly string[] = ["*"],
): Record<string, string | undefined> {
  const exact = new Set(inherit.filter((name) => !name.endsWith("*")));
  const prefixes = inherit.filter((name) => name.endsWith("*")).map((name) => name.slice(0, -1));
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix)),
    ),
  );
}
