// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// packages/provider-opencode/src/server/v2/adapter.ts (sessionRules, agentPaths, formQuestions,
// formAnswer, declinedNote, turnTokenUsage, the prompt ids), adapter.ts
// (openCodePermissionRequestKind), toolItems.ts (openCodeToolProjectionKind) and status.ts
// (openCode2ModelCapabilities, inferDefaultVariant, titleCaseSlug) at eb7b35ac,
// rewritten without Effect for Jhin's agent.runtime@1.
import type {
  InteractionMode,
  ModelOptionDescriptor,
  PlanStep,
  RuntimeMode,
  ToolCall,
  ToolKind,
  TokenUsage,
  UserQuestion,
} from "@jhin/agent-api";

import type { ModelRef, PermissionRule } from "./client.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rule = (action: string, effect: PermissionRule["effect"]): PermissionRule => ({
  action,
  resource: "*",
  effect,
});

/**
 * A session's rules (D328); the last matching rule wins. Plan mode writes only its plan,
 * which `paths` allows again. Shell and read are never denied: OpenCode's free tier refuses
 * sessions whose rules deny them.
 */
export function sessionRules(
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
  paths: readonly PermissionRule[],
  grants: readonly PermissionRule[],
): PermissionRule[] {
  const fullAccess = runtimeMode === "full-access";
  return [
    ...(fullAccess
      ? [rule("*", "allow")]
      : [
          rule("shell", "ask"),
          rule("edit", runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
          rule("external_directory", "ask"),
        ]),
    ...(fullAccess ? [] : grants),
    ...(interactionMode === "plan" ? [rule("edit", "deny")] : []),
    ...(fullAccess && interactionMode !== "plan" ? [] : paths),
  ];
}

/** An agent's own path rules: what it may write without asking (the plan agent's plan file). */
export function agentPaths(rules: readonly PermissionRule[] = []): PermissionRule[] {
  return rules.filter(
    (entry) =>
      entry.effect === "allow" &&
      entry.resource !== "*" &&
      (entry.action === "edit" || entry.action === "external_directory"),
  );
}

export function sameRules(
  left: readonly PermissionRule[] | undefined,
  right: readonly PermissionRule[],
): boolean {
  return (
    left?.length === right.length &&
    left.every(
      (entry, index) =>
        entry.action === right[index]?.action &&
        entry.resource === right[index]?.resource &&
        entry.effect === right[index]?.effect,
    )
  );
}

/** OpenCode's agent for an interaction mode. */
export const agentFor = (interactionMode: InteractionMode) =>
  interactionMode === "plan" ? "plan" : "build";

/** `provider/model`, split at the first slash; `undefined` when either side is empty. */
export function parseModel(model: string): ModelRef | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

export const malformedModel = (model: string) =>
  `OpenCode model '${model}' must use provider/model format`;

/** `xhigh-thinking` → `Xhigh Thinking`, as T3 labels a variant. */
function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/** The variant a provider's model uses when nobody chose one (T3's inferDefaultVariant). */
function defaultVariant(providerID: string, variants: readonly string[]): string | undefined {
  if (variants.length === 1) return variants[0];
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

/** A "Reasoning" select of the model's variants, none without any (D882). */
export function variantOptions(model: {
  readonly providerID: string;
  readonly variants?: readonly { readonly id: string }[];
}): ModelOptionDescriptor[] {
  const variants = (model.variants ?? [])
    .map((variant) => variant?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (variants.length === 0) return [];
  const fallback = defaultVariant(model.providerID, variants);
  return [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: variants.map((id) => ({
        id,
        label: titleCaseSlug(id),
        ...(id === fallback ? { isDefault: true } : {}),
      })),
    },
  ];
}

export const sameModel = (left: ModelRef, right: ModelRef | undefined) =>
  left.providerID === right?.providerID &&
  left.id === right?.id &&
  (left.variant ?? "default") === (right?.variant ?? "default");

/**
 * OpenCode takes a client id (it must start with `msg_`) and answers a repeat of one with the
 * message it has; the id is unique across the server, so it names the session too.
 */
/** A steer's client id: unique per turn, so a repeat is answered with the one OpenCode has. */
export const steerPromptId = (sessionId: string, turnId: string, index: number) =>
  `msg_jhin_steer_${sessionId}:${turnId}:${index}`;

export const turnPromptId = (sessionId: string, turnId: string) =>
  `msg_jhin_turn_${sessionId}:${turnId}`;

/** `/name rest` of a slash command. */
export function commandOf(text: string): { name: string; text: string } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? undefined : { name: match[1]!, text: match[2] ?? "" };
}

// --- Requests -------------------------------------------------------------------

/** A reject without a message is OpenCode's "stop": it ends the whole execution (cancel). */
export const DECLINED = "The user declined this request.";

/**
 * Steered into the session before a decline: a declined shell call reaches the model only as
 * "Unable to execute command", which it retries.
 */
export const declinedNote = (action: string, resources: readonly string[]) =>
  `The user declined the ${action} request${resources.length === 0 ? "" : ` (${resources.join(", ")})`}. Do not retry it; continue without it or ask the user how to proceed.`;

/** The kind of request a permission is, from its action or its tool (T3's request kind). */
export function permissionKind(action: string, toolName?: string): ToolKind {
  const tool = toolName?.toLowerCase();
  const changes = new Set(["edit", "write", "patch", "apply_patch"]);
  if (changes.has(action) || (tool !== undefined && changes.has(tool))) return "file_change";
  const reads = new Set(["read", "glob", "grep", "lsp", "external_directory"]);
  if (
    reads.has(action) ||
    tool === "read" ||
    (tool !== undefined && ["glob", "grep", "search"].some((part) => tool.includes(part)))
  ) {
    return action === "read" || tool === "read" ? "file_read" : "search";
  }
  return "command";
}

export interface FormField {
  readonly key: string;
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly when?: readonly unknown[];
  readonly custom?: boolean;
  readonly options?: readonly { value: string; label?: string; description?: string }[];
}

export interface Form {
  readonly id: string;
  readonly sessionID: string;
  readonly title?: string;
  readonly fields: readonly FormField[];
}

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

/** A form's questions, or what it asks that Jhin cannot show. */
export function formQuestions(
  form: Form,
): { readonly questions: UserQuestion[] } | { readonly unsupported: string } {
  const questions: UserQuestion[] = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type === "external") return { unsupported: "a link to open" };
    if (field.type !== "string" && field.type !== "multiselect") {
      return { unsupported: `a ${field.type} value` };
    }
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = text(field.title, `Question ${index + 1}`);
    const options = (field.options ?? []).map((option) => {
      const label = text(option.label, text(option.value, "Option"));
      return { label, description: text(option.description, label) };
    });
    questions.push({
      id: field.key,
      header,
      question: text(field.description, header),
      options,
      multiSelect: field.type === "multiselect",
      allowCustomAnswer: field.custom === true || options.length === 0,
    });
  }
  return { questions };
}

