// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/provider/model-manifest.json at eb7b35ac: the current Claude models
// of its "claudeAgent" catalog and its default chat model.
import type { AgentModel } from "@jhin/agent-api";

/** Shown until Claude Code reports the models of the signed-in account. */
export const BUNDLED_MODELS: readonly AgentModel[] = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

export const BUNDLED_DEFAULT_MODEL = "claude-fable-5-1";
