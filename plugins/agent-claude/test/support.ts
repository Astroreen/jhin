import type { AgentItem, AgentTurn } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { QueryFunction, SessionRecord, SessionStore } from "../src/turn.ts";

/** One query a turn started: its options, the prompts it sent and what was done to it. */
interface Call {
  readonly options: Options;
  readonly prompt: SDKUserMessage[];
  /** Live changes, in order: `model:<id>`, `mode:<permission mode>`, `effort:<level>`. */
  readonly controls: string[];
  /** The MCP servers registered over the control channel (`setMcpServers`), in order. */
  readonly mcpServers: Record<string, unknown>[];
  interrupts: number;
  closed: boolean;
  /** Resolves when the query is closed. */
  readonly whenClosed: Promise<void>;
}

/** What a script can do while it plays Claude Code. */
interface Player {
  readonly call: Call;
  /** Resolves when a turn first interrupts the query. */
  readonly interrupted: Promise<void>;
  /** Resolves once the query was interrupted `count` times. */
  interruptedTimes(count: number): Promise<void>;
  /** The next message of the prompt stream, as a live session gets its next turn; `undefined` once it ends. */
  nextPrompt(): Promise<SDKUserMessage | undefined>;
  /** Calls the turn's canUseTool, as Claude Code does before running a tool. */
  canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
    signal?: AbortSignal,
  ): ReturnType<NonNullable<Options["canUseTool"]>>;
}

export type Script = (player: Player) => AsyncGenerator<SDKMessage, void, undefined>;

/**
 * A scripted stand-in for the SDK's `query`: every call plays the next script, and the
 * script's end is Claude Code exiting. `refuseControls` makes setModel and
 * setPermissionMode fail, as an older CLI would. `mcp` says how setMcpServers answers:
 * every server connected, every one failed, or never.
 */
export function scriptedQuery(...scripts: Script[]) {
  const calls: Call[] = [];
  const state: {
    refuseControls: boolean;
    mcp: "connect" | "fail" | "silent";
    /** What an interrupt answers with: the receipt of a current CLI (D350). */
    receipt?: (call: Call) => unknown;
    /** How `backgroundTasks` answers (D805); it moves the task by default. */
    background?: (toolUseId: string | undefined) => Promise<boolean>;
    /** An older CLI: the query has no `backgroundTasks`. */
    noBackground?: boolean;
  } = {
    refuseControls: false,
    mcp: "connect",
  };
  const query: QueryFunction = ({ prompt, options }) => {
    const script = scripts[calls.length];
    if (script === undefined) throw new Error(`no script for query ${calls.length + 1}`);
    const played: Script = script;
    let closeCall!: () => void;
    const call: Call = {
      options,
      prompt: [],
      controls: [],
      mcpServers: [],
      interrupts: 0,
      closed: false,
      whenClosed: new Promise((resolve) => (closeCall = resolve)),
    };
    calls.push(call);
    let interrupt!: () => void;
    const waiting: { count: number; resolve: () => void }[] = [];
    const player: Player = {
      call,
      interrupted: new Promise<void>((resolve) => (interrupt = resolve)),
      interruptedTimes: (count) =>
        call.interrupts >= count
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiting.push({ count, resolve })),
      nextPrompt: async () => {
        const next = await prompts.next();
        if (next.done === true) return undefined;
        call.prompt.push(next.value);
        return next.value;
      },
      canUseTool: (toolName, input, toolUseID, signal = new AbortController().signal) =>
        options.canUseTool!(toolName, input, {
          signal,
          toolUseID,
        } as Parameters<NonNullable<Options["canUseTool"]>>[2]),
    };
    const prompts = prompt[Symbol.asyncIterator]();
    async function* play(): AsyncGenerator<SDKMessage, void, undefined> {
      if ((await player.nextPrompt()) === undefined) return;
      yield* played(player);
    }
    const playing = play();
    // After close() no message comes, as with the SDK.
    const messages: AsyncIterator<SDKMessage> = {
      next: () =>
        call.closed
          ? Promise.resolve({ done: true, value: undefined })
          : Promise.race([
              playing.next(),
              call.whenClosed.then(() => ({ done: true as const, value: undefined })),
            ]),
    };
    const control = async (entry: string) => {
      if (state.refuseControls) throw new Error("Unsupported control request");
      call.controls.push(entry);
    };
    return {
      [Symbol.asyncIterator]: () => messages,
      interrupt: async () => {
        call.interrupts++;
        interrupt();
        for (const waiter of waiting) if (call.interrupts >= waiter.count) waiter.resolve();
        return state.receipt?.(call);
      },
      close: () => {
        call.closed = true;
        closeCall();
      },
      ...(state.noBackground === true
        ? {}
        : {
            backgroundTasks: (toolUseId?: string) => {
              call.controls.push(`background:${toolUseId}`);
              return state.background?.(toolUseId) ?? Promise.resolve(true);
            },
          }),
      stopTask: async (taskId: string) => {
        call.controls.push(`stop:${taskId}`);
      },
      setModel: (model) => control(`model:${model}`),
      setPermissionMode: (mode) => control(`mode:${mode}`),
      applyFlagSettings: (settings) =>
        control(
          "effortLevel" in settings
            ? `effort:${settings.effortLevel}`
            : `flags:fastMode=${settings.fastMode},ultracode=${settings.ultracode}`,
        ),
      setMcpServers: (servers) => {
        call.mcpServers.push(servers);
        const names = Object.keys(servers);
        if (state.mcp === "silent") return new Promise(() => {});
        return Promise.resolve({
          added: state.mcp === "connect" ? names : [],
          removed: [],
          errors:
            state.mcp === "connect"
              ? {}
              : Object.fromEntries(names.map((name) => [name, "connection refused"])),
        });
      },
    };
  };
  return { query, calls, state };
}

