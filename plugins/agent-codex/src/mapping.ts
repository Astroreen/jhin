// Derived from T3 Code (https://github.com/pingdotgg/t3code) at eb7b35ac:
// apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts (codexRuntimeModeTurnDefaults,
// buildCodexTurnStartParams, codexFileChangeApprovalPrompt, webSearchPatterns, the approval
// and user-input answers, codexProviderTurnTokenUsage, codexPlanStepStatus),
// apps/server/src/provider/CodexProvider.ts (codexPlanLabel, the account labels,
// mapCodexModelCapabilities), apps/server/src/codexModelOptions.ts and
// packages/shared/src/model.ts (formatCodexModelName), packages/contracts/src/model.ts
// (PREFERRED_DEFAULT_CODEX_MODELS), packages/provider-core/src/server/snapshotProbe.ts
// (COMPACT_SLASH_COMMAND).
import {
  SKILL_MENTION_PATTERN,
  applicableModelOptions,
  type AgentModel,
  type AgentSkill,
  type AgentSlashCommand,
  type ApprovalDecision,
  type InteractionMode,
  type ModelOptionChoice,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
  type PlanStep,
  type RuntimeMode,
  type TokenUsage,
  type ToolCall,
  type TurnRequest,
  type UserQuestion,
} from "@jhin/agent-api";

/** Tool output kept in the thread's log; longer output is cut (D94). */
export const MAX_TOOL_OUTPUT = 20_000;

/** T3's preferred defaults, the first present in Codex's model list wins. */
export const PREFERRED_MODELS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"] as const;

/** `gpt-6-astra` → `GPT-6-Astra`, as T3 names Codex's models. */
export function formatModelName(name: string): string {
  return name.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, c: string) => "-" + c.toUpperCase());
}

/** The models shown before Codex was asked for its own (T3's preferred defaults). */
export const BUNDLED_MODELS: readonly AgentModel[] = PREFERRED_MODELS.map((id) => ({
  id,
  name: formatModelName(id),
}));

/** A model of `model/list`. */
export interface ListedModel {
  readonly model: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly supportedReasoningEfforts?: readonly { readonly reasoningEffort?: unknown }[];
  readonly defaultReasoningEffort?: string | null;
  readonly serviceTiers?:
    | readonly { readonly id?: unknown; readonly name?: unknown; readonly description?: unknown }[]
    | null;
  readonly additionalSpeedTiers?: readonly unknown[] | null;
  readonly defaultServiceTier?: string | null;
}

export function listedModels(models: readonly ListedModel[]): AgentModel[] {
  return models.map((model) => {
    const options = modelOptions(model);
    return {
      id: model.model,
      name: formatModelName(model.displayName ?? model.model),
      ...(model.description ? { description: model.description } : {}),
      ...(options.length === 0 ? {} : { options }),
    };
  });
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/** The service tier Codex uses when the turn names none. */
const DEFAULT_SERVICE_TIER = "default";

const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: "Even faster, more expensive",
};

/** What a turn can choose for a listed model (T3's mapCodexModelCapabilities, D881). */
export function modelOptions(model: ListedModel): ModelOptionDescriptor[] {
  const defaultEffort =
    modelFamily(model.model) === "gpt-6-astra" ? "medium" : model.defaultReasoningEffort;
  const efforts: ModelOptionChoice[] = (model.supportedReasoningEfforts ?? []).flatMap(
    ({ reasoningEffort }) =>
      typeof reasoningEffort === "string"
        ? [
            {
              id: reasoningEffort,
              label: REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort,
              ...(reasoningEffort === defaultEffort ? { isDefault: true } : {}),
            },
          ]
        : [],
  );
  const tiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers.flatMap((tier) =>
          typeof tier.id === "string"
            ? [
                {
                  id: tier.id,
                  name: typeof tier.name === "string" ? tier.name : tier.id,
                  description: typeof tier.description === "string" ? tier.description : "",
                },
              ]
            : [],
        )
      : (model.additionalSpeedTiers ?? []).flatMap((id) =>
          typeof id === "string"
            ? [{ id, name: id === "fast" ? "Fast" : id, description: "" }]
            : [],
        );
  const defaultTier = tiers.some((tier) => tier.id === model.defaultServiceTier)
    ? model.defaultServiceTier
    : DEFAULT_SERVICE_TIER;

  const options: ModelOptionDescriptor[] = [];
  if (efforts.length > 0) {
    options.push({ id: "reasoningEffort", label: "Reasoning", type: "select", options: efforts });
  }
  if (tiers.length > 0) {
    options.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER,
          label: "Standard",
          ...(defaultTier === DEFAULT_SERVICE_TIER ? { isDefault: true } : {}),
        },
        ...tiers.map((tier) => {
          const description = SERVICE_TIER_DESCRIPTIONS[tier.id] ?? tier.description;
          return {
            id: tier.id,
            label: tier.name,
            ...(description ? { description } : {}),
            ...(defaultTier === tier.id ? { isDefault: true } : {}),
          };
        }),
      ],
    });
  }
  return options;
}