export const unsupportedForm = (what: string) =>
  `OpenCode asked for ${what}, which Jhin can't show. The question was declined.`;

/**
 * The form's answer: option labels back to their values, several choices of a single-answer
 * field joined with ", ".
 */
export function formAnswer(
  form: Form,
  answers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | string[]> {
  const answer: Record<string, string | string[]> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (typeof raw === "string" ? [raw] : (raw ?? []))
      .filter((value) => value.trim().length > 0)
      .map((value) => {
        const option = field.options?.find(
          (entry) => text(entry.label, text(entry.value, "Option")) === value,
        );
        return option?.value ?? value;
      });
    if (values.length > 0) {
      answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
    }
  }
  return answer;
}

// --- Tools ----------------------------------------------------------------------

/** Tools that never become a tool item: questions are forms, todos are plans (D333). */
export const isSilentTool = (name: string) => name === "question" || name === "todowrite";

/** T3's openCodeToolProjectionKind, in Jhin's kinds. */
export function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase();
  if (normalized === "todowrite") return "todo";
  if (normalized === "subagent" || normalized === "task") return "agent";
  if (normalized.includes("bash") || normalized.includes("shell")) return "command";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web") || normalized === "codesearch" || normalized === "code_search") {
    return "web";
  }
  if (normalized === "read") return "file_read";
  if (["glob", "grep", "search", "lsp"].some((part) => normalized.includes(part))) return "search";
  return "other";
}

