// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: query options
// (makeClaudeQueryOptions), runtime and interaction modes to Claude permission modes
// (permissionModeForClaudeRuntimePolicy), the canUseTool callback (approvals,
// AskUserQuestion, ExitPlanMode) and the stream projection of reasoning, tools and usage.
// The live query a turn runs on is leased from ./session.ts: kept between turns, or started
// for each turn and resumed, as the `session` setting says.
import { randomUUID } from "node:crypto";

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
  createLiveSessions,
  inheritedEnvironment,
  type Attachment,
  type Lease,
  type LiveSessions,
  type QueryFunction,
} from "./session.ts";
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
import { applyUltrathinkPrefix, compileClaudeSelection } from "./models.ts";

export type { QueryFunction } from "./session.ts";

/** The runtime's agent id, recorded on Claude's turns (D90). */
export const CLAUDE_AGENT_ID = "jhin.agent-claude";

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
  readonly inheritEnv?: readonly string[] | undefined;
}

export interface ClaudeTurnDependencies {
  readonly query: QueryFunction;
  /** The node's live sessions; without them the turn starts Claude Code and ends it. */
  readonly live?: LiveSessions;
  readonly sessions: SessionStore;
  readonly settings: ClaudeSettings;
  readonly defaultModel: string;
  /** The context window of a model when Claude Code has not reported one yet. */
  readonly contextWindow?: (model: string) => number | undefined;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
  /** The node's MCP server for a Claude Code started for the thread (D340); none when unset. */
  readonly mcp?: {
    attach(threadId: string): Attachment;
    /** Whether a tool of it only reads (`threads_list`); `threads_send` does not. */
    readOnly(tool: string): boolean;
  };
}

/** The name Claude Code knows the node's MCP server by; its tools are `mcp__jhin__<tool>`. */
export const MCP_SERVER_NAME = "jhin";

/** The tools of the node's MCP server, approved without asking (T3's `mcp__t3-code__*`). */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** What the appended system prompt says about the node's MCP server (T3's orchestration section). */
export const JHIN_MCP_INSTRUCTIONS = `

## Jhin tools

The \`${MCP_SERVER_NAME}\` MCP server exposes this Jhin node's commands as tools: a command \`threads.send\` is the tool \`threads_send\` (Claude Code shows it as \`mcp__${MCP_SERVER_NAME}__threads_send\`). Use them when the user asks you to work with Jhin itself: list and read projects and threads (\`projects_list\`, \`threads_list\`, \`threads_get\`, \`threads_events\`), start a thread in a project (\`threads_create\`) and send it a message (\`threads_send\`). Calls act for the current thread and only reach what this thread's agent may do. Threads you start are ordinary top-level threads the user sees in the sidebar: start one only when the user asks for a separate thread.`;

/** The environment Claude Code runs with: the node's variables the allow-list lets through, plus the config's `env`. */
export function claudeEnvironment(
  env: Readonly<Record<string, string>> = {},
  inherit?: readonly string[],
): Record<string, string | undefined> {
  return { ...inheritedEnvironment(inherit), ...env };
}

/** Without live sessions: every turn starts Claude Code and ends it. */
const PER_TURN = { keepAlive: false, idleMs: 0 } as const;

const log = (deps: ClaudeTurnDependencies) => (deps.log === undefined ? {} : { log: deps.log });

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

/**
 * Whether tool calls the permission mode does not allow by itself ask the user. Plan mode
 * always asks: what Claude Code asks about there is a change the plan was not to make, so
 * full access does not approve it on its own (T3 Code does).
 */
const asksForApproval = (runtimeMode: RuntimeMode, interactionMode: InteractionMode) =>
  runtimeMode !== "full-access" || interactionMode === "plan";

const IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function userMessage(
  text: string,
  attachments: readonly TurnAttachment[] = [],
  skipped: (attachment: TurnAttachment) => void = () => {},
): SDKUserMessage {
  const images = attachments.flatMap((attachment) => {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.dataUrl);
    if (match === null || !IMAGE_TYPES.has(match[1]!)) {
      skipped(attachment);
      return [];
    }
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
    // Fresh for every message: Claude Code marks the frames answering it with this uuid,
    // so a live session hands a turn only its own (session.ts).
    uuid: randomUUID(),
    message: {
      role: "user",
      content: images.length === 0 ? text : [...images, { type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

/**
 * The conversation Claude has not seen, as context for the first message it gets: every
 * earlier turn of a thread whose turns ran on another agent before Claude joined (no
 * `since`), or the turns after Claude's last one (`since`: Claude's agent id) of a thread
 * that went to another agent and came back. `undefined` when there is none.
 */
export function transcript(history: TurnRequest["history"], since?: string): string | undefined {
  const turns: { agentId: unknown; lines: string[] }[] = [];
  const byId = new Map<unknown, { agentId: unknown; lines: string[] }>();
  for (const event of history) {
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") continue;
    if (event.type === ThreadEvents.turnStarted) {
      const turn = { agentId: payload["agentId"], lines: [] as string[] };
      turns.push(turn);
      byId.set(payload["turnId"], turn);
      const input = payload["input"] as { text?: unknown } | undefined;
      if (typeof input?.text === "string") turn.lines.push(`User: ${input.text}`);
    } else if (event.type === ThreadEvents.itemCompleted && payload["kind"] === "message") {
      const turn = byId.get(payload["turnId"]) ?? turns.at(-1);
      if (typeof payload["text"] === "string") turn?.lines.push(`Assistant: ${payload["text"]}`);
    }
  }
  const last = since === undefined ? -1 : turns.findLastIndex((turn) => turn.agentId === since);
  // A session with no turn of Claude's in the history (its record was written on init, then
  // the turn failed) already holds what Claude saw: nothing to replay.
  if (since !== undefined && last === -1) return undefined;
  const missed = turns.slice(last + 1);
  const lines = missed.flatMap((turn) => turn.lines);
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

/**
 * Runs one turn of a thread on Claude Code; `done` settles once the turn let go of its
 * live session (ended or kept for the next turn).
 */
export function claudeTurn(
  request: TurnRequest,
  deps: ClaudeTurnDependencies,
): AgentTurn & { readonly done: Promise<void> } {
  let interrupted = false;
  const out = channel<AgentItem>(() => interrupted);
  const runtimeMode = request.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = request.interactionMode ?? "default";
  // The turn's model options (D298): the model id with its suffix, effort and settings.
  const selection = compileClaudeSelection(
    request.model ?? deps.defaultModel,
    request.modelOptions,
    deps.settings.effort,
  );
  const model = selection.model;
  const messageText = selection.ultrathink
    ? applyUltrathinkPrefix(request.input.text)
    : request.input.text;
  const answers = new Map<string, (response: AgentResponse | undefined) => void>();
  const live =
    deps.live ?? createLiveSessions({ query: deps.query, keepAlive: () => PER_TURN, ...log(deps) });
  let current: Lease | undefined;

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
  /**
   * Blocks a `content_block_stop` completed whose snapshot has not come yet, counted by
   * kind and text per API message: the snapshot of each finds its own and adds nothing, and
   * two blocks with one text stay two items (D342).
   */
  const awaitingSnapshot = new Map<string, Map<string, number>>();
  const blocks = new Map<number, { itemId: string; kind: "message" | "reasoning"; text: string }>();
  let messageId: string | undefined;
  let tasks: TaskList = new Map();
  let contextTokens: number | undefined;
  const contextWindow = deps.contextWindow?.(model);
  let snapshotIndex = 0;

  const complete = (itemId: string, kind: "message" | "reasoning", text: string) =>
    out.push({ kind: `${kind}.completed`, itemId, text });
  /** Whether a snapshot's block was completed already by its stop; takes it if so. */
  const snapshotOfStopped = (id: string, kind: string, text: string) => {
    const counts = awaitingSnapshot.get(id);
    const key = `${kind}\u0000${text}`;
    const count = counts?.get(key) ?? 0;
    if (count === 0) return false;
    counts!.set(key, count - 1);
    return true;
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
          complete(block.itemId, block.kind, block.text);
          const counts = awaitingSnapshot.get(messageId) ?? new Map<string, number>();
          const key = `${block.kind}\u0000${block.text}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          awaitingSnapshot.set(messageId, counts);
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
            if (snapshotOfStopped(id, kind, text)) continue;
            // The snapshot of a block can come before its content_block_stop: it completes
            // the streamed item, and the stop finds nothing left to do.
            const streamed =
              id === messageId
                ? [...blocks.entries()].find(([, open]) => open.kind === kind)
                : undefined;
            if (streamed !== undefined) {
              blocks.delete(streamed[0]);
              complete(streamed[1].itemId, kind, text);
              continue;
            }
            // Not streamed (partial messages off, or a replayed frame): the snapshot is the item.
            complete(`${id}:s${snapshotIndex++}`, kind, text);
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
        out.push({ kind: "plan.proposed", itemId: `${toolUseID}:plan`, markdown: plan });
      }
      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
        toolUseID,
      };
    }
    // The node's own tools that only read, as T3 pre-approves its server's read-only tools;
    // one that writes (threads_respond could answer this very request) asks like any tool
    // (D340). Not through `allowedTools`: the SDK warns on every query whose bare
    // allowedTools entry shadows canUseTool.
    const nodeTool =
      deps.mcp !== undefined &&
      toolName.startsWith(MCP_TOOL_PREFIX) &&
      deps.mcp.readOnly(toolName.slice(MCP_TOOL_PREFIX.length));
    if (!asksForApproval(runtimeMode, interactionMode) || nodeTool) {
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
  const mode = permissionMode(runtimeMode, interactionMode);
  const options = (resume: boolean): Options => ({
    cwd: request.cwd,
    model,
    ...(resume ? { resume: request.threadId } : { sessionId: request.threadId }),
    permissionMode: mode,
    ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    canUseTool,
    includePartialMessages: true,
    ...(selection.thinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    ...(selection.effort === undefined ? {} : { effort: selection.effort }),
    ...(Object.keys(selection.settings).length === 0
      ? {}
      : { settings: { ...selection.settings } }),
    ...(deps.settings.binaryPath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: deps.settings.binaryPath }),
    // The config's variables only: the session adds the node's environment (session.ts).
    ...(deps.settings.env === undefined ? {} : { env: { ...deps.settings.env } }),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        "You are running inside Jhin, a self-hosted AI harness; the user reads your answers in its web client." +
        (deps.mcp === undefined ? "" : JHIN_MCP_INSTRUCTIONS) +
        (deps.settings.appendSystemPrompt === undefined
          ? ""
          : `\n${deps.settings.appendSystemPrompt}`),
    },
  });

  /** One query; resolves with the result, or `undefined` when the stream ended without one. */
  const attempt = async (resume: boolean, text: string) => {
    const lease = await live.lease({
      threadId: request.threadId,
      options: options(resume),
      ...(deps.mcp === undefined ? {} : { attach: deps.mcp.attach }),
      ...(deps.settings.inheritEnv === undefined ? {} : { inherit: deps.settings.inheritEnv }),
      message: userMessage(text, request.input.attachments, (attachment) =>
        deps.log?.("claude takes no such attachment, skipped", {
          name: attachment.name,
          mimeType: attachment.mimeType,
        }),
      ),
    });
    current = lease;
    if (interrupted) stop(lease);
    let started = false;
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of lease.messages) {
        // Claude Code initializes every turn, also on a session kept from an earlier one.
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          // A record that could not be written costs one retry on the next turn (D91),
          // never this turn.
          await deps.sessions.set(request.threadId).catch((error: unknown) =>
            deps.log?.("could not record the claude session", {
              threadId: request.threadId,
              error: String(error),
            }),
          );
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
      // Kept only when Claude Code finished the turn, interrupted or not: one that broke
      // off mid-turn would hand the rest of this turn to the next.
      lease.release(started && result !== undefined);
      current = undefined;
    }
    if (result !== undefined && !started) {
      const error = resultError(result) ?? "";
      if (resume && /no conversation found/i.test(error)) throw new SessionMismatch(true);
      if (!resume && /already in use/i.test(error)) throw new SessionMismatch(false);
    }
    return result;
  };

  /**
   * Interrupts the turn, not the session: Claude Code ends the turn with an aborted result
   * and stays up for the next one. When it does not take the interrupt it is ended.
   */
  const stop = (lease: Lease) => {
    void lease.interrupt().catch(() => lease.release(false));
  };

  const run = async () => {
    const hasSession = await deps.sessions.has(request.threadId);
    // Stopped before Claude Code started: it never starts.
    if (interrupted) return;
    // A thread Claude has a session of may have gone on with another agent since.
    const preface = transcript(request.history, hasSession ? CLAUDE_AGENT_ID : undefined);
    const text = preface === undefined ? messageText : `${preface}${messageText}`;
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
          ? `${transcript(request.history)}${messageText}`
          : messageText;
      result = await attempt(!error.resume, retryText);
    }
    if (interrupted) return;
    // Claude Code exited (or its stream closed) mid-turn without a result: not an answer.
    if (result === undefined) throw new Error("Claude Code ended the turn without a result.");
    // Aborted without our interrupt (that returned above): Claude Code stopped on its own.
    if (isAbortedResult(result)) {
      throw new Error(resultError(result) ?? "Claude Code stopped the turn.");
    }
    out.push({ kind: "usage", usage: resultUsage(result, contextTokens) });
    const error = resultError(result);
    if (error !== undefined) throw new Error(error);
  };

  const done = run().then(
    () => out.end(),
    (error: unknown) => {
      // A stop that tears the process down is an interrupt, not a failure.
      if (interrupted) out.end();
      else out.end({ error });
    },
  );

  return {
    done,
    items: out.read(),
    interrupt() {
      if (interrupted) return;
      interrupted = true;
      for (const resolve of answers.values()) resolve(undefined);
      answers.clear();
      if (current !== undefined) stop(current);
    },
    respond(requestId, response) {
      const resolve = answers.get(requestId);
      answers.delete(requestId);
      resolve?.(response);
    },
  };
}