/**
 * The effort and service tier `turn/start` gets (D881): the turn's choices that apply to
 * the model's options, then the config's effort; a tier nobody chose is left to Codex.
 */
export function compileModelOptions(
  descriptors: readonly ModelOptionDescriptor[] | undefined,
  selections: readonly ModelOptionSelection[] | undefined,
  configEffort: string | undefined,
): { readonly effort?: string; readonly serviceTier?: string } {
  const chosen = applicableModelOptions(descriptors, selections);
  const value = (id: string) => {
    const found = chosen.find((selection) => selection.id === id)?.value;
    return typeof found === "string" ? found : undefined;
  };
  const effort = value("reasoningEffort") ?? configEffort;
  const serviceTier = value("serviceTier");
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

/** `openai.gpt-6-astra` → `gpt-6-astra` (T3's codexModelFamily). */
const modelFamily = (slug: string) => (slug.startsWith("openai.gpt-") ? slug.slice(7) : slug);

/** T3's applyPreferredCodexDefaultModel: a preferred model, else Codex's default, else the first. */
export function preferredDefault(models: readonly ListedModel[]): string | undefined {
  for (const preferred of PREFERRED_MODELS) {
    const found = models.find((model) => modelFamily(model.model) === preferred);
    if (found !== undefined) return found.model;
  }
  return (models.find((model) => model.isDefault) ?? models[0])?.model;
}

/** How T3 labels a ChatGPT plan. */
export function planLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "promax":
      return "ChatGPT Pro Max Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

/** What `account/read` answers. */
export interface Account {
  readonly account?:
    | { readonly type: "apiKey" }
    | { readonly type: "chatgpt"; readonly email?: string | null; readonly planType?: string }
    | { readonly type: "amazonBedrock" }
    | { readonly type: string }
    | null;
  readonly requiresOpenaiAuth?: boolean;
}

/** Whether Codex can run turns with this account, and how the status names it. */
export function accountStatus(account: Account): { available: boolean; message?: string } {
  const current = account.account;
  if (current === undefined || current === null) {
    return account.requiresOpenaiAuth === true
      ? {
          available: false,
          message: "Codex CLI is not authenticated. Run `codex login` and try again.",
        }
      : { available: true };
  }
  if (current.type === "chatgpt") {
    const chatgpt = current as { email?: string | null; planType?: string };
    if (chatgpt.email) return { available: true, message: `Signed in as ${chatgpt.email}` };
    const label = planLabel(chatgpt.planType);
    return label === undefined ? { available: true } : { available: true, message: label };
  }
  if (current.type === "apiKey") return { available: true, message: "OpenAI API Key" };
  if (current.type === "amazonBedrock") return { available: true, message: "Amazon Bedrock" };
  return { available: true };
}

// --- Turn settings ---------------------------------------------------------------

type SandboxPolicy =
  | { readonly type: "readOnly" }
  | { readonly type: "workspaceWrite" }
  | { readonly type: "dangerFullAccess" };

/** T3's codexRuntimeModeTurnDefaults (without its `auto` reviewer mode). */
export function runtimeModeDefaults(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly approvalsReviewer: "user";
  readonly sandboxPolicy: SandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

/** Thread config T3 starts and resumes every Codex thread with. */
export const THREAD_CONFIG = { "tools.update_plan.enabled": true } as const;

export type TurnInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly url: string }
  /** An image the node keeps as a file (an upload, t3-parity.md D294). */
  | { readonly type: "localImage"; readonly path: string };

/**
 * A skill typed with any currency sigil (`€review`) as Codex parses it, `$review`
 * (T3's codexSkillMentionText, D885).
 */
export const codexSkillMentionText = (text: string) =>
  text.replace(SKILL_MENTION_PATTERN, "$1$$$2");

/** The skills of `skills/list` for `cwd` (T3's parseCodexSkillsListResponse), enabled ones. */
export function listedSkills(response: unknown, cwd: string): AgentSkill[] {
  const data = isRecord(response) && Array.isArray(response["data"]) ? response["data"] : [];
  const entries = data.filter(isRecord);
  const matching = entries.find((entry) => entry["cwd"] === cwd);
  const skills = (matching === undefined ? entries : [matching]).flatMap((entry) =>
    Array.isArray(entry["skills"]) ? entry["skills"].filter(isRecord) : [],
  );
  return skills.flatMap((skill) => {
    const name = str(skill["name"]);
    const path = str(skill["path"]);
    if (name === undefined || path === undefined || skill["enabled"] === false) return [];
    const face = isRecord(skill["interface"]) ? skill["interface"] : {};
    const description =
      str(skill["description"]) ?? str(skill["shortDescription"]) ?? str(face["shortDescription"]);
    const scope = str(skill["scope"]);
    const displayName = str(face["displayName"]);
    return [
      {
        name,
        path,
        ...(description === undefined ? {} : { description }),
        ...(scope === undefined ? {} : { scope }),
        ...(displayName === undefined ? {} : { displayName }),
      },
    ];
  });
}

/** T3's COMPACT_SLASH_COMMAND, which Codex runs as `thread/compact/start` (D884). */
export const COMPACT_COMMAND: AgentSlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
};