function firstString(input: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function title(name: string, kind: ToolKind, asking: boolean): string {
  switch (kind) {
    case "command":
      return asking ? "Run command" : "Ran command";
    case "file_change":
      if (name.toLowerCase() === "write") return asking ? "Write file" : "Wrote file";
      return asking ? "Edit file" : "Edited file";
    case "file_read":
      return "Read file";
    case "search":
      return asking ? "Search" : "Searched";
    case "web":
      if (name.toLowerCase().includes("search")) {
        return asking ? "Search the web" : "Searched the web";
      }
      return asking ? "Fetch page" : "Fetched page";
    case "agent":
      return asking ? "Run subagent" : "Ran subagent";
    case "todo":
      return asking ? "Update plan" : "Updated plan";
    default:
      return name;
  }
}

function detail(input: unknown): string | undefined {
  const value =
    firstString(input, ["command", "cmd"]) ??
    firstString(input, ["filePath", "path", "file"]) ??
    firstString(input, ["pattern", "query", "url"]) ??
    firstString(input, ["description", "prompt"]);
  if (value !== undefined) return value.length > 400 ? `${value.slice(0, 397)}...` : value;
  if (!isRecord(input) || Object.keys(input).length === 0) return undefined;
  const serialized = JSON.stringify(input);
  return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
}

/** How an OpenCode tool call shows in the work log, or (`asking`) in an approval. */
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

/** An approval of a permission without a known tool call: its action and resources. */
export function permissionTool(action: string, resources: readonly string[], toolName?: string) {
  const kind = permissionKind(action, toolName);
  const name = toolName ?? action;
  return {
    name,
    kind,
    title: title(kind === "file_change" ? "edit" : name, kind, true),
    detail: resources.length === 0 ? action : resources.join("\n"),
  } satisfies ToolCall;
}

/** The text of a tool's content (`{ type: "text", text }` parts). */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) =>
      isRecord(part) && part["type"] === "text" && typeof part["text"] === "string"
        ? [part["text"]]
        : [],
    )
    .join("\n");
}

/** The steps of a `todowrite` call. */
export function todoSteps(input: unknown): PlanStep[] {
  const todos = isRecord(input) ? input["todos"] : undefined;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo: unknown): PlanStep[] => {
    if (!isRecord(todo)) return [];
    const content = typeof todo["content"] === "string" ? todo["content"].trim() : "";
    if (content.length === 0) return [];
    const status =
      todo["status"] === "completed"
        ? "completed"
        : todo["status"] === "in_progress"
          ? "in_progress"
          : "pending";
    return [{ text: content, status }];
  });
}

// --- Usage ----------------------------------------------------------------------

export interface StepTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

export function isStepTokens(value: unknown): value is StepTokens {
  return (
    isRecord(value) &&
    typeof value["input"] === "number" &&
    typeof value["output"] === "number" &&
    isRecord(value["cache"])
  );
}

/** A turn's usage so far: its steps summed, the context from the last one (D334). */
export function usageOf(
  steps: readonly StepTokens[],
  cost: number,
  contextWindow: number | undefined,
): TokenUsage {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const tokens of steps) {
    input += tokens.input + tokens.cache.read + tokens.cache.write;
    output += tokens.output + (tokens.reasoning ?? 0);
    cached += tokens.cache.read;
  }
  const last = steps.at(-1);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    ...(last === undefined
      ? {}
      : {
          contextTokens: last.input + last.cache.read + last.cache.write + last.output,
        }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    // OpenCode writes 0 for unknown or subscription pricing.
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
}
