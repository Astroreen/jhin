// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: tool
// classification, AskUserQuestion and TodoWrite/Task* parsing, permission results and
// terminal result errors, rewritten without Effect for Jhin's agent.runtime@1.
import type {
  ApprovalDecision,
  PlanStep,
  ToolCall,
  ToolKind,
  TokenUsage,
  UserQuestion,
} from "@jhin/agent-api";
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

type ToolInput = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function firstString(input: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** Tools whose work the client shows as something other than a tool call. */
export const QUESTION_TOOL = "AskUserQuestion";
export const EXIT_PLAN_TOOL = "ExitPlanMode";
export const TODO_TOOL = "TodoWrite";
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);

/** Tools that never become a tool item: questions, plans and task lists have their own items. */
export function isSilentTool(name: string): boolean {
  return (
    name === QUESTION_TOOL || name === EXIT_PLAN_TOOL || name === TODO_TOOL || TASK_TOOLS.has(name)
  );
}

const normalized = (name: string) => name.toLowerCase().replaceAll(/[\s_-]/g, "");

const KINDS: Record<string, ToolKind> = {
  agent: "agent",
  task: "agent",
  bash: "command",
  monitor: "command",
  edit: "file_change",
  multiedit: "file_change",
  notebookedit: "file_change",
  write: "file_change",
  read: "file_read",
  glob: "search",
  grep: "search",
  ls: "search",
  toolsearch: "search",
  webfetch: "web",
  websearch: "web",
  todowrite: "todo",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return KINDS[normalized(name)] ?? "other";
}

/** A tool call's label: what it did, or (`asking`) what it asks to do. */
function title(name: string, kind: ToolKind, asking: boolean): string {
  switch (kind) {
    case "command":
      return asking ? "Run command" : "Ran command";
    case "file_change":
      if (name === "Write") return asking ? "Write file" : "Wrote file";
      return asking ? "Edit file" : "Edited file";
    case "file_read":
      return "Read file";
    case "search":
      return asking ? "Search" : "Searched";
    case "web":
      if (name === "WebSearch") return asking ? "Search the web" : "Searched the web";
      return asking ? "Fetch page" : "Fetched page";
    case "agent":
      return asking ? "Run subagent" : "Ran subagent";
    case "todo":
      return asking ? "Update plan" : "Updated plan";
    case "mcp": {
      const [, server, tool] = name.split("__");
      return `${server ?? "mcp"}: ${tool ?? name}`;
    }
    default:
      return name;
  }
}

function detail(input: unknown): string | undefined {
  const value =
    firstString(input, ["command", "cmd", "script"]) ??
    firstString(input, ["file_path", "notebook_path", "path", "filename"]) ??
    firstString(input, ["pattern", "query", "url"]) ??
    firstString(input, ["description", "prompt", "subject"]);
  if (value !== undefined) return value.length > 400 ? `${value.slice(0, 397)}...` : value;
  if (!isRecord(input) || Object.keys(input).length === 0) return undefined;
  const serialized = stringify(input);
  return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
}

/** How a Claude Code tool call shows in the work log, or (`asking`) in an approval. */
export function toolCall(name: string, input: unknown, asking = false): ToolCall {
  const kind = toolKind(name);
  const subject = detail(input);
  return {
    name,
    kind,
    title: title(name, kind, asking),
    ...(subject === undefined ? {} : { detail: subject }),
    ...(input === undefined ? {} : { input }),
  };
}

