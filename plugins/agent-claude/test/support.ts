import type { AgentItem, AgentTurn } from "@jhin/agent-api";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { QueryFunction, SessionStore } from "../src/turn.ts";

/** One query a turn started: its options, the prompts it sent and what was done to it. */
interface Call {
  readonly options: Options;
  readonly prompt: SDKUserMessage[];
  /** Live changes, in order: `model:<id>`, `mode:<permission mode>`. */
  readonly controls: string[];
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
 * setPermissionMode fail, as an older CLI would.
 */
export function scriptedQuery(...scripts: Script[]) {
  const calls: Call[] = [];
  const state = { refuseControls: false };
  const query: QueryFunction = ({ prompt, options }) => {
    const script = scripts[calls.length];
    if (script === undefined) throw new Error(`no script for query ${calls.length + 1}`);
    let closeCall!: () => void;
    const call: Call = {
      options,
      prompt: [],
      controls: [],
      interrupts: 0,
      closed: false,
      whenClosed: new Promise((resolve) => (closeCall = resolve)),
    };
    calls.push(call);
    let interrupt!: () => void;
    const player: Player = {
      call,
      interrupted: new Promise<void>((resolve) => (interrupt = resolve)),
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
      yield* script(player);
    }
    const played = play();
    // After close() no message comes, as with the SDK.
    const messages: AsyncIterator<SDKMessage> = {
      next: () =>
        call.closed
          ? Promise.resolve({ done: true, value: undefined })
          : Promise.race([
              played.next(),
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
        return undefined;
      },
      close: () => {
        call.closed = true;
        closeCall();
      },
      setModel: (model) => control(`model:${model}`),
      setPermissionMode: (mode) => control(`mode:${mode}`),
    };
  };
  return { query, calls, state };
}

export function memorySessions(initial: string[] = []): SessionStore & { ids: Set<string> } {
  const ids = new Set(initial);
  return {
    ids,
    has: async (threadId) => ids.has(threadId),
    set: async (threadId) => void ids.add(threadId),
    delete: async (threadId) => void ids.delete(threadId),
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
  options: { isError?: boolean; structured?: unknown } = {},
) =>
  message({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: options.isError }],
    },
    ...(options.structured === undefined ? {} : { tool_use_result: options.structured }),
  });

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