/** Whether a turn's input is `/compact` alone: no text after it, no attachments. */
export const isCompact = (input: TurnRequest["input"]) =>
  input.text.trim() === "/compact" && (input.attachments ?? []).length === 0;

/** The `turn/start` params of a turn (T3's buildCodexTurnStartParams, without its MCP context). */
export function turnStartParams(input: {
  readonly threadId: string;
  readonly input: readonly TurnInput[];
  readonly cwd: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly effort?: string | undefined;
  readonly serviceTier?: string | undefined;
  /** What the agent is told besides the conversation (`TurnRequest.instructions`). */
  readonly instructions?: string | undefined;
}): Record<string, unknown> {
  const defaults = runtimeModeDefaults(input.runtimeMode);
  return {
    threadId: input.threadId,
    input: input.input,
    cwd: input.cwd,
    model: input.model,
    // Model catalogues can default summaries to "none": asked for on every turn (T3).
    summary: "detailed",
    approvalsReviewer: defaults.approvalsReviewer,
    approvalPolicy: defaults.approvalPolicy,
    sandboxPolicy: defaults.sandboxPolicy,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
    // Sent on every turn, so a plan turn's mode does not stick to the next one.
    collaborationMode: {
      mode: input.interactionMode === "plan" ? "plan" : "default",
      settings: {
        model: input.model,
        reasoning_effort: input.effort ?? "medium",
        // Codex's developer instructions, as T3 sends its own (buildCodexTurnStartParams).
        ...(input.instructions === undefined ? {} : { developer_instructions: input.instructions }),
      },
    },
  };
}

// --- Items -----------------------------------------------------------------------

