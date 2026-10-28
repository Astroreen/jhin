import type { ToolCall } from "@jhin/agent-api";
import type { ChatToolPresentation, ChatTools } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { useContext, useSyncExternalStore } from "react";

import { mcpToolOf, type PresentTool } from "../../lib/timeline.ts";
import { ChatContext } from "./services.ts";

/** `chat.tools@1` (preview.md D1681): the commands other plugins describe, by MCP tool name. */
export function createToolPresentations(): ChatTools & {
  /** The presentation of a call, when it calls a described command; new after every change. */
  readonly present: () => PresentTool;
  subscribe(listener: () => void): () => void;
} {
  const byTool = new Map<string, ChatToolPresentation[]>();
  const listeners = new Set<() => void>();
  const lookup = (): PresentTool => (tool: ToolCall) => {
    const name = mcpToolOf(tool.name);
    return name === undefined ? undefined : byTool.get(name)?.at(-1);
  };
  let present = lookup();
  const changed = () => {
    present = lookup();
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    describe(command, presentation) {
      // The MCP server names a command's tool this way (`@jhin/mcp-bridge`'s toolName).
      const name = command.replaceAll(".", "_");
      byTool.set(name, [...(byTool.get(name) ?? []), presentation]);
      changed();
      return toDisposable(() => {
        const left = (byTool.get(name) ?? []).filter((entry) => entry !== presentation);
        if (left.length === 0) byTool.delete(name);
        else byTool.set(name, left);
        changed();
      });
    },
    present: () => present,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ToolPresentations = ReturnType<typeof createToolPresentations>;

const none: PresentTool = () => undefined;
const noSubscription = () => () => {};

/** The described commands, for the work log; nothing outside the chat's context. */
export function usePresentTool(): PresentTool {
  const tools = useContext(ChatContext)?.tools;
  return useSyncExternalStore(tools?.subscribe ?? noSubscription, tools?.present ?? (() => none));
}
