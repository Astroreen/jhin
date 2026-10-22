// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts at eb7b35ac: starting and
// resuming a Codex thread (ensureThread, resumeThread with its unarchive retry), turn/start,
// turn/interrupt, and the projection of Codex's notifications and server requests (messages,
// reasoning, tools, plans, usage, approvals, questions, errors) into a turn's items.
import {
  DEFAULT_RUNTIME_MODE,
  SUBAGENT_WORK_KINDS,
  ThreadEvents,
  UsageLimitError,
  historyTranscript,
  type AgentItem,
  type AgentRequest,
  type AgentResponse,
  type AgentTurn,
  type ApprovalDecision,
  type ModelOptionDescriptor,
  type SubagentWorkItem,
  type TurnRequest,
} from "@jhin/agent-api";

import {
  THREAD_CONFIG,
  approvalDecision,
  fileChangePrompt,
  fileChanges,
  planSteps,
  reviewDecision,
  tokenUsage,
  toolCall,
  toolOutcome,
  codexSkillMentionText,
  compileModelOptions,
  retryProgress,
  isCompact,
  turnStartParams,
  userInputAnswers,
  userQuestions,
  type CodexItem,
  type FileUpdateChange,
  type TurnInput,
} from "./mapping.ts";
import { jhinToolsInstructions } from "@jhin/mcp-api";
import { CodexEnded, CodexRpcError, CodexSpawnError, codexEnvironment } from "./rpc.ts";
import { SessionTakenOver, type Lease, type McpAttachment, type Sessions } from "./session.ts";
import { codexErrorInfoCode, isUsageLimitCode } from "./usage-limits.ts";
import { describeElicitation, readElicitation, toElicitationResponse } from "./elicitation.ts";

/** The turn ended while it still waited on Codex (a stop's grace ran out). */
class TurnEnded extends Error {}

/** Errors a stop itself causes: a stopped turn ends with them as a clean stop. */
const causedByStop = (error: unknown) =>
  error instanceof TurnEnded || error instanceof CodexEnded || error instanceof SessionTakenOver;

/** The runtime's agent id, recorded on Codex's turns (D310). */
export const CODEX_AGENT_ID = "jhin.agent-codex";

/** A Jhin turn and the Codex turn it ran as (D1147). */
export interface RecordedTurn {
  readonly turnId: string;
  readonly codexTurnId: string;
}

/** What is kept of a thread's Codex thread: its id and its turns, oldest first. */
export interface CodexThreadRecord {
  readonly codexThreadId: string;
  readonly turns: readonly RecordedTurn[];
}

/** Which Codex thread each Jhin thread runs on (D312), and its turns (D1147). */
export interface ThreadStore {
  get(threadId: string): Promise<string | undefined>;
  set(threadId: string, codexThreadId: string, turns?: readonly RecordedTurn[]): Promise<void>;
  delete(threadId: string): Promise<void>;
  /** The whole record; a store without it rolls back and forks with a transcript. */
  read?(threadId: string): Promise<CodexThreadRecord | undefined>;
}

/** The `jhin.agent-codex` config section, as a turn needs it. */
interface CodexSettings {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly effort?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly inheritEnv?: readonly string[] | undefined;
}

