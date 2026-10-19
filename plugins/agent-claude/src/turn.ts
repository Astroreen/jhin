// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: query options
// (makeClaudeQueryOptions), runtime and interaction modes to Claude permission modes
// (permissionModeForClaudeRuntimePolicy), the canUseTool callback (approvals,
// AskUserQuestion, ExitPlanMode) and the stream projection of reasoning, tools and usage.
// T3 keeps one live query per thread; here every turn runs one query that resumes the
// thread's Claude session, so a turn owns everything it starts.
import type {
  AgentItem,
  AgentResponse,
  AgentTurn,
  InteractionMode,
  RuntimeMode,
  TurnAttachment,
  TurnRequest,
} from "@jhin/agent-api";
import { DEFAULT_RUNTIME_MODE, ThreadEvents } from "@jhin/agent-api";
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  EXIT_PLAN_TOOL,
  QUESTION_TOOL,
  TODO_TOOL,
  applyTaskTool,
  isAbortedResult,
  isSilentTool,
  permissionResult,
  promptTokens,
  proposedPlan,
  questionAnswers,
  resultError,
  resultUsage,
  todoSteps,
  toolCall,
  toolResultText,
  userQuestions,
  type TaskList,
} from "./mapping.ts";

/** The part of the SDK's `Query` a turn uses. */
interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
}

/** The SDK's `query`, injected so tests can script Claude Code. */
export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

/** Which threads already have a Claude session (named after the thread). */
export interface SessionStore {
  has(threadId: string): Promise<boolean>;
  set(threadId: string): Promise<void>;
  delete(threadId: string): Promise<void>;
}

/** The `jhin.agent-claude` config section, as the turn needs it. */
interface ClaudeSettings {
  readonly binaryPath?: string | undefined;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly appendSystemPrompt?: string | undefined;
}