export function memorySessions(
  initial: string[] = [],
): SessionStore & { ids: Set<string>; records: Map<string, SessionRecord> } {
  const ids = new Set(initial);
  const records = new Map<string, SessionRecord>();
  return {
    ids,
    records,
    get: async (threadId) =>
      ids.has(threadId) ? (records.get(threadId) ?? { sessionId: threadId }) : undefined,
    set: async (threadId, record) => {
      ids.add(threadId);
      records.set(threadId, record);
    },
    delete: async (threadId) => {
      ids.delete(threadId);
      records.delete(threadId);
    },
  };
}

/** Every item of a turn, answering requests with `answer` as they open. */
export async function drain(
  turn: AgentTurn,
  answer?: (
    item: Extract<AgentItem, { kind: "request.opened" }>,
  ) => Parameters<NonNullable<AgentTurn["respond"]>>[1],
): Promise<AgentItem[]> {
  const items: AgentItem[] = [];
  for await (const item of turn.items) {
    items.push(item);
    if (item.kind === "request.opened" && answer !== undefined) {
      turn.respond!(item.requestId, answer(item));
    }
  }
  return items;
}

// --- SDK messages -----------------------------------------------------------------

const message = (value: unknown) => value as SDKMessage;

export const init = (permissionMode?: string) =>
  message({
    type: "system",
    subtype: "init",
    session_id: "s",
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });

/** A streamed text (or thinking) block of an API message, snapshot before its stop as the CLI sends it. */
export function* streamedBlock(
  messageId: string,
  index: number,
  kind: "text" | "thinking",
  parts: readonly string[],
  options: { start?: boolean; inputTokens?: number; snapshotLast?: boolean } = {},
): Generator<SDKMessage> {
  if (options.start !== false) {
    yield message({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: { id: messageId, usage: { input_tokens: options.inputTokens ?? 100 } },
      },
    });
  }
  yield message({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index,
      content_block:
        kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
    },
  });
  for (const part of parts) {
    yield message({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index,
        delta:
          kind === "text"
            ? { type: "text_delta", text: part }
            : { type: "thinking_delta", thinking: part },
      },
    });
  }
  const text = parts.join("");
  const snapshot = message({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: messageId,
      content: [kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text }],
    },
  });
  const stop = message({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_stop", index },
  });
  if (options.snapshotLast === true) yield* [stop, snapshot];
  else yield* [snapshot, stop];
}

export const toolUse = (
  messageId: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null,
) =>
  message({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { id: messageId, content: [{ type: "tool_use", id, name, input }] },
  });

export const toolResult = (
  id: string,
  content: unknown,
  options: { isError?: boolean; structured?: unknown; parent?: string } = {},
) =>
  message({
    type: "user",
    parent_tool_use_id: options.parent ?? null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: options.isError }],
    },
    ...(options.structured === undefined ? {} : { tool_use_result: options.structured }),
  });

/** A system frame of Claude Code (`task_started`, `background_tasks_changed`, …). */
export const system = (subtype: string, fields: Record<string, unknown> = {}) =>
  message({ type: "system", subtype, uuid: `${subtype}-uuid`, session_id: "s", ...fields });

export const result = (overrides: Record<string, unknown> = {}) =>
  message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
    modelUsage: { "claude-fable-5-1": { contextWindow: 1_000_000 } },
    ...overrides,
  });

/** A thread's earlier turns `t1`…, as the threads plugin passes them: Claude's own. */
export const earlierTurns = (threadId: string, count: number): StoredEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    stream: `thread/${threadId}`,
    sequence: index + 1,
    type: "agent.turn.started",
    payload: { turnId: `t${index + 1}`, agentId: "jhin.agent-claude", input: { text: "" } },
    at: "2026-01-01T00:00:00.000Z",
  }));