export const cut = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…` : text;

const shorten = (text: string) => (text.length > 400 ? `${text.slice(0, 397)}...` : text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** A file change of a `fileChange` item. */
export interface FileUpdateChange {
  readonly path: string;
  readonly diff?: string;
  readonly kind?: { readonly type: string; readonly move_path?: string | null };
}

/** A Codex thread item, as far as Jhin reads it. */
export type CodexItem = Record<string, unknown> & { readonly id: string; readonly type: string };

export function fileChanges(item: CodexItem): FileUpdateChange[] {
  const changes = item["changes"];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change: unknown) =>
    isRecord(change) && typeof change["path"] === "string"
      ? [change as unknown as FileUpdateChange]
      : [],
  );
}

/** T3's webSearchPatterns: the queries, page or pattern a web search item names. */
export function webSearchPatterns(item: CodexItem): string[] {
  const action = isRecord(item["action"]) ? item["action"] : undefined;
  const compact = (values: unknown[]) => values.flatMap((value) => str(value) ?? []);
  if (action === undefined) return compact([item["query"]]);
  switch (action["type"]) {
    case "search":
      return compact([
        ...(Array.isArray(action["queries"]) ? action["queries"] : []),
        action["query"],
        item["query"],
      ]);
    case "openPage":
      return compact([action["url"], item["query"]]);
    case "findInPage":
      return compact([action["pattern"], action["url"], item["query"]]);
    default:
      return compact([item["query"]]);
  }
}

/** How a tool item of Codex shows in the work log; `undefined` for items that are not tools. */
export function toolCall(item: CodexItem): ToolCall | undefined {
  switch (item.type) {
    case "commandExecution": {
      const command = str(item["command"]);
      return {
        name: "commandExecution",
        kind: "command",
        title: "Ran command",
        ...(command === undefined ? {} : { detail: shorten(command) }),
        input: { command: item["command"], cwd: item["cwd"] },
      };
    }
    case "fileChange": {
      const changes = fileChanges(item);
      const paths = changes.map((change) => change.path);
      return {
        name: "fileChange",
        kind: "file_change",
        title: "Edited file",
        ...(paths.length === 0 ? {} : { detail: shorten(paths.join(", ")) }),
        input: { changes: changes.map(({ path, kind }) => ({ path, kind: kind?.type })) },
      };
    }
    case "mcpToolCall": {
      const server = String(item["server"] ?? "mcp");
      const tool = String(item["tool"] ?? "");
      const args = item["arguments"];
      const detail = args === undefined || args === null ? undefined : JSON.stringify(args);
      return {
        name: `${server}.${tool}`,
        kind: "mcp",
        title: `${server}: ${tool}`,
        ...(detail === undefined || detail === "{}" ? {} : { detail: shorten(detail) }),
        ...(args === undefined ? {} : { input: args }),
      };
    }
    case "dynamicToolCall": {
      const tool = String(item["tool"] ?? "tool");
      const args = item["arguments"];
      const detail = args === undefined || args === null ? undefined : JSON.stringify(args);
      return {
        name: tool,
        kind: "other",
        title: tool,
        ...(detail === undefined || detail === "{}" ? {} : { detail: shorten(detail) }),
        ...(args === undefined ? {} : { input: args }),
      };
    }
    case "contextCompaction":
      return { name: "compaction", kind: "other", title: "Compacting context" };
    case "webSearch": {
      const patterns = webSearchPatterns(item);
      return {
        name: "webSearch",
        kind: "web",
        title: "Searched the web",
        ...(patterns[0] === undefined ? {} : { detail: shorten(patterns[0]) }),
      };
    }
    case "imageView": {
      const path = str(item["path"]);
      return {
        name: "imageView",
        kind: "file_read",
        title: "Viewed image",
        ...(path === undefined ? {} : { detail: path }),
      };
    }
    default:
      return undefined;
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((part: unknown) =>
      isRecord(part) && typeof part["text"] === "string" ? part["text"] : JSON.stringify(part),
    )
    .join("\n");
};

/** A completed tool item's outcome: its status and what it printed or failed with. */
export function toolOutcome(item: CodexItem): {
  status: "completed" | "failed" | "declined";
  output?: string;
  error?: string;
} {
  const status =
    item["status"] === "failed"
      ? "failed"
      : item["status"] === "declined"
        ? "declined"
        : "completed";
  let output = "";
  let error: string | undefined;
  switch (item.type) {
    case "commandExecution": {
      output = typeof item["aggregatedOutput"] === "string" ? item["aggregatedOutput"] : "";
      const exitCode = item["exitCode"];
      if (status === "failed" && output.length === 0 && typeof exitCode === "number") {
        error = `Exit code ${exitCode}`;
      }
      break;
    }
    case "fileChange":
      output = fileChanges(item)
        .map((change) => change.diff ?? "")
        .filter((diff) => diff.length > 0)
        .join("\n");
      break;
    case "mcpToolCall": {
      const result = isRecord(item["result"]) ? item["result"] : undefined;
      if (result !== undefined) {
        output =
          result["structuredContent"] !== undefined && result["structuredContent"] !== null
            ? JSON.stringify(result["structuredContent"])
            : textOf(result["content"]);
      }
      const failure = isRecord(item["error"]) ? str(item["error"]["message"]) : undefined;
      if (failure !== undefined) error = failure;
      break;
    }
    case "dynamicToolCall":
      output = textOf(item["contentItems"] ?? undefined);
      break;
    default:
      break;
  }
  const kept = cut(output);
  const failed = status === "failed" || error !== undefined;
  return {
    status: failed ? "failed" : status,
    ...(failed
      ? { error: error ?? (kept.length > 0 ? kept : "Failed") }
      : kept.length > 0
        ? { output: kept }
        : {}),
  };
}

/** T3's codexFileChangeApprovalPrompt: the reason, else the changed paths, else the grant root. */
export function fileChangePrompt(input: {
  readonly reason?: string | null | undefined;
  readonly grantRoot?: string | null | undefined;
  readonly changes?: readonly FileUpdateChange[];
}): string | undefined {
  const reason = input.reason?.trim();
  if (reason) return reason;
  const entries = [...(input.changes ?? [])].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (entries.length > 0) {
    const described = entries.slice(0, 20).map((change) => {
      const type = change.kind?.type ?? "update";
      const movePath = type === "update" ? change.kind?.move_path : undefined;
      return movePath ? `${type} ${change.path} -> ${movePath}` : `${type} ${change.path}`;
    });
    const remaining = entries.length - described.length;
    return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
  }
  return input.grantRoot?.trim() || undefined;
}

/** Codex's decision for an approval answered in Jhin (`item/*\/requestApproval`). */
export function approvalDecision(
  decision: ApprovalDecision,
): "accept" | "acceptForSession" | "decline" | "cancel" {
  return decision === "accept-for-session" ? "acceptForSession" : decision;
}

