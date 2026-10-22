// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts at eb7b35ac: query options
// (makeClaudeQueryOptions), runtime and interaction modes to Claude permission modes
// (permissionModeForClaudeRuntimePolicy), the canUseTool callback (approvals,
// AskUserQuestion, ExitPlanMode) and the stream projection of reasoning, tools and usage,
// with its subagents in the background followed through their task frames (D1165).
// The live query a turn runs on is leased from ./session.ts: kept between turns, or started
// for each turn and resumed, as the `session` setting says.
import { randomUUID } from "node:crypto";
import * as Path from "node:path";

import type {
  AgentItem,
  SubagentWorkItem,
  AgentResponse,
  AgentTurn,
  InteractionMode,
  RuntimeAttachment,
  RuntimeMode,
  TurnRequest,
} from "@jhin/agent-api";
import { DEFAULT_RUNTIME_MODE, ThreadEvents, historyTranscript } from "@jhin/agent-api";
import { MCP_SERVER_NAME, jhinToolsInstructions } from "@jhin/mcp-api";
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
  endedBySteer,
  inheritedEnvironment,
  LeaseEnded,
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
import { planSkillDispatch } from "./commands.ts";
import { applyUltrathinkPrefix, compileClaudeSelection } from "./models.ts";

export type { QueryFunction } from "./session.ts";

/** The runtime's agent id, recorded on Claude's turns (D90). */
export const CLAUDE_AGENT_ID = "jhin.agent-claude";

/** A thread's Claude session: its id, and the turn that last ran on it (D222). */
export interface SessionRecord {
  /** The thread's id, unless a rollback started the thread a new session. */
  readonly sessionId: string;
  /** Absent in records older than rollbacks. */
  readonly turnId?: string;
}

/** Which threads already have a Claude session. */
export interface SessionStore {
  get(threadId: string): Promise<SessionRecord | undefined>;
  set(threadId: string, record: SessionRecord): Promise<void>;
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
  /** The skills a `$name` in the message can invoke (D301). */
  readonly skills?: () => Promise<ReadonlySet<string>>;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
  /** The node's MCP server for a Claude Code started for the thread (D340); none when unset. */
  readonly mcp?: {
    attach(threadId: string): Attachment;
    /** Whether a tool of it only reads (`threads_list`); `threads_send` does not. */
    readOnly(tool: string): boolean;
  };
}

/** The name Claude Code knows the node's MCP server by; its tools are `mcp__jhin__<tool>`. */
export { MCP_SERVER_NAME };