/** Questions of an AskUserQuestion call; Claude Code keys the answers by question text. */
export function userQuestions(input: unknown): UserQuestion[] {
  const questions = isRecord(input) ? input["questions"] : undefined;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((value: unknown, index: number): UserQuestion[] => {
    if (!isRecord(value)) return [];
    const question = typeof value["question"] === "string" ? value["question"].trim() : "";
    if (question.length === 0) return [];
    const header =
      typeof value["header"] === "string" && value["header"].trim().length > 0
        ? value["header"].trim()
        : `Question ${index + 1}`;
    const options = Array.isArray(value["options"])
      ? value["options"].flatMap((option: unknown) => {
          if (!isRecord(option)) return [];
          const label = typeof option["label"] === "string" ? option["label"].trim() : "";
          if (label.length === 0) return [];
          const description =
            typeof option["description"] === "string" ? option["description"].trim() : "";
          return [{ label, ...(description.length === 0 ? {} : { description }) }];
        })
      : [];
    return [
      { id: question, header, question, options, multiSelect: value["multiSelect"] === true },
    ];
  });
}

/** Answers in the shape AskUserQuestion takes: one string per question, choices joined. */
export function questionAnswers(
  answers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [
      question,
      typeof answer === "string" ? answer : answer.join(", "),
    ]),
  );
}

/** The steps of a TodoWrite call. */
export function todoSteps(input: unknown): PlanStep[] {
  const todos = isRecord(input) ? input["todos"] : undefined;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo: unknown): PlanStep[] => {
    if (!isRecord(todo)) return [];
    const text = typeof todo["content"] === "string" ? todo["content"].trim() : "";
    if (text.length === 0) return [];
    const status =
      todo["status"] === "completed"
        ? "completed"
        : todo["status"] === "in_progress"
          ? "in_progress"
          : "pending";
    return [{ text, status }];
  });
}

/** The task list kept by Claude Code's TaskCreate/TaskUpdate/TaskList tools, by task id. */
export type TaskList = ReadonlyMap<string, PlanStep>;

function taskStatus(value: unknown): PlanStep["status"] | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

/** The task list after a Task* tool's result; `undefined` when it did not change. */
export function applyTaskTool(
  tasks: TaskList,
  name: string,
  input: unknown,
  result: unknown,
): TaskList | undefined {
  const field = (value: unknown, key: string) => (isRecord(value) ? value[key] : undefined);
  const text = (value: unknown, key: string) => firstString(value, [key]);
  if (name === "TaskList") {
    const listed = field(result, "tasks");
    if (!Array.isArray(listed)) return undefined;
    const next = new Map<string, PlanStep>();
    for (const task of listed) {
      const id = text(task, "id");
      const subject = text(task, "subject");
      const status = taskStatus(field(task, "status"));
      if (id !== undefined && subject !== undefined && status !== undefined) {
        next.set(id, { text: subject, status });
      }
    }
    return next.size === 0 && tasks.size === 0 ? undefined : next;
  }
  if (name === "TaskCreate") {
    const created = field(result, "task");
    const id = text(created, "id");
    const subject = text(created, "subject") ?? text(input, "subject");
    if (id === undefined || subject === undefined) return undefined;
    return new Map(tasks).set(id, { text: subject, status: "pending" });
  }
  if (name !== "TaskUpdate" || field(result, "success") === false) return undefined;
  const id = text(input, "taskId") ?? text(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return undefined;
  if (field(input, "status") === "deleted") {
    const next = new Map(tasks);
    next.delete(id);
    return next;
  }
  const subject = text(input, "subject") ?? task.text;
  const status = taskStatus(field(input, "status")) ?? task.status;
  if (subject === task.text && status === task.status) return undefined;
  return new Map(tasks).set(id, { text: subject, status });
}

/** The plan an ExitPlanMode call proposes, as markdown. */
export function proposedPlan(input: unknown): string | undefined {
  return firstString(input, ["plan"]);
}

/** The SDK's answer to a permission request, from the user's decision. */
export function permissionResult(input: {
  readonly toolName: string;
  readonly decision: ApprovalDecision;
  readonly toolInput: ToolInput;
  readonly toolUseID: string;
  readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
}): PermissionResult {
  if (input.decision === "accept" || input.decision === "accept-for-session") {
    return {
      behavior: "allow",
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === "accept-for-session" ? "user_permanent" : "user_temporary",
      ...(input.decision === "accept-for-session"
        ? { updatedPermissions: sessionPermissionUpdates(input.toolName, input.suggestions) }
        : {}),
    };
  }
  return {
    behavior: "deny",
    message:
      input.decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution.",
    toolUseID: input.toolUseID,
    decisionClassification: "user_reject",
    ...(input.decision === "cancel" ? { interrupt: true } : {}),
  };
}

function sessionPermissionUpdates(
  toolName: string,
  suggestions: readonly PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  const updates = (suggestions ?? []).map((suggestion): PermissionUpdate => ({
    ...suggestion,
    destination: "session",
  }));
  if (updates.length > 0) return updates;
  return [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}

/** Text of a tool result's content: a string, or the text of its blocks. */
export function toolResultText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (!isRecord(block)) return stringify(block);
        if (typeof block["text"] === "string") return block["text"];
        if (block["type"] === "image") return "[image]";
        return stringify(block);
      })
      .join("\n");
  }
  return stringify(content);
}