export interface CodexTurnDependencies {
  readonly sessions: Sessions;
  readonly threads: ThreadStore;
  readonly settings: CodexSettings;
  /** The turn's model; a promise while it is still being asked for (`status()`). */
  readonly model: string | Promise<string>;
  /**
   * Gives a new app-server the node's MCP server (D889); absent when it gets none. `writes`:
   * the credential may run writing commands too (full access only).
   */
  readonly mcp?: (threadId: string, writes: boolean) => McpAttachment;
  /** What a turn can choose for `model`, as `model/list` described it (D881). */
  readonly modelOptions?: (model: string) => readonly ModelOptionDescriptor[] | undefined;
  /** Sent in `initialize`. */
  readonly version: string;
  /** `homePath` with `~` expanded. */
  readonly home?: string | undefined;
  /** When every exhausted usage window resets, for a turn that hit a usage limit (D1143). */
  readonly usageLimitResetAt?: () => string | undefined;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * A queue of items read by one consumer; `end` closes it, with an error to fail it. Once
 * `stopped()` says so it takes nothing more: what Codex still sends after an interrupt would
 * make the turn look answered.
 */
function channel<T>(stopped: () => boolean) {
  const buffer: T[] = [];
  let closed = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  return {
    push(value: T) {
      if (closed || stopped()) return;
      buffer.push(value);
      wake?.();
    },
    end(error?: { error: unknown }) {
      if (closed) return;
      closed = true;
      failure = error;
      wake?.();
    },
    async *read(): AsyncGenerator<T> {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (closed) {
          if (failure !== undefined) throw failure.error;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Codex keeps no conversation under this id (deleted, or of another home). */
// What Codex answers for a thread it keeps no rollout of (codex-cli 0.163:
// "no rollout found for thread id <id>"); any other resume error fails the turn.
const NOTHING_TO_RESUME = /\bno rollout found for thread\b/i;
/** The turns kept in a thread's record: a rollback further back starts a new Codex thread. */
const MAX_RECORDED_TURNS = 500;
/**
 * How long a stopped turn waits for Codex's `turn/completed` after the interrupt (T3 waits
 * 10 s for an interrupted lineage); then the turn ends and its app-server with it.
 */
const INTERRUPT_GRACE_MS = 10_000;
/** Codex refuses to resume an archived session until it is unarchived (T3's rule). */
const ARCHIVED = /\bsession \S+ is archived\b|\bcodex unarchive\b/i;

/** The server requests about an item Jhin answers; each names the item by its id. */
const ITEM_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

/** Codex's items that start or end a subagent (T3's collab and subagent activity items). */
const SUBAGENT_ITEMS = new Set(["collabAgentToolCall", "subAgentActivity"]);
/** What a subagent's thread sends that its child thread shows (D1145). */
const CHILD_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);
const isSubagentWork = (item: AgentItem): item is SubagentWorkItem =>
  (SUBAGENT_WORK_KINDS as readonly string[]).includes(item.kind);
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
/** A child thread's title: the first line of what it was asked, else T3's "Subagent". */
const subagentTitle = (prompt: string) => {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return "Subagent";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
/** T3's statuses of `agentsStates`, the ones that end a subagent. */
const subagentEnd = (status: unknown): "completed" | "failed" | "interrupted" | undefined => {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
    case "shutdown":
      return "interrupted";
    case "errored":
    case "notFound":
      return "failed";
    default:
      return undefined;
  }
};

/** What Codex sends a turn, with its Codex turn id: notifications and server requests. */
type Frame =
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | {
      readonly kind: "request";
      readonly method: string;
      readonly params: unknown;
      readonly answer: (result: Promise<unknown>) => void;
    };

/** Runs one turn of a thread on its Codex app-server; `done` settles once it let go of it. */
export function codexTurn(
  request: TurnRequest,
  deps: CodexTurnDependencies,
): AgentTurn & { readonly done: Promise<void> } {
  let interrupted = false;
  const out = channel<AgentItem>(() => interrupted);
  const runtimeMode = request.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = request.interactionMode ?? "default";
  const answers = new Map<string, (response: AgentResponse | undefined) => void>();
  let lease: Lease | undefined;
  /** Codex's id of this turn, once `turn/start` answered. */
  let turnId: string | undefined;
  let codexThreadId: string | undefined;
  /** Frames that came before `turn/start` answered: their turn id is told then. */
  let early: Frame[] | undefined = [];
  /** How the turn ended: with an error to fail it, `ended` once Codex ended it itself. */
  type Outcome = { readonly error?: Error; readonly ended?: boolean };
  let resolveFinished!: (outcome: Outcome) => void;
  const finished = new Promise<Outcome>((resolve) => (resolveFinished = resolve));
  /** The turn has ended (or is ending): it takes no steer any more. */
  let over = false;
  const finish = (outcome: Outcome) => {
    over = true;
    // A turn that ends any other way than `turn/completed` (Codex exits, a stop's grace runs
    // out) ends its retry too.
    settleRetry(
      outcome.error !== undefined
        ? outcome.error.message
        : interrupted
          ? "Stopped while retrying."
          : undefined,
    );
    resolveFinished(outcome);
  };
  /** Proposed plans streamed so far, by item. */
  const planTexts = new Map<string, string>();
  /** Messages steered into the turn before Codex named its turn id. */
  const steers: TurnInput[][] = [];
  /** Codex itself failed the turn: that failure stands, also after a stop. */
  let failedByCodex = false;
  /** Sends `turn/interrupt` once the turn id is known. */
  let stopRequested = false;

  // --- Requests ------------------------------------------------------------------
  /** Opens a request and waits for its answer: `undefined` when the turn stops first. */
  const ask = (requestId: string, item: AgentRequest) =>
    new Promise<AgentResponse | undefined>((resolve) => {
      if (interrupted) return resolve(undefined);
      // Listening before the request goes out: an answer may come before the next pull.
      // A second request under the same id (Codex asks again after a decline) closes the
      // first one, so no answer is left waiting.
      answers.get(requestId)?.(undefined);
      answers.set(requestId, resolve);
      out.push({ kind: "request.opened", requestId, request: item });
    });

  const approval = async (requestId: string, asked: AgentRequest): Promise<ApprovalDecision> => {
    const response = await ask(requestId, asked);
    return response === undefined
      ? "cancel"
      : response.kind === "approval"
        ? response.decision
        : "decline";
  };

  // --- Subagents (D1145) ------------------------------------------------------------
  /** Codex threads of the subagents this turn started, by their thread id: still open. */
  const subagents = new Map<string, { open: boolean }>();
  /** The subagent whose frame is being read: its items go out as `subagent.item`. */
  let child: string | undefined;
  /** An item of the turn, or of the subagent being read (only the kinds its thread shows). */
  const emit = (item: AgentItem) => {
    if (child === undefined) return out.push(item);
    if (isSubagentWork(item)) out.push({ kind: "subagent.item", subagentId: child, item });
  };
  const startSubagent = (threadId: string, title: string, prompt: string, model?: string) => {
    if (subagents.has(threadId)) return;
    subagents.set(threadId, { open: true });
    out.push({
      kind: "subagent.started",
      subagentId: threadId,
      title,
      prompt,
      ...(model === undefined ? {} : { model }),
    });
  };
  const endSubagent = (
    threadId: string,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ) => {
    const subagent = subagents.get(threadId);
    if (subagent === undefined || !subagent.open) return;
    subagent.open = false;
    out.push({
      kind: "subagent.ended",
      subagentId: threadId,
      status,
      ...(error === undefined ? {} : { error }),
    });
  };
  /** T3's registerSubagentThreads, registerSubagentActivity and updateSubagentStates. */
  const subagentItem = (item: CodexItem, completed: boolean) => {
    if (item.type === "subAgentActivity") {
      const threadId = str(item["agentThreadId"]);
      if (threadId === undefined) return;
      const kind = item["kind"];
      const path = str(item["agentPath"]);
      if (kind === "started") startSubagent(threadId, path ?? "Subagent", "");
      else if (kind === "completed") endSubagent(threadId, "completed");
      else if (kind === "interrupted") endSubagent(threadId, "interrupted");
      return;
    }
    if (!completed) return;
    if (item["tool"] === "spawnAgent") {
      const prompt = str(item["prompt"]) ?? "";
      const model = str(item["model"]);
      const receivers = Array.isArray(item["receiverThreadIds"]) ? item["receiverThreadIds"] : [];
      for (const threadId of receivers) {
        if (typeof threadId === "string") {
          startSubagent(threadId, subagentTitle(prompt), prompt, model);
        }
      }
    }
    const states = isRecord(item["agentsStates"]) ? item["agentsStates"] : {};
    for (const [threadId, state] of Object.entries(states)) {
      if (!isRecord(state)) continue;
      const ended = subagentEnd(state["status"]);
      if (ended === undefined) continue;
      const message = str(state["message"]);
      endSubagent(
        threadId,
        ended,
        ended === "failed" ? (message ?? "The subagent failed.") : undefined,
      );
    }
  };
  /** A frame of a subagent's own Codex thread: its work, approvals asked through this turn. */
  const childFrame = (threadId: string, frame: Frame) => {
    if (frame.kind === "request") {
      frame.answer(serverRequest(frame.method, isRecord(frame.params) ? frame.params : {}));
      return;
    }
    const params = isRecord(frame.params) ? frame.params : {};
    if (frame.method === "turn/completed") {
      const turn = isRecord(params["turn"]) ? params["turn"] : {};
      const error = isRecord(turn["error"]) ? str(turn["error"]["message"]) : undefined;
      if (turn["status"] === "failed")
        endSubagent(threadId, "failed", error ?? "The subagent failed.");
      else if (turn["status"] === "interrupted") endSubagent(threadId, "interrupted");
      else endSubagent(threadId, "completed");
      return;
    }
    if (!CHILD_METHODS.has(frame.method)) return;
    // Its item ids are its thread's: kept apart from this turn's.
    const scoped = (id: unknown) => `${threadId}:${String(id)}`;
    const own: Record<string, unknown> = { ...params };
    if (typeof own["itemId"] === "string") own["itemId"] = scoped(own["itemId"]);
    if (isRecord(own["item"]) && typeof own["item"]["id"] === "string") {
      own["item"] = { ...own["item"], id: scoped(own["item"]["id"]) };
    }
    child = threadId;
    try {
      notification(frame.method, own);
    } finally {
      child = undefined;
    }
  };

  // --- Items -------------------------------------------------------------------------
  const started = new Set<string>();
  const changesById = new Map<string, FileUpdateChange[]>();
  const declined = new Set<string>();
  const texts = new Map<string, string>();
  const completedTexts = new Set<string>();
  /** The last failure Codex reported without retrying it (T3's latestProviderFailure). */
  let lastError: string | undefined;
  /** Its code (`codexErrorInfo`), e.g. `usageLimitExceeded`. */
  let lastErrorCode: string | undefined;

  const delta = (kind: "message" | "reasoning", itemId: string, text: string) => {
    if (text.length === 0) return;
    texts.set(itemId, (texts.get(itemId) ?? "") + text);
    emit({ kind: `${kind}.delta`, itemId, text });
  };
  const complete = (kind: "message" | "reasoning", itemId: string, final?: string) => {
    if (completedTexts.has(itemId)) return;
    const text = final !== undefined && final.length > 0 ? final : (texts.get(itemId) ?? "");
    if (text.trim().length === 0) return;
    completedTexts.add(itemId);
    emit({ kind: `${kind}.completed`, itemId, text });
  };

  const startTool = (item: CodexItem) => {
    if (started.has(item.id)) return;
    const tool = toolCall(item);
    if (tool === undefined) return;
    started.add(item.id);
    if (item.type === "fileChange") changesById.set(item.id, fileChanges(item));
    emit({ kind: "tool.started", itemId: item.id, tool });
  };

  const itemStarted = (item: CodexItem) => {
    if (child === undefined && SUBAGENT_ITEMS.has(item.type)) return subagentItem(item, false);
    if (item.type === "fileChange") changesById.set(item.id, fileChanges(item));
    startTool(item);
  };

  const itemCompleted = (item: CodexItem) => {
    if (child === undefined && SUBAGENT_ITEMS.has(item.type)) return subagentItem(item, true);
    switch (item.type) {
      case "agentMessage":
        complete("message", item.id, typeof item["text"] === "string" ? item["text"] : undefined);
        return;
      case "plan": {
        // The completed plan is authoritative, not the concatenation of its deltas.
        const text =
          typeof item["text"] === "string" && item["text"].trim().length > 0
            ? item["text"]
            : (planTexts.get(item.id) ?? "");
        if (text.trim().length > 0)
          emit({ kind: "plan.proposed", itemId: item.id, markdown: text });
        return;
      }
      case "reasoning": {
        for (const stream of ["summary", "content"] as const) {
          const parts = Array.isArray(item[stream]) ? (item[stream] as unknown[]) : [];
          const tag = stream === "summary" ? "s" : "c";
          const indices = new Set<number>(parts.map((_, index) => index));
          for (const key of texts.keys()) {
            const match = key.startsWith(`${item.id}:${tag}`)
              ? Number(key.slice(item.id.length + 2))
              : Number.NaN;
            if (Number.isInteger(match)) indices.add(match);
          }
          for (const index of [...indices].toSorted((a, b) => a - b)) {
            const part = parts[index];
            complete(
              "reasoning",
              `${item.id}:${tag}${index}`,
              typeof part === "string" ? part : undefined,
            );
          }
        }
        return;
      }
      default: {
        if (toolCall(item) === undefined) return;
        startTool(item);
        const outcome = toolOutcome(item);
        emit({
          kind: "tool.completed",
          itemId: item.id,
          ...outcome,
          ...(declined.has(item.id) && outcome.status !== "completed"
            ? { status: "declined" }
            : {}),
        });
        // The compaction stays a row of the turn and also says the context was compacted (D709).
        if (item.type === "contextCompaction" && outcome.status === "completed") {
          emit({
            kind: "context.compacted",
            trigger: isCompact(request.input) ? "manual" : "auto",
          });
        }
      }
    }
  };

  // --- Retries -------------------------------------------------------------------------
  /** The item showing the errors Codex is retrying, while it retries (D886). */
  let retrying: string | undefined;
  /** Each retried error, one line per attempt. */
  let retries = "";
  /** Retry episodes so far: each is an item of its own. */
  let episodes = 0;
  const retried = (message: string) => {
    if (retrying === undefined) {
      retrying = `${turnId ?? request.turnId}:retry:${++episodes}`;
      out.push({
        kind: "tool.started",
        itemId: retrying,
        tool: { name: "retry", kind: "other", title: "Provider retry", detail: message },
      });
    }
    const progress = retryProgress(message);
    const line = `${progress === undefined ? "" : `Attempt ${progress}: `}${message}\n`;
    retries += line;
    out.push({ kind: "tool.output", itemId: retrying, text: line });
  };
  /** New output from the model, or the turn's end: the retry is over. */
  const settleRetry = (error?: string) => {
    if (retrying === undefined) return;
    out.push({
      kind: "tool.completed",
      itemId: retrying,
      output: retries,
      ...(error === undefined ? { status: "completed" } : { status: "failed", error }),
    });
    retrying = undefined;
    retries = "";
  };

  const notification = (method: string, params: Record<string, unknown>) => {
    // Codex's payloads are read field by field (D310): a delta without the id of its item
    // has nothing to belong to and is dropped.
    const carriesItem = method === "item/started" || method === "item/completed";
    if (method.startsWith("item/") && !carriesItem && typeof params["itemId"] !== "string") return;
    // Only output of the model ends a retry: a local item may complete while Codex retries.
    if (method.endsWith("Delta") || method.endsWith("/delta") || method === "item/started") {
      settleRetry();
    }
    switch (method) {
      case "item/agentMessage/delta":
        delta("message", String(params["itemId"]), String(params["delta"] ?? ""));
        return;
      case "item/plan/delta": {
        // Kept for a completed plan without text; the plan shows once, as a proposal.
        const itemId = String(params["itemId"]);
        planTexts.set(itemId, (planTexts.get(itemId) ?? "") + String(params["delta"] ?? ""));
        return;
      }
      case "item/reasoning/summaryTextDelta":
        delta(
          "reasoning",
          `${String(params["itemId"])}:s${Number(params["summaryIndex"] ?? 0)}`,
          String(params["delta"] ?? ""),
        );
        return;
      case "item/reasoning/textDelta":
        delta(
          "reasoning",
          `${String(params["itemId"])}:c${Number(params["contentIndex"] ?? 0)}`,
          String(params["delta"] ?? ""),
        );
        return;
      case "item/commandExecution/outputDelta": {
        const itemId = String(params["itemId"]);
        const text = String(params["delta"] ?? "");
        if (started.has(itemId) && text.length > 0) emit({ kind: "tool.output", itemId, text });
        return;
      }
      case "item/started":
        if (isRecord(params["item"]) && typeof params["item"]["id"] === "string") {
          itemStarted(params["item"] as CodexItem);
        }
        return;
      case "item/completed":
        if (isRecord(params["item"]) && typeof params["item"]["id"] === "string") {
          itemCompleted(params["item"] as CodexItem);
        }
        return;
      case "turn/plan/updated": {
        const steps = planSteps(params["plan"]);
        out.push({ kind: "plan.updated", steps });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = tokenUsage(params["tokenUsage"]);
        if (usage !== undefined) out.push({ kind: "usage", usage });
        return;
      }
      case "error": {
        const error = isRecord(params["error"]) ? params["error"] : {};
        if (params["willRetry"] === true) {
          const details =
            typeof error["additionalDetails"] === "string" ? error["additionalDetails"].trim() : "";
          const message = typeof error["message"] === "string" ? error["message"] : "";
          // The message carries the attempt ("Reconnecting... 2/5"), the details the cause.
          retried(details.length > 0 ? `${message} ${details}`.trim() : message);
          return;
        }
        const details =
          typeof error["additionalDetails"] === "string" ? error["additionalDetails"].trim() : "";
        lastErrorCode = codexErrorInfoCode(error["codexErrorInfo"]);
        lastError =
          details.length > 0
            ? details
            : typeof error["message"] === "string"
              ? error["message"]
              : undefined;
        return;
      }
      case "turn/completed": {
        const turn = isRecord(params["turn"]) ? params["turn"] : {};
        const status = turn["status"];
        const error = isRecord(turn["error"]) ? turn["error"] : undefined;
        // Codex ended the turn, whatever its status: the app-server stays for the next.
        // A turn Codex failed stays failed, also when a stop came after; a stop hides
        // only the interruption itself.
        if (status === "completed") {
          settleRetry();
          return finish({ ended: true });
        }
        if (interrupted && status !== "failed") {
          settleRetry("Stopped while retrying.");
          return finish({ ended: true });
        }
        if (status === "interrupted") {
          settleRetry("Stopped while retrying.");
          return finish({ ended: true, error: new Error("Codex stopped the turn.") });
        }
        failedByCodex = true;
        const message =
          (typeof error?.["message"] === "string" && error["message"].length > 0
            ? error["message"]
            : undefined) ??
          lastError ??
          "Codex failed the turn.";
        settleRetry(message);
        // A usage limit is a failure of its own, with when it resets (T3's `usage_limit`).
        const code = codexErrorInfoCode(error?.["codexErrorInfo"]) ?? lastErrorCode;
        return finish({
          ended: true,
          error: isUsageLimitCode(code)
            ? new UsageLimitError(message, deps.usageLimitResetAt?.())
            : new Error(message),
        });
      }
      default:
        return;
    }
  };

  // --- Server requests ---------------------------------------------------------------
  // Granted for the mode it was granted in: a later turn in a stricter mode asks again.
  const allowance = (kind: string) => `${runtimeMode}:${kind}`;
  const allowed = (kind: string) => lease?.session.allowed.has(allowance(kind)) === true;
  const allow = (kind: string, decision: ApprovalDecision) => {
    if (decision === "accept-for-session") lease?.session.allowed.add(allowance(kind));
  };
  const decide = (itemId: string, decision: ApprovalDecision) => {
    if (decision === "decline" || decision === "cancel") declined.add(itemId);
  };

  const serverRequest = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    // A request about an item names it; without the id its answer could not be told apart.
    if (ITEM_REQUESTS.has(method) && typeof params["itemId"] !== "string") {
      throw new CodexRpcError(method, -32602, `${method} names no itemId.`);
    }
    switch (method) {
      case "item/commandExecution/requestApproval": {
        if (allowed("command")) return { decision: "acceptForSession" };
        const itemId = String(params["itemId"]);
        const command = typeof params["command"] === "string" ? params["command"] : undefined;
        const reason = typeof params["reason"] === "string" ? params["reason"] : undefined;
        const decision = await approval(`${itemId}:approval`, {
          kind: "approval",
          tool: {
            name: "commandExecution",
            kind: "command",
            title: "Run command",
            ...(command === undefined ? {} : { detail: command }),
            input: { command, cwd: params["cwd"] },
          },
          ...(reason === undefined ? {} : { reason }),
        });
        allow("command", decision);
        decide(itemId, decision);
        return { decision: approvalDecision(decision) };
      }
      case "item/fileChange/requestApproval": {
        if (allowed("file-change")) return { decision: "acceptForSession" };
        const itemId = String(params["itemId"]);
        const changes = changesById.get(itemId) ?? [];
        const prompt = fileChangePrompt({
          reason: params["reason"] as string | undefined,
          grantRoot: params["grantRoot"] as string | undefined,
          changes,
        });
        const paths = changes.map((change) => change.path);
        const decision = await approval(`${itemId}:approval`, {
          kind: "approval",
          tool: {
            name: "fileChange",
            kind: "file_change",
            title: "Edit file",
            ...(paths.length === 0 ? {} : { detail: paths.join(", ") }),
            input: { changes: changes.map(({ path, kind }) => ({ path, kind: kind?.type })) },
          },
          ...(prompt === undefined ? {} : { reason: prompt }),
        });
        allow("file-change", decision);
        decide(itemId, decision);
        return { decision: approvalDecision(decision) };
      }
      case "item/permissions/requestApproval": {
        const itemId = String(params["itemId"]);
        const permissions = isRecord(params["permissions"]) ? params["permissions"] : {};
        const fileSystem = isRecord(permissions["fileSystem"]) ? permissions["fileSystem"] : {};
        const writes = Array.isArray(fileSystem["write"]) ? fileSystem["write"].length : 0;
        const reads = Array.isArray(fileSystem["read"]) ? fileSystem["read"].length : 0;
        const kind = writes > 0 ? "file_change" : reads > 0 ? "file_read" : "command";
        const reason = typeof params["reason"] === "string" ? params["reason"] : undefined;
        const decision = await approval(`${itemId}:approval`, {
          kind: "approval",
          tool: { name: "permissions", kind, title: "Grant permissions", input: permissions },
          ...(reason === undefined ? {} : { reason }),
        });
        decide(itemId, decision);
        if (decision !== "accept" && decision !== "accept-for-session") {
          return { permissions: {}, scope: "turn" };
        }
        return { permissions, scope: decision === "accept-for-session" ? "session" : "turn" };
      }
      case "execCommandApproval": {
        if (allowed("command")) return { decision: "approved_for_session" };
        const callId = String(params["callId"]);
        const command = Array.isArray(params["command"]) ? params["command"].join(" ") : undefined;
        const reason = typeof params["reason"] === "string" ? params["reason"] : undefined;
        const decision = await approval(`${callId}:approval`, {
          kind: "approval",
          tool: {
            name: "commandExecution",
            kind: "command",
            title: "Run command",
            ...(command === undefined ? {} : { detail: command }),
            input: { command: params["command"], cwd: params["cwd"] },
          },
          ...(reason === undefined ? {} : { reason }),
        });
        allow("command", decision);
        decide(callId, decision);
        return { decision: reviewDecision(decision) };
      }
      case "applyPatchApproval": {
        if (allowed("file-change")) return { decision: "approved_for_session" };
        const callId = String(params["callId"]);
        const files = isRecord(params["fileChanges"]) ? params["fileChanges"] : {};
        const changes = Object.entries(files).map(([path, change]) => ({
          path,
          ...(isRecord(change) ? { kind: change as FileUpdateChange["kind"] & object } : {}),
        }));
        const prompt = fileChangePrompt({
          reason: params["reason"] as string | undefined,
          grantRoot: params["grantRoot"] as string | undefined,
          changes,
        });
        const decision = await approval(`${callId}:approval`, {
          kind: "approval",
          tool: {
            name: "fileChange",
            kind: "file_change",
            title: "Edit file",
            ...(changes.length === 0 ? {} : { detail: changes.map((c) => c.path).join(", ") }),
          },
          ...(prompt === undefined ? {} : { reason: prompt }),
        });
        allow("file-change", decision);
        decide(callId, decision);
        return { decision: reviewDecision(decision) };
      }
      case "mcpServer/elicitation/request": {
        // An app asks for access through an MCP server (T3's CodexMcpElicitation, D1146).
        const payload = readElicitation(params);
        // One Jhin cannot answer (a URL to open, a form it cannot fill) is declined, as T3 does.
        if (payload === undefined || toElicitationResponse(payload, "accept").action !== "accept") {
          deps.log?.("declined an MCP elicitation Jhin cannot answer", {
            server: payload?.serverName,
            mode: payload?.mode,
          });
          return { action: "decline" };
        }
        const described = describeElicitation(payload);
        const decision = await approval(`mcp-elicitation:${payload.serverName}`, {
          kind: "approval",
          tool: {
            name: "mcpElicitation",
            kind: "mcp",
            title: described.appName,
            detail: payload.message,
          },
          access: { app: described.appName },
          decisions: described.decisions,
        });
        return toElicitationResponse(
          payload,
          described.decisions.includes(decision) ? decision : "accept",
        );
      }
      case "item/tool/requestUserInput": {
        const itemId = String(params["itemId"]);
        const questions = userQuestions(params["questions"]);
        const response = await ask(`${itemId}:input`, { kind: "user-input", questions });
        const given = response?.kind === "user-input" ? response.answers : {};
        return {
          answers: userInputAnswers(given, new Set(questions.map((question) => question.id))),
        };
      }
      default:
        throw new CodexRpcError(method, -32601, `Jhin does not answer ${method}.`);
    }
  };

  // --- Frames of this turn ---------------------------------------------------------
  /** Codex's turn id a frame names, if any. */
  const frameTurn = (frame: Frame): string | undefined => {
    const params = isRecord(frame.params) ? frame.params : {};
    if (typeof params["turnId"] === "string") return params["turnId"];
    if (isRecord(params["turn"]) && typeof params["turn"]["id"] === "string")
      return params["turn"]["id"];
    return undefined;
  };
  const frameThread = (frame: Frame): string | undefined => {
    const params = isRecord(frame.params) ? frame.params : {};
    if (typeof params["threadId"] === "string") return params["threadId"];
    if (typeof params["conversationId"] === "string") return params["conversationId"];
    return undefined;
  };

  const handle = (frame: Frame) => {
    // Another Codex thread (a subagent's) or another turn (an earlier one that still
    // sends after its interrupt): not this turn's.
    const thread = frameThread(frame);
    if (thread !== undefined && subagents.has(thread)) return childFrame(thread, frame);
    if (thread !== undefined && codexThreadId !== undefined && thread !== codexThreadId) {
      if (frame.kind === "request")
        frame.answer(Promise.reject(new Error("Not this thread's turn.")));
      return;
    }
    const turn = frameTurn(frame);
    if (turn !== undefined && turn !== turnId) {
      if (frame.kind === "request")
        frame.answer(Promise.reject(new Error("Not the running turn.")));
      return;
    }
    const params = isRecord(frame.params) ? frame.params : {};
    if (frame.kind === "notification") {
      // Codex's payloads are not validated (D310): one this turn cannot read fails it,
      // instead of escaping into the app-server's reader.
      try {
        notification(frame.method, params);
      } catch (error) {
        finish({
          error: new Error(`Codex sent a ${frame.method} Jhin cannot read: ${String(error)}`),
        });
      }
    } else frame.answer(serverRequest(frame.method, params));
  };

  /** Told the turn id of the first `turn/started` of this thread, while it is not known. */
  let onTurnStarted: ((id: string) => void) | undefined;
  const receive = (frame: Frame) => {
    if (early !== undefined) {
      early.push(frame);
      const thread = frameThread(frame);
      const turn = frameTurn(frame);
      if (
        frame.method === "turn/started" &&
        turn !== undefined &&
        (thread === undefined || thread === codexThreadId)
      ) {
        onTurnStarted?.(turn);
      }
    } else handle(frame);
  };

  /** Hands a message to Codex's running turn (T3's turn/steer, bound to the turn's id). */
  const sendSteer = (current: Lease, input: TurnInput[]) => {
    current.session.connection
      .request("turn/steer", { threadId: codexThreadId, expectedTurnId: turnId, input })
      .catch((error: unknown) =>
        deps.log?.("codex did not take the steered message", { error: String(error) }),
      );
  };

  const sendInterrupt = (current: Lease) => {
    if (turnId === undefined || codexThreadId === undefined) return;
    current.session.connection
      .request("turn/interrupt", { threadId: codexThreadId, turnId })
      .catch((error: unknown) => {
        deps.log?.("codex did not take the interrupt", { error: String(error) });
        // Codex answered no (the turn just ended, say): its turn/completed or the grace
        // ends the turn. An app-server that did not answer at all is ended with it.
        if (error instanceof CodexRpcError) return;
        current.release(false);
        finish({});
      });
  };

  // --- The turn --------------------------------------------------------------------
  const userInput = (
    text: string,
    attachments: TurnRequest["input"]["attachments"] = request.input.attachments,
  ): TurnInput[] => {
    // Every uploaded file is named after the text, as T3 writes it (D294).
    const notes = (attachments ?? []).flatMap((attachment) =>
      "path" in attachment && attachment.path !== undefined
        ? [`[Attached ${attachment.kind} "${attachment.name}" is saved at: ${attachment.path}]`]
        : [],
    );
    const body = [text, ...notes].filter((part) => part.length > 0).join("\n\n");
    return [
      ...(body.length > 0 ? [{ type: "text" as const, text: body }] : []),
      ...(attachments ?? []).flatMap((attachment): TurnInput[] =>
        "dataUrl" in attachment
          ? [{ type: "image", url: attachment.dataUrl }]
          : attachment.kind === "image" && attachment.path !== undefined
            ? [{ type: "localImage", path: attachment.path }]
            : [],
      ),
    ];
  };

  /** Starts or resumes the thread's Codex thread on this app-server. */
  const ensureThread = async (
    current: Lease,
    recorded: string | undefined,
    /** The parent's Codex thread and turn to fork at, for a fork's first Codex turn (D1148). */
    forkAt?: { readonly codexThreadId: string; readonly codexTurnId: string },
  ) => {
    const connection = current.session.connection;
    if (current.session.codexThreadId !== undefined) return;
    const mcpServers = current.session.mcpServers;
    const params = {
      cwd: request.cwd,
      model,
      config:
        mcpServers === undefined ? THREAD_CONFIG : { ...THREAD_CONFIG, mcp_servers: mcpServers },
    };
    if (recorded !== undefined) {
      const resume = () =>
        connection.request("thread/resume", { threadId: recorded, excludeTurns: true, ...params });
      try {
        await resume().catch(async (error: unknown) => {
          if (!(error instanceof CodexRpcError) || !ARCHIVED.test(error.message)) throw error;
          await connection.request("thread/unarchive", { threadId: recorded });
          await resume();
        });
        current.session.codexThreadId = recorded;
        return;
      } catch (error) {
        if (!(error instanceof CodexRpcError) || !NOTHING_TO_RESUME.test(error.message))
          throw error;
        // Codex keeps nothing under the record (deleted, another home): a new thread. The
        // record is replaced once that thread started, so a start that fails loses nothing.
        deps.log?.("codex has no thread to resume, starting one", { threadId: request.threadId });
      }
    }
    if (forkAt !== undefined) {
      // T3's forkThread: Codex copies the parent's thread up to the turn forked at.
      try {
        const forked = (await connection.request("thread/fork", {
          threadId: forkAt.codexThreadId,
          lastTurnId: forkAt.codexTurnId,
          ...params,
        })) as { thread?: { id?: unknown } } | null;
        if (typeof forked?.thread?.id === "string") {
          current.session.codexThreadId = forked.thread.id;
          forkedNatively = true;
          return;
        }
      } catch (error) {
        if (!(error instanceof CodexRpcError)) throw error;
        deps.log?.("codex could not fork the thread, starting one", {
          threadId: request.threadId,
          error: error.message,
        });
      }
    }
    const response = (await connection.request("thread/start", params)) as {
      thread?: { id?: unknown };
    } | null;
    const id = response?.thread?.id;
    if (typeof id !== "string") throw new Error("Codex started no thread.");
    current.session.codexThreadId = id;
  };

  /** The fork's Codex thread came from its parent's (D1148): it saw the inherited turns. */
  let forkedNatively = false;

  /**
   * Drops from the resumed Codex thread the turns a rollback dropped from the thread (T3's
   * revertCodexThread, D1147): `thread/revert` before the oldest of them. One Codex cannot
   * revert (legacy history) gets a new thread instead, handed the transcript.
   */
  const revertDropped = async (current: Lease, dropped: readonly RecordedTurn[]) => {
    const first = dropped[0];
    if (first === undefined || current.session.codexThreadId === undefined) return;
    try {
      await current.session.connection.request("thread/revert", {
        threadId: current.session.codexThreadId,
        beforeTurnId: first.codexTurnId,
      });
    } catch (error) {
      if (!(error instanceof CodexRpcError)) throw error;
      deps.log?.("codex could not revert the thread, starting one", {
        threadId: request.threadId,
        error: error.message,
      });
      current.session.codexThreadId = undefined;
      current.session.delivered = false;
      await ensureThread(current, undefined);
    }
  };

  /**
   * Fails once the turn has ended without Codex (an interrupt's grace ran out, the app-server
   * exited or was taken over), so a request Codex never answers does not hold the turn.
   */
  const ended = finished.then((outcome) => {
    throw outcome.error ?? new TurnEnded("The turn ended.");
  });
  ended.catch(() => {});
  const untilEnded = <T>(pending: Promise<T>) => Promise.race([pending, ended]);

  /** The turn's model, once known. */
  let model = "";
  /** What Codex is told besides the conversation: the Jhin tools when it has them (D889). */
  const developerInstructions = () => {
    const parts = [
      ...(lease?.session.mcpServers === undefined ? [] : [jhinToolsInstructions()]),
      ...(request.instructions === undefined ? [] : [request.instructions]),
    ];
    return parts.length === 0 ? {} : { instructions: parts.join("\n\n") };
  };

  const run = async () => {
    model = await deps.model;
    const record = await deps.threads.read?.(request.threadId);
    const recorded = record?.codexThreadId ?? (await deps.threads.get(request.threadId));
    // The turns the thread still shows: a recorded one it does not was rolled back (D1147).
    const visible = new Set(
      request.history.flatMap((event) => {
        const id = (event.payload as { turnId?: unknown } | null)?.turnId;
        return event.type === ThreadEvents.turnStarted && typeof id === "string" ? [id] : [];
      }),
    );
    const kept = (record?.turns ?? []).filter((turn) => visible.has(turn.turnId));
    const dropped = (record?.turns ?? []).filter((turn) => !visible.has(turn.turnId));
    // A fork's first Codex turn forks its parent's Codex thread at the last Codex turn the
    // fork inherited (D1148).
    let forkAt: { codexThreadId: string; codexTurnId: string } | undefined;
    let inherited: RecordedTurn[] = [];
    if (recorded === undefined && deps.threads.read !== undefined) {
      const marker = request.history.findLast((event) => event.type === ThreadEvents.threadForked);
      const parentId = (marker?.payload as { threadId?: unknown } | null)?.threadId;
      const parent = typeof parentId === "string" ? await deps.threads.read(parentId) : undefined;
      inherited = (parent?.turns ?? []).filter((turn) => visible.has(turn.turnId));
      const last = inherited.at(-1);
      if (parent !== undefined && last !== undefined) {
        forkAt = { codexThreadId: parent.codexThreadId, codexTurnId: last.codexTurnId };
      }
    }
    if (interrupted) return;
    const mcpWrites = runtimeMode === "full-access";
    const leasing = deps.sessions.lease(request.threadId, {
      binaryPath: deps.settings.binaryPath,
      args: deps.settings.args ?? [],
      cwd: request.cwd,
      env: codexEnvironment(deps.settings.env, deps.home, deps.settings.inheritEnv),
      version: deps.version,
      // What a running app-server cannot change; the node's own environment is not part of
      // it, so a change there does not restart an idle one.
      key: JSON.stringify({
        binaryPath: deps.settings.binaryPath,
        args: deps.settings.args ?? [],
        cwd: request.cwd,
        env: deps.settings.env ?? {},
        inheritEnv: deps.settings.inheritEnv ?? ["*"],
        home: deps.home,
        // Turning the node's MCP server on or off, or its writes, starts a new app-server.
        mcp: deps.mcp === undefined ? false : mcpWrites ? "writes" : "reads",
      }),
      ...(deps.mcp === undefined ? {} : { mcp: () => deps.mcp!(request.threadId, mcpWrites) }),
    });
    const current = await untilEnded(leasing).catch((error: unknown) => {
      // Given up while the app-server started: it is ended once it is there.
      void leasing.then(
        (late) => late.release(false),
        () => {},
      );
      // T3's wording for a Codex that does not start (a wrong binary path).
      if (error instanceof CodexSpawnError) {
        throw new Error(
          `Could not start Codex CLI (\`${deps.settings.binaryPath}\`): ${error.message}`,
        );
      }
      throw error;
    });
    lease = current;
    let keep = false;
    try {
      current.hold({
        notification: (method, params) => receive({ kind: "notification", method, params }),
        request: (method, params) =>
          new Promise<unknown>((resolve, reject) =>
            receive({
              kind: "request",
              method,
              params,
              answer: (result) => result.then(resolve, reject),
            }),
          ),
        end: (error) => finish({ error }),
      });
      if (interrupted) {
        keep = true;
        return;
      }
      await untilEnded(ensureThread(current, recorded, forkAt));
      // Dropped turns go once from a Codex thread that still has them: the one just resumed,
      // or one kept loaded since before the rollback.
      if (dropped.length > 0 && current.session.codexThreadId === recorded) {
        await untilEnded(revertDropped(current, dropped));
      }
      codexThreadId = current.session.codexThreadId;
      // The record names the Codex thread once a message of this thread reached it (it is
      // written after turn/start answered). Until then Codex saw none of the thread's turns,
      // also when the thread was started by a turn that failed before its message went in.
      const fresh = recorded !== codexThreadId && !current.session.delivered && !forkedNatively;
      current.session.model = model;
      // A Codex thread that never saw the thread's earlier turns gets them as a transcript.
      const preface = historyTranscript(request.history, fresh ? undefined : CODEX_AGENT_ID);
      // Codex parses only `$name` as a skill (T3's codexSkillMentionText).
      const typed = codexSkillMentionText(request.input.text);
      const text = preface === undefined ? typed : `${preface}${typed}`;
      if (interrupted) {
        keep = true;
        return;
      }
      let id: unknown;
      const compacting = isCompact(request.input);
      if (compacting) {
        // `/compact` compacts the Codex thread (T3's compactThread): Codex runs it as a turn
        // of its own and names it in `turn/started`.
        const named = new Promise<string>((resolve) => (onTurnStarted = resolve));
        try {
          await untilEnded(
            current.session.connection.request("thread/compact/start", {
              threadId: codexThreadId,
            }),
          );
          id = await untilEnded(named);
        } finally {
          onTurnStarted = undefined;
        }
      } else {
        const startedTurn = (await untilEnded(
          current.session.connection.request(
            "turn/start",
            turnStartParams({
              threadId: codexThreadId!,
              input: userInput(text),
              cwd: request.cwd,
              model,
              runtimeMode,
              interactionMode,
              ...compileModelOptions(
                deps.modelOptions?.(model),
                request.modelOptions,
                deps.settings.effort,
              ),
              ...developerInstructions(),
            }),
          ),
        )) as { turn?: { id?: unknown } } | null;
        id = startedTurn?.turn?.id;
      }
      if (typeof id !== "string") throw new Error("Codex started no turn.");
      turnId = id;
      // A compaction hands Codex no message: the thread's turns still go to it with the next.
      if (!compacting) current.session.delivered = true;
      // Every turn is recorded with the Codex turn it ran as, so a rollback can revert it and a
      // fork can fork at it (D1147, D1148); the turns before are those still shown.
      const before =
        codexThreadId === recorded ? kept : forkedNatively ? inherited : ([] as RecordedTurn[]);
      // A compaction on a thread Codex never saw records nothing: the next message still takes
      // the transcript.
      const recordable = fresh ? !compacting : forkedNatively || deps.threads.read !== undefined;
      if (recordable) {
        const turns = [...before, { turnId: request.turnId, codexTurnId: turnId }].slice(
          -MAX_RECORDED_TURNS,
        );
        await deps.threads.set(request.threadId, codexThreadId!, turns).catch((error: unknown) =>
          deps.log?.("could not record the codex thread", {
            threadId: request.threadId,
            error: String(error),
          }),
        );
      }
      const buffered = early ?? [];
      early = undefined;
      for (const frame of buffered) handle(frame);
      for (const input of steers.splice(0)) sendSteer(current, input);
      if (stopRequested) sendInterrupt(current);
      const outcome = await finished;
      keep = outcome.ended === true;
      if (outcome.error !== undefined) throw outcome.error;
    } finally {
      // Kept only when Codex finished the turn: one that broke off mid-turn would hand the
      // rest of it to the next.
      current.release(keep);
      lease = undefined;
    }
  };

  const done = run().then(
    () => out.end(),
    (error: unknown) => {
      // A stop hides only what the stop caused; a failure of its own (no such binary, a
      // crash, Codex failing the turn) still fails it.
      if (interrupted && !failedByCodex && causedByStop(error)) out.end();
      else out.end({ error });
    },
  );

  return {
    done,
    items: out.read(),
    interrupt() {
      if (interrupted) return;
      interrupted = true;
      stopRequested = true;
      // A Codex that takes the interrupt but never ends the turn: the turn ends anyway, and
      // its app-server with it, so the thread is free for its next turn.
      const grace = setTimeout(() => finish({}), INTERRUPT_GRACE_MS);
      grace.unref?.();
      void done.finally(() => clearTimeout(grace));
      for (const resolve of answers.values()) resolve(undefined);
      answers.clear();
      // Still starting: nothing to tell Codex, the turn ends now and a late app-server is
      // let go of.
      if (lease === undefined) {
        finish({});
        return;
      }
      if (turnId === undefined) {
        // Before turn/start answered: the interrupt goes out once it has. Before the turn
        // started at all, nothing more is sent.
        if (codexThreadId === undefined) finish({});
        return;
      }
      sendInterrupt(lease);
    },
    respond(requestId, response) {
      const resolve = answers.get(requestId);
      answers.delete(requestId);
      resolve?.(response);
    },
    steer(input) {
      if (interrupted || over) {
        throw new Error("The turn has ended: Codex takes no more messages for it.");
      }
      const items = userInput(input.text, input.attachments);
      // Before Codex named the turn, the message goes in once it has.
      if (lease === undefined || turnId === undefined) steers.push(items);
      else sendSteer(lease, items);
    },
  };
}