/** The tools of the node's MCP server, approved without asking (T3's `mcp__t3-code__*`). */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** What the appended system prompt says about the node's MCP server (T3's orchestration section). */
export const JHIN_MCP_INSTRUCTIONS = `\n\n${jhinToolsInstructions(
  (tool) => `Claude Code shows it as \`${MCP_TOOL_PREFIX}${tool}\``,
)}`;

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
/** The tools that start a subagent: `Agent`, and `Task` in older CLIs. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

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

/** Claude's own limit on a message's text (T3's PROVIDER_SEND_TURN_MAX_INPUT_CHARS). */
const MAX_INPUT_CHARS = 120_000;

/**
 * The message Claude Code gets: images as base64 blocks before the text, and the file
 * of every stored attachment named after it, as T3 writes it
 * (`[Attached file "name" is saved at: /path]`), so Claude can read files of any kind.
 */
async function userMessage(
  text: string,
  attachments: readonly RuntimeAttachment[] = [],
  skipped: (attachment: RuntimeAttachment) => void = () => {},
  skills: ReadonlySet<string> = new Set(),
): Promise<SDKUserMessage> {
  // A `$skill` goes last, as `/skill`, in a block of its own (D301).
  const dispatch = planSkillDispatch(text, skills);
  if (dispatch !== undefined) text = dispatch.leadingText ?? "";
  const images: {
    type: "image";
    source: { type: "base64"; media_type: "image/png"; data: string };
  }[] = [];
  let body = text;
  for (const attachment of attachments) {
    if ("dataUrl" in attachment) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.dataUrl);
      if (match === null || !IMAGE_TYPES.has(match[1]!)) {
        skipped(attachment);
        continue;
      }
      images.push({
        type: "image",
        source: { type: "base64", media_type: match[1] as "image/png", data: match[2]! },
      });
      continue;
    }
    if (attachment.kind === "image") {
      if (IMAGE_TYPES.has(attachment.mimeType)) {
        images.push({
          type: "image",
          source: {
            type: "base64",
            media_type: attachment.mimeType as "image/png",
            data: Buffer.from(await attachment.read()).toString("base64"),
          },
        });
      } else {
        skipped(attachment);
      }
    }
    if (attachment.path !== undefined) {
      const line = `[Attached ${attachment.kind} "${attachment.name}" is saved at: ${attachment.path}]`;
      const candidate = body ? `${body}\n\n${line}` : line;
      if (candidate.length <= MAX_INPUT_CHARS) body = candidate;
    }
  }
  const blocks = [
    ...images,
    ...(body === "" && dispatch !== undefined ? [] : [{ type: "text" as const, text: body }]),
    ...(dispatch === undefined ? [] : [{ type: "text" as const, text: dispatch.commandText }]),
  ];
  return {
    type: "user",
    // Fresh for every message: Claude Code marks the frames answering it with this uuid,
    // so a live session hands a turn only its own (session.ts).
    uuid: randomUUID(),
    message: {
      role: "user",
      content: blocks.length === 1 && blocks[0]!.type === "text" ? blocks[0]!.text : blocks,
    },
    parent_tool_use_id: null,
  };
}

/**
 * The conversation Claude has not seen, as context for the first message it gets (D102):
 * `historyTranscript` of `@jhin/agent-api`, shared with the other runtimes.
 */
export const transcript = historyTranscript;

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

/** What a turn hands over of its subagents in the background once it ended (D1164). */
type AfterwardsItem = Extract<AgentItem, { readonly kind: "subagent.item" | "subagent.ended" }>;

/** A frame about a subagent's work: its own messages, or Claude Code's task frames. */
const subagentFrame = (message: SDKMessage) =>
  ("parent_tool_use_id" in message && Boolean(message.parent_tool_use_id)) ||
  (message.type === "system" &&
    (message.subtype === "task_started" ||
      message.subtype === "task_updated" ||
      message.subtype === "task_notification"));

/** Items `afterwards` holds unread before it gives up on its reader (D1165). */
const MAX_UNREAD_LATER = 10_000;

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
  /** The later work of its subagents in the background (D1164), read after `items`. */
  const laterItems = channel<AgentItem>(() => false);
  /** Items handed to `afterwards` and not read yet. */
  let unreadLater = 0;
  const later = {
    push: (item: AgentItem) => {
      unreadLater += 1;
      laterItems.push(item);
    },
    end: laterItems.end,
    read: async function* () {
      for await (const item of laterItems.read()) {
        unreadLater -= 1;
        yield item;
      }
    },
  };
  /** The session is followed past the turn for its subagents in the background. */
  let following = false;
  /** Stops following the session: `afterwards` was given up on, or every subagent ended. */
  let release = () => {};
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
  /** Messages steered into the turn: each lease of the turn gets them after its own. */
  const steered: SDKUserMessage[] = [];
  /** Steers being built (their images read): each goes in after the one before. */
  let steering: Promise<void> = Promise.resolve();
  /** The turn read its result: it takes no steer any more. */
  let finished = false;

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
    // Its own work is shown as a child thread (orchestration.md D878).
    if (SUBAGENT_TOOLS.has(name)) {
      subagentIds.add(id);
      const fields = (input ?? {}) as {
        description?: unknown;
        prompt?: unknown;
        model?: unknown;
        run_in_background?: unknown;
      };
      out.push({
        kind: "subagent.started",
        subagentId: id,
        title: typeof fields.description === "string" ? fields.description : "Subagent",
        prompt: typeof fields.prompt === "string" ? fields.prompt : "",
        ...(typeof fields.model === "string" ? { model: fields.model } : {}),
      });
      if (fields.run_in_background === true) background(id, out.push);
    }
  };

  /** A subagent's own messages, as items of its thread (D878): whole messages, not streamed. */
  const subagentTools = new Map<string, string>();
  /** Numbers a subagent's message and reasoning items, unique within the turn. */
  let subagentItems = 0;
  /** The subagents this turn started; a subagent's own subagents are not among them. */
  const subagentIds = new Set<string>();
  /** Its subagents in the background, still running (D1165). */
  const backgrounded = new Set<string>();
  /** Its subagents ever in the background: their call's quick result does not end them. */
  const wentBackground = new Set<string>();
  /** The tool call that started each task, from `task_started`. */
  const taskTools = new Map<string, string>();
  type Push = (item: AgentItem) => void;
  /** Its subagents whose call returned in the foreground: ended, never moved afterwards. */
  const endedInForeground = new Set<string>();
  const background = (subagentId: string, push: Push) => {
    if (!subagentIds.has(subagentId) || wentBackground.has(subagentId)) return;
    if (endedInForeground.has(subagentId)) return;
    wentBackground.add(subagentId);
    backgrounded.add(subagentId);
    push({ kind: "subagent.backgrounded", subagentId });
  };
  /** Claude Code's frames about its tasks: a subagent going to the background, or ending there. */
  const taskFrame = (message: SDKMessage, push: Push) => {
    if (message.type !== "system") return;
    if (message.subtype === "task_started") {
      if (message.tool_use_id === undefined) return;
      taskTools.set(message.task_id, message.tool_use_id);
      if (message.is_backgrounded === true) background(message.tool_use_id, push);
    } else if (message.subtype === "task_updated") {
      const tool = taskTools.get(message.task_id);
      if (tool !== undefined && message.patch.is_backgrounded === true) background(tool, push);
    } else if (message.subtype === "task_notification") {
      const tool = message.tool_use_id ?? taskTools.get(message.task_id);
      if (tool === undefined || !backgrounded.has(tool)) return;
      backgrounded.delete(tool);
      const summary = message.summary.trim();
      push({
        kind: "subagent.ended",
        subagentId: tool,
        status:
          message.status === "completed"
            ? "completed"
            : message.status === "failed"
              ? "failed"
              : "interrupted",
        ...(message.status === "failed" && summary !== "" ? { error: summary } : {}),
      });
    }
  };
  const projectSubagent = (subagentId: string, message: SDKMessage, push: Push = out.push) => {
    const items: SubagentWorkItem[] = [];
    if (message.type === "assistant") {
      message.message.content.forEach((block) => {
        if (block.type === "text" || block.type === "thinking") {
          const text = block.type === "text" ? block.text : block.thinking;
          if (text.trim().length === 0) return;
          const kind = block.type === "text" ? "message" : "reasoning";
          items.push({
            kind: `${kind}.completed`,
            // Claude Code sends a message's blocks in frames of their own, each at index 0.
            itemId: `${subagentId}:${(subagentItems += 1)}`,
            text,
          });
        } else if (block.type === "tool_use") {
          subagentTools.set(block.id, block.name);
          if (!isSilentTool(block.name)) {
            items.push({
              kind: "tool.started",
              itemId: block.id,
              tool: toolCall(block.name, block.input),
            });
          }
        }
      });
    } else if (message.type === "user" && typeof message.message.content !== "string") {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const name = subagentTools.get(block.tool_use_id);
        if (name === undefined || isSilentTool(name)) continue;
        const text = toolResultText(block.content);
        const output =
          text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…` : text;
        const failed = block.is_error === true;
        items.push({
          kind: "tool.completed",
          itemId: block.tool_use_id,
          status: failed ? "failed" : "completed",
          ...(output.length === 0 ? {} : failed ? { error: output } : { output }),
        });
      }
    }
    for (const item of items) push({ kind: "subagent.item", subagentId, item });
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
    // A subagent's own messages go to its thread.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
      // A nested subagent's messages name its own call, which this turn did not start: dropped.
      if (subagentIds.has(message.parent_tool_use_id)) {
        projectSubagent(message.parent_tool_use_id, message);
      }
      return;
    }
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
          // One in the background ends with its task, not with its call's quick result (D1165).
          if (SUBAGENT_TOOLS.has(tool.name) && !wentBackground.has(block.tool_use_id)) {
            endedInForeground.add(block.tool_use_id);
            out.push({
              kind: "subagent.ended",
              subagentId: block.tool_use_id,
              status:
                status === "completed"
                  ? "completed"
                  : status === "failed"
                    ? "failed"
                    : "interrupted",
              ...(status === "failed" && output.length > 0 ? { error: output } : {}),
            });
          }
        }
        return;
      }
      case "system":
        taskFrame(message, out.push);
        // Claude Code compacted the conversation: refocus follows it (agents.md D709).
        if (message.subtype === "compact_boundary") {
          out.push({ kind: "context.compacted", trigger: message.compact_metadata.trigger });
        }
        return;
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
  /** The session this turn runs on: the thread's id, or the one a rollback started (D222). */
  let sessionId = request.threadId;
  // Claude reads the attachments' files where the node keeps them (T3 adds its
  // attachments folder to additionalDirectories the same way).
  const attachmentFolders = [
    ...new Set(
      (request.input.attachments ?? []).flatMap((attachment) =>
        "path" in attachment && attachment.path !== undefined
          ? [Path.dirname(attachment.path)]
          : [],
      ),
    ),
  ];
  const options = (resume: boolean): Options => ({
    cwd: request.cwd,
    ...(attachmentFolders.length === 0 ? {} : { additionalDirectories: attachmentFolders }),
    model,
    ...(resume ? { resume: sessionId } : { sessionId }),
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
          : `\n${deps.settings.appendSystemPrompt}`) +
        // What a defined agent's generation is told (D605): part of the launch key (D99).
        (request.instructions === undefined ? "" : `\n\n${request.instructions}`),
    },
  });

  /** One query; resolves with the result, or `undefined` when the stream ended without one. */
  const attempt = async (resume: boolean, text: string) => {
    const lease = await live.lease({
      threadId: request.threadId,
      options: options(resume),
      ...(deps.mcp === undefined ? {} : { attach: deps.mcp.attach }),
      ...(deps.settings.inheritEnv === undefined ? {} : { inherit: deps.settings.inheritEnv }),
      message: await userMessage(
        text,
        request.input.attachments,
        (attachment) =>
          deps.log?.("claude takes no such attachment, skipped", {
            name: attachment.name,
            mimeType: attachment.mimeType,
          }),
        skills,
      ),
    });
    current = lease;
    // Every frame of the session in order, so the work of its subagents in the background
    // is read on from where the turn stopped reading (D1165).
    const order = new WeakMap<object, number>();
    let counter = 0;
    /** The order of the last frame the turn read. */
    let read = 0;
    /** Subagent frames the turn has not read yet. */
    const unread: SDKMessage[] = [];
    let tapping = true;
    let untap = () => {
      tapping = false;
    };
    /** After the turn: its subagents in the background, until each ended or nobody reads. */
    const follow = (message: SDKMessage) => {
      // Nobody reads `afterwards` (it is optional for a runtime's caller): let go of the session.
      if (unreadLater >= MAX_UNREAD_LATER) {
        untap();
        later.end();
        return;
      }
      if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
        if (backgrounded.has(message.parent_tool_use_id)) {
          projectSubagent(message.parent_tool_use_id, message, later.push);
        }
      } else {
        taskFrame(message, later.push);
      }
      if (backgrounded.size === 0) {
        untap();
        later.end();
      }
    };
    const stopTapping = lease.tap({
      message(message) {
        order.set(message, (counter += 1));
        if (!subagentFrame(message)) return;
        if (following) follow(message);
        else unread.push(message);
      },
      end() {
        tapping = false;
        // Claude Code ended: their work can no longer be read.
        if (following) later.end();
      },
    });
    untap = () => {
      tapping = false;
      stopTapping();
    };
    /** Hands the subagents still in the background over to `afterwards`. */
    const handOver = () => {
      if (backgrounded.size === 0) return untap();
      following = true;
      release = untap;
      // What came after the turn's last frame, also when Claude Code has exited since.
      for (const message of unread.splice(0)) {
        if ((order.get(message) ?? 0) > read) follow(message);
      }
      if (!tapping) later.end();
    };
    if (interrupted) stop(lease);
    // Steers that came while the turn waited for its Claude Code go in after its message.
    for (const message of steered) lease.steer(message);
    let started = false;
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of lease.messages) {
        read = order.get(message) ?? read;
        while (unread.length > 0 && (order.get(unread[0]!) ?? 0) <= read) unread.shift();
        // Claude Code initializes every turn, also on a session kept from an earlier one.
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          // A record that could not be written costs one retry on the next turn (D91),
          // never this turn.
          await deps.sessions
            .set(request.threadId, { sessionId, turnId: request.turnId })
            .catch((error: unknown) =>
              deps.log?.("could not record the claude session", {
                threadId: request.threadId,
                error: String(error),
              }),
            );
          continue;
        }
        if (message.type === "result") {
          result = message;
          finished = true;
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
      handOver();
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

  /** The skills a `$name` may invoke, read once per turn. */
  let skills: ReadonlySet<string> = new Set();
  const run = async () => {
    // Only a message that may name one reads them (a currency sign: `$deploy`).
    if (/\p{Sc}/u.test(request.input.text)) {
      skills = (await deps.skills?.().catch(() => undefined)) ?? new Set();
    }
    const record = await deps.sessions.get(request.threadId);
    // The session holds a turn the thread no longer shows (a rollback dropped it): it
    // cannot forget it, so the thread starts a new one with its transcript (D222).
    const stale =
      record?.turnId !== undefined &&
      !request.history.some(
        (event) =>
          event.type === ThreadEvents.turnStarted &&
          (event.payload as { turnId?: unknown } | null)?.turnId === record.turnId,
      );
    const hasSession = record !== undefined && !stale;
    // Stopped before Claude Code started: it never starts, and its process stays.
    if (interrupted) return;
    if (stale) {
      deps.log?.("claude session holds dropped turns, starting a new one", {
        threadId: request.threadId,
      });
      // The process kept for the thread runs the old session: it ends.
      deps.live?.close(request.threadId);
      sessionId = randomUUID();
    } else if (record !== undefined) {
      sessionId = record.sessionId;
    }
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
    // Stopped by a steer that needed no more answer: the turn is complete. Any other
    // abort, also one after a steer, is Claude Code stopping on its own.
    if (endedBySteer(result)) return;
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
  void done.then(() => {
    if (!following) later.end();
  });

  return {
    done,
    items: out.read(),
    afterwards: (async function* () {
      try {
        for await (const item of later.read()) {
          if (item.kind === "subagent.item" || item.kind === "subagent.ended") {
            yield item satisfies AfterwardsItem;
          }
        }
      } finally {
        // Read no further (also when its reader stopped early): the session is let go.
        release();
        later.end();
      }
    })(),
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
    steer(input) {
      if (interrupted || finished) {
        throw new Error("The turn has ended: Claude Code takes no more messages for it.");
      }
      // Uploaded images are read first; steers keep their order while they are.
      steering = steering.then(async () => {
        const message = await userMessage(input.text, input.attachments, (attachment) =>
          deps.log?.("claude takes no such attachment, skipped", {
            name: attachment.name,
            mimeType: attachment.mimeType,
          }),
        );
        if (finished) return;
        // Its foreground subagents keep running: a steer would cancel them (D805).
        await current?.backgroundSubagents();
        if (finished) {
          // The turn read its result while Claude Code moved the subagents (see Deferred).
          deps.log?.("claude code ended the turn before it took a steer", { at: "result" });
          return;
        }
        // Into the running query now, or after the turn's message once it has one.
        try {
          current?.steer(message);
        } catch (error) {
          if (!(error instanceof LeaseEnded)) throw error;
          // The turn's messages ended while Claude Code moved the subagents (see Deferred).
          deps.log?.("claude code ended the turn before it took a steer", { at: "messages" });
          return;
        }
        steered.push(message);
      });
    },
  };
}