export interface ClaudeTurnDependencies {
  readonly query: QueryFunction;
  readonly sessions: SessionStore;
  readonly settings: ClaudeSettings;
  readonly defaultModel: string;
  /** The context window of a model when Claude Code has not reported one yet. */
  readonly contextWindow?: (model: string) => number | undefined;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

/** The environment Claude Code runs with: the node's, plus the config's `env`. */
export function claudeEnvironment(
  env: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  return { ...process.env, ...env };
}

/** Tool output kept in the thread's log; longer output is cut. */
const MAX_TOOL_OUTPUT = 20_000;

/** How Jhin's runtime and interaction modes map onto Claude Code (T3's mapping). */
export function permissionMode(
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
): PermissionMode {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
}

/** Whether tool calls the permission mode does not allow by itself ask the user. */
const asksForApproval = (runtimeMode: RuntimeMode) => runtimeMode !== "full-access";

const IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function userMessage(text: string, attachments: readonly TurnAttachment[] = []): SDKUserMessage {
  const images = attachments.flatMap((attachment) => {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.dataUrl);
    if (match === null || !IMAGE_TYPES.has(match[1]!)) return [];
    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: match[1] as "image/png",
          data: match[2]!,
        },
      },
    ];
  });
  return {
    type: "user",
    message: {
      role: "user",
      content: images.length === 0 ? text : [...images, { type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

/**
 * The conversation so far, for a thread whose earlier turns ran on another agent: Claude
 * starts a session of its own and gets them as context in the first message.
 */
export function transcript(history: TurnRequest["history"]): string | undefined {
  const lines: string[] = [];
  for (const event of history) {
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") continue;
    if (event.type === ThreadEvents.turnStarted) {
      const input = payload["input"] as { text?: unknown } | undefined;
      if (typeof input?.text === "string") lines.push(`User: ${input.text}`);
    } else if (event.type === ThreadEvents.itemCompleted && payload["kind"] === "message") {
      if (typeof payload["text"] === "string") lines.push(`Assistant: ${payload["text"]}`);
    }
  }
  if (lines.length === 0) return undefined;
  return [
    "This thread started before you joined it. The conversation so far:",
    "",
    ...lines,
    "",
    "The user's new message follows.",
    "",
  ].join("\n");
}

/**
 * A queue of items read by one consumer; `end` closes it, with an error to fail it.
 * Once `stopped()` says so it takes nothing more: what Claude Code still sends after an
 * interrupt (the rest of a message) would make the turn look answered.
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

/** Claude Code refused the session: none to resume (`resume`), or it exists already. */
class SessionMismatch extends Error {
  readonly resume: boolean;
  constructor(resume: boolean) {
    super(resume ? "no Claude session to resume" : "the Claude session already exists");
    this.resume = resume;
  }
}

/** Runs one turn of a thread on Claude Code. */
export function claudeTurn(request: TurnRequest, deps: ClaudeTurnDependencies): AgentTurn {
  let interrupted = false;
  const out = channel<AgentItem>(() => interrupted);
  const runtimeMode = request.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = request.interactionMode ?? "default";
  const model = request.model ?? deps.defaultModel;
  const answers = new Map<string, (response: AgentResponse | undefined) => void>();
  let current: ClaudeQuery | undefined;
  let ended: (() => void) | undefined;

  /** Opens a request and waits for its answer; `undefined` when the turn stops first. */
  /**
   * Opens a request and waits for its answer: `undefined` when the turn stops first or
   * Claude Code withdraws the request (`signal`). The request stays open in the thread
   * until its turn ends; an answer that comes after a withdrawal is dropped.
   */
  const ask = (
    requestId: string,
    item: Extract<AgentItem, { kind: "request.opened" }>,
    signal: AbortSignal,
  ) =>
    new Promise<AgentResponse | undefined>((resolve) => {
      if (interrupted || signal.aborted) return resolve(undefined);
      const withdraw = () => {
        answers.delete(requestId);
        resolve(undefined);
      };
      signal.addEventListener("abort", withdraw, { once: true });
      // Listening before the request goes out: an answer may come before the next pull.
      answers.set(requestId, (response) => {
        signal.removeEventListener("abort", withdraw);
        resolve(response);
      });
      out.push(item);
    });

  // --- Items --------------------------------------------------------------------
  const startedTools = new Map<string, { name: string; input: unknown }>();
  const declined = new Set<string>();
  /** Texts streamed per API message, so the message's snapshot does not repeat them. */
  const streamedTexts = new Map<string, Set<string>>();
  const blocks = new Map<number, { itemId: string; kind: "message" | "reasoning"; text: string }>();
  let messageId: string | undefined;
  let tasks: TaskList = new Map();
  let contextTokens: number | undefined;
  const contextWindow = deps.contextWindow?.(model);
  let snapshotIndex = 0;

  /** Completes a message or reasoning item, once per text of an API message. */
  const complete = (id: string, itemId: string, kind: "message" | "reasoning", text: string) => {
    const seen = streamedTexts.get(id) ?? new Set<string>();
    if (seen.has(text)) return;
    seen.add(text);
    streamedTexts.set(id, seen);
    out.push({ kind: `${kind}.completed`, itemId, text });
  };

  const startTool = (id: string, name: string, input: unknown) => {
    if (startedTools.has(id)) return;
    startedTools.set(id, { name, input });
    if (isSilentTool(name)) {
      if (name === TODO_TOOL) {
        const steps = todoSteps(input);
        if (steps.length > 0) out.push({ kind: "plan.updated", steps });
      }
      return;
    }
    out.push({ kind: "tool.started", itemId: id, tool: toolCall(name, input) });
  };

  const usage = () =>
    contextTokens === undefined
      ? undefined
      : ({
          kind: "usage",
          usage: {
            inputTokens: contextTokens,
            outputTokens: 0,
            contextTokens,
            ...(contextWindow === undefined ? {} : { contextWindow }),
          },
        } satisfies AgentItem);

  const project = (message: SDKMessage) => {
    // Subagents' own messages stay inside their Agent tool call.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;
    switch (message.type) {
      case "stream_event": {
        const event = message.event;
        if (event.type === "message_start") {
          messageId = event.message.id;
          blocks.clear();
          contextTokens = promptTokens(event.message.usage);
          const item = usage();
          if (item !== undefined) out.push(item);
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (messageId === undefined) return;
          if (block.type === "text" || block.type === "thinking") {
            const kind = block.type === "text" ? "message" : "reasoning";
            const itemId = `${messageId}:${event.index}`;
            const text = block.type === "text" ? block.text : block.thinking;
            blocks.set(event.index, { itemId, kind, text });
            if (text.length > 0) out.push({ kind: `${kind}.delta`, itemId, text });
          }
        } else if (event.type === "content_block_delta") {
          const block = blocks.get(event.index);
          if (block === undefined) return;
          const text =
            event.delta.type === "text_delta"
              ? event.delta.text
              : event.delta.type === "thinking_delta"
                ? event.delta.thinking
                : undefined;
          if (text === undefined || text.length === 0) return;
          block.text += text;
          out.push({ kind: `${block.kind}.delta`, itemId: block.itemId, text });
        } else if (event.type === "content_block_stop") {
          const block = blocks.get(event.index);
          if (block === undefined) return;
          blocks.delete(event.index);
          if (block.text.trim().length === 0 || messageId === undefined) return;
          complete(messageId, block.itemId, block.kind, block.text);
        }
        return;
      }
      case "assistant": {
        const id = message.message.id;
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            startTool(block.id, block.name, block.input);
          } else if (block.type === "text" || block.type === "thinking") {
            const text = block.type === "text" ? block.text : block.thinking;
            const kind = block.type === "text" ? "message" : "reasoning";
            if (text.trim().length === 0) continue;
            // The snapshot of a block can come before its content_block_stop: it completes
            // the streamed item, and the stop finds nothing left to do.
            const streamed =
              id === messageId
                ? [...blocks.entries()].find(([, open]) => open.kind === kind)
                : undefined;
            if (streamed !== undefined) {
              blocks.delete(streamed[0]);
              complete(id, streamed[1].itemId, kind, text);
              continue;
            }
            // Not streamed (partial messages off, or a replayed frame): the snapshot is the item.
            complete(id, `${id}:s${snapshotIndex++}`, kind, text);
          }
        }
        return;
      }
      case "user": {
        const content = message.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const tool = startedTools.get(block.tool_use_id);
          if (tool === undefined) continue;
          if (isSilentTool(tool.name)) {
            const next = applyTaskTool(tasks, tool.name, tool.input, message.tool_use_result);
            if (next !== undefined) {
              tasks = next;
              out.push({ kind: "plan.updated", steps: [...next.values()] });
            }
            continue;
          }
          const text = toolResultText(block.content);
          const output =
            text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…` : text;
          const status = declined.has(block.tool_use_id)
            ? "declined"
            : block.is_error === true
              ? "failed"
              : "completed";
          out.push({
            kind: "tool.completed",
            itemId: block.tool_use_id,
            status,
            ...(output.length === 0 ? {} : status === "failed" ? { error: output } : { output }),
          });
        }
        return;
      }
      default:
        return;
    }
  };

  // --- Permissions --------------------------------------------------------------
  const canUseTool: CanUseTool = async (
    toolName,
    toolInput,
    options,
  ): Promise<PermissionResult> => {
    const toolUseID = options.toolUseID;
    if (toolName === QUESTION_TOOL) {
      const questions = userQuestions(toolInput);
      const response = await ask(
        toolUseID,
        {
          kind: "request.opened",
          requestId: toolUseID,
          request: { kind: "user-input", questions },
        },
        options.signal,
      );
      if (response?.kind !== "user-input" || options.signal.aborted) {
        return { behavior: "deny", message: "User cancelled tool execution.", toolUseID };
      }
      return {
        behavior: "allow",
        updatedInput: { ...toolInput, answers: questionAnswers(response.answers) },
        toolUseID,
      };
    }
    if (toolName === EXIT_PLAN_TOOL) {
      const plan = proposedPlan(toolInput);
      if (plan !== undefined) {
        out.push({ kind: "message.completed", itemId: `${toolUseID}:plan`, text: plan });
      }
      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
        toolUseID,
      };
    }
    if (!asksForApproval(runtimeMode)) {
      return { behavior: "allow", updatedInput: toolInput, toolUseID };
    }
    startTool(toolUseID, toolName, toolInput);
    const response = await ask(
      `${toolUseID}:approval`,
      {
        kind: "request.opened",
        requestId: `${toolUseID}:approval`,
        request: {
          kind: "approval",
          tool: toolCall(toolName, toolInput, true),
          ...(options.decisionReason === undefined ? {} : { reason: options.decisionReason }),
        },
      },
      options.signal,
    );
    const decision =
      response === undefined || options.signal.aborted
        ? "cancel"
        : response.kind === "approval"
          ? response.decision
          : "decline";
    if (decision === "decline" || decision === "cancel") declined.add(toolUseID);
    return permissionResult({
      toolName,
      decision,
      toolInput,
      toolUseID,
      ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
    });
  };

  // --- The query ----------------------------------------------------------------
  const options = (resume: boolean): Options => ({
    cwd: request.cwd,
    model,
    ...(resume ? { resume: request.threadId } : { sessionId: request.threadId }),
    permissionMode: permissionMode(runtimeMode, interactionMode),
    ...(permissionMode(runtimeMode, interactionMode) === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    canUseTool,
    includePartialMessages: true,
    thinking: { type: "adaptive", display: "summarized" },
    ...(deps.settings.effort === undefined ? {} : { effort: deps.settings.effort }),
    ...(deps.settings.binaryPath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: deps.settings.binaryPath }),
    ...(deps.settings.env === undefined ? {} : { env: claudeEnvironment(deps.settings.env) }),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        "You are running inside Jhin, a self-hosted AI harness; the user reads your answers in its web client." +
        (deps.settings.appendSystemPrompt === undefined
          ? ""
          : `\n${deps.settings.appendSystemPrompt}`),
    },
  });

  /** One query; resolves with the result, or `undefined` when the stream ended without one. */
  const attempt = async (resume: boolean, text: string) => {
    let release!: () => void;
    const finished = new Promise<void>((resolve) => (release = resolve));
    ended = release;
    // The prompt stays open until the turn ends: Claude Code reads permission answers
    // and control requests through the same process.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(text, request.input.attachments);
      await finished;
    }
    const query = deps.query({ prompt: prompt(), options: options(resume) });
    current = query;
    if (interrupted) void query.interrupt().catch(() => undefined);
    let started = false;
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of query) {
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          await deps.sessions.set(request.threadId);
          continue;
        }
        if (message.type === "result") {
          result = message;
          break;
        }
        project(message);
      }
    } catch (error) {
      if (!started && !interrupted) {
        const reason = String(error);
        if (resume && /no conversation found/i.test(reason)) throw new SessionMismatch(true);
        if (!resume && /already in use/i.test(reason)) throw new SessionMismatch(false);
      }
      throw error;
    } finally {
      release();
      query.close();
      current = undefined;
    }
    if (result !== undefined && !started) {
      const error = resultError(result) ?? "";
      if (resume && /no conversation found/i.test(error)) throw new SessionMismatch(true);
      if (!resume && /already in use/i.test(error)) throw new SessionMismatch(false);
    }
    return result;
  };

  const run = async () => {
    const hasSession = await deps.sessions.has(request.threadId);
    // Stopped before Claude Code started: it never starts.
    if (interrupted) return;
    const preface = hasSession ? undefined : transcript(request.history);
    const text = preface === undefined ? request.input.text : `${preface}${request.input.text}`;
    let result: SDKResultMessage | undefined;
    try {
      result = await attempt(hasSession, text);
    } catch (error) {
      if (!(error instanceof SessionMismatch)) throw error;
      // The record of sessions and Claude Code disagree (a session deleted by hand, a
      // first turn stopped before it was recorded): try the other way once.
      deps.log?.("claude session mismatch, retrying", { threadId: request.threadId });
      if (error.resume) await deps.sessions.delete(request.threadId);
      // A stop that came meanwhile ends the turn: no second query starts.
      if (interrupted) return;
      const retryText =
        error.resume && transcript(request.history) !== undefined
          ? `${transcript(request.history)}${request.input.text}`
          : request.input.text;
      result = await attempt(!error.resume, retryText);
    }
    if (result === undefined || interrupted || isAbortedResult(result)) return;
    out.push({ kind: "usage", usage: resultUsage(result, contextTokens) });
    const error = resultError(result);
    if (error !== undefined) throw new Error(error);
  };

  void run().then(
    () => out.end(),
    (error: unknown) => {
      // A stop that tears the process down is an interrupt, not a failure.
      if (interrupted) out.end();
      else out.end({ error });
    },
  );

  return {
    items: out.read(),
    interrupt() {
      if (interrupted) return;
      interrupted = true;
      for (const resolve of answers.values()) resolve(undefined);
      answers.clear();
      const query = current;
      if (query === undefined) return;
      void query.interrupt().catch(() => {
        // Claude Code did not take the interrupt: end its process instead.
        ended?.();
        query.close();
      });
    },
    respond(requestId, response) {
      const resolve = answers.get(requestId);
      answers.delete(requestId);
      resolve?.(response);
    },
  };
}