const CONTEXT_WINDOW_FULL =
  "Claude stopped: the prompt exceeds the model's context window. Start a new thread or ask it to compact.";

function terminalReasonError(
  reason: SDKResultMessage["terminal_reason"],
  hint?: string,
): string | undefined {
  switch (reason) {
    case "api_error":
      return hint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      // Claude Code also ends a turn with blocking_limit once the context window is full:
      // only a usage limit's evidence gives the hint (D1303).
      return hint ?? CONTEXT_WINDOW_FULL;
    case "prompt_too_long":
      return CONTEXT_WINDOW_FULL;
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

/** Whether a result ends the turn because it was stopped. */
export function isAbortedResult(result: SDKResultMessage): boolean {
  if (
    result.terminal_reason === "aborted_tools" ||
    result.terminal_reason === "aborted_streaming"
  ) {
    return true;
  }
  return (
    result.subtype !== "success" && result.errors.join("\n").toLowerCase().includes("interrupt")
  );
}

/**
 * Why a result failed the turn, or `undefined` when it completed. The CLI reports API
 * failures (401, 429, 529) as subtype "success" with `is_error` set; its
 * "[ede_diagnostic]" entries are internal telemetry and never the message.
 */
/**
 * The error a result reports, if any. `hint` is what a failure without its own words says
 * (T3's failureHint): the usage limit's text when a limit stopped the turn (D1303).
 */
export function resultError(result: SDKResultMessage, hint?: string): string | undefined {
  const listed =
    result.subtype === "success" && !result.is_error
      ? undefined
      : ("errors" in result && Array.isArray(result.errors) ? result.errors : []).find(
          (error): error is string =>
            typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
        );
  if (result.subtype !== "success") {
    return (
      listed ??
      terminalReasonError(result.terminal_reason, hint) ??
      hint ??
      result.errors.join("\n")
    );
  }
  const status = result.api_error_status ?? undefined;
  const structured =
    status === 529
      ? "Claude API is overloaded (529). Try again shortly."
      : status === 429
        ? "Claude API rate limit reached. Try again later."
        : terminalReasonError(result.terminal_reason, hint);
  if (!result.is_error && structured === undefined) return undefined;
  return listed ?? structured ?? hint ?? (result.result || "Claude failed without a message.");
}

/** The usage a result reports, with the context the conversation occupies. */
export function resultUsage(result: SDKResultMessage, contextTokens?: number): TokenUsage {
  const usage = result.usage;
  const models = Object.values(result.modelUsage ?? {});
  const contextWindow = models.reduce<number | undefined>(
    (largest, model) =>
      typeof model.contextWindow === "number" && model.contextWindow > (largest ?? 0)
        ? model.contextWindow
        : largest,
    undefined,
  );
  return {
    inputTokens:
      usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    costUsd: result.total_cost_usd,
  };
}

/** Tokens a message's prompt occupied: what the conversation fills of the context window. */
export function promptTokens(usage: {
  readonly input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}