/** The legacy review decision (`execCommandApproval`, `applyPatchApproval`), as T3 maps it. */
export function reviewDecision(decision: ApprovalDecision): unknown {
  switch (decision) {
    case "accept":
      return "approved";
    case "accept-for-session":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
    case "cancel":
      return "abort";
  }
}

/** Questions of `item/tool/requestUserInput`. */
export function userQuestions(questions: unknown): UserQuestion[] {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((value: unknown, index): UserQuestion[] => {
    if (!isRecord(value)) return [];
    const question = str(value["question"]);
    if (question === undefined) return [];
    const options = Array.isArray(value["options"]) ? value["options"] : [];
    return [
      {
        id: typeof value["id"] === "string" ? value["id"] : String(index),
        header: str(value["header"]) ?? "Question",
        question,
        options: options.flatMap((option: unknown) =>
          isRecord(option) && typeof option["label"] === "string"
            ? [
                {
                  label: option["label"],
                  ...(str(option["description"]) === undefined
                    ? {}
                    : { description: str(option["description"])! }),
                },
              ]
            : [],
        ),
        allowCustomAnswer: value["isOther"] === true || options.length === 0,
      },
    ];
  });
}

/** T3's toCodexUserInputAnswers: answers of the questions Codex asked, each a list. */
export function userInputAnswers(
  answers: Readonly<Record<string, string | readonly string[]>>,
  asked: ReadonlySet<string>,
): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([id, value]) =>
      asked.has(id) ? [[id, { answers: typeof value === "string" ? [value] : [...value] }]] : [],
    ),
  );
}

/** The plan of `turn/plan/updated`. */
export function planSteps(plan: unknown): PlanStep[] {
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((value: unknown, index): PlanStep[] => {
    if (!isRecord(value)) return [];
    return [
      {
        text: str(value["step"]) ?? `Step ${index + 1}`,
        status:
          value["status"] === "completed"
            ? "completed"
            : value["status"] === "inProgress"
              ? "in_progress"
              : "pending",
      },
    ];
  });
}

/** T3's codexProviderTurnTokenUsage: the last request's tokens and the model's window. */
export function tokenUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage) || !isRecord(usage["last"])) return undefined;
  const last = usage["last"];
  const count = (value: unknown) => (typeof value === "number" ? Math.max(0, value) : 0);
  const window = usage["modelContextWindow"];
  return {
    inputTokens: count(last["inputTokens"]),
    outputTokens: count(last["outputTokens"]),
    cachedInputTokens: count(last["cachedInputTokens"]),
    contextTokens: count(last["totalTokens"]),
    ...(typeof window === "number" ? { contextWindow: window } : {}),
  };
}
