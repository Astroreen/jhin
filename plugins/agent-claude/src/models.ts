// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/provider/model-manifest.json at eb7b35ac: the current Claude models
// of its "claudeAgent" catalog, their aliases and context windows, and its default chat model.
import type { AgentModel } from "@jhin/agent-api";

/** Shown until Claude Code reports the models of the signed-in account. */
export const BUNDLED_MODELS: readonly AgentModel[] = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

export const BUNDLED_DEFAULT_MODEL = "claude-fable-5-1";

/**
 * Context windows the manifest fixes (`fixedContextWindowTokens`), by model id and alias.
 * Models not listed have no known window until Claude Code reports one in a result.
 */
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.fromEntries(
  [
    ["claude-opus-5-5", "opus", "opus-5.5", "claude-opus-5.5"],
    ["claude-sonnet-5-5", "sonnet", "sonnet-5.5", "claude-sonnet-5.5"],
    ["claude-fable-5-1", "fable", "fable-5.1", "claude-fable-5.1"],
    ["claude-haiku-5-5", "haiku", "haiku-5.5", "claude-haiku-5.5"],
  ].flatMap((names) => names.map((name) => [name, 1_000_000])),
);

export function manifestContextWindow(model: string): number | undefined {
  return CONTEXT_WINDOWS[model];
}
