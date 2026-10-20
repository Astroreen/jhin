// Derived from T3 Code (https://github.com/pingdotgg/t3code) at eb7b35ac:
// apps/server/src/provider/model-manifest.json (the current Claude models of its "claudeAgent"
// catalog, their aliases and context windows, and its default chat model),
// apps/server/src/claudeModelOptions.ts and ClaudeModelCatalog.ts (how a turn's options
// become Claude Code's model id, effort and settings) and packages/shared/src/model.ts
// (applyClaudePromptEffortPrefix).
import {
  applicableModelOptions,
  type AgentModel,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
} from "@jhin/agent-api";

import { CLAUDE_MODEL_PROFILES, CLAUDE_PROFILES, type ClaudeProfile } from "./model-catalog.ts";

/** Shown until Claude Code reports the models of the signed-in account. */
export const BUNDLED_MODELS: readonly AgentModel[] = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
].map(withOptions);

export const BUNDLED_DEFAULT_MODEL = "claude-fable-5-1";

/** The efforts Claude Code takes for a model the manifest does not know. */
const KNOWN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The manifest's profile of a model, by its id or an alias; a context suffix (`[1m]`) is ignored. */
export function claudeProfile(model: string): ClaudeProfile | undefined {
  const name = model.replace(/\[[^\]]*\]$/, "");
  const entry = CLAUDE_MODEL_PROFILES.find(
    (candidate) => candidate.slug === name || candidate.aliases.includes(name),
  );
  return entry === undefined ? undefined : CLAUDE_PROFILES[entry.profile];
}

/** A model with the options its profile declares (D297). */
export function withOptions(model: AgentModel): AgentModel {
  const options = claudeProfile(model.id)?.options;
  return options === undefined || options.length === 0 ? model : { ...model, options };
}

const selectDefault = (descriptor: ModelOptionDescriptor | undefined) =>
  descriptor?.type === "select"
    ? descriptor.options.find((option) => option.isDefault)?.id
    : undefined;

/**
 * Context windows the manifest fixes (`fixedContextWindowTokens`), or the one the turn's
 * `contextWindow` option (else its default) names. Models not listed have no known window
 * until Claude Code reports one in a result.
 */
export function manifestContextWindow(
  model: string,
  selections: readonly ModelOptionSelection[] = [],
): number | undefined {
  const profile = claudeProfile(model);
  if (profile === undefined) return undefined;
  if (profile.runtime.fixedContextWindowTokens !== undefined) {
    return profile.runtime.fixedContextWindowTokens;
  }
  // A model id that carries its window's suffix (`[1m]`) names it.
  for (const [value, suffix] of Object.entries(
    profile.runtime.modelSuffixes?.["contextWindow"] ?? {},
  )) {
    if (model.endsWith(suffix)) return profile.runtime.contextWindowTokens?.[value];
  }
  const descriptor = profile.options.find((option) => option.id === "contextWindow");
  const chosen = applicableModelOptions(profile.options, selections).find(
    (selection) => selection.id === "contextWindow",
  )?.value;
  const value = typeof chosen === "string" ? chosen : selectDefault(descriptor);
  return value === undefined ? undefined : profile.runtime.contextWindowTokens?.[value];
}

/** What Claude Code gets for a turn's model options (T3's `compileClaudeModelSelection`). */
export interface CompiledClaudeSelection {
  /** The model id with its suffix, e.g. `claude-sonnet-4-6[1m]`. */
  readonly model: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Claude Code settings: `fastMode`, `ultracode`, `alwaysThinkingEnabled`. */
  readonly settings: Readonly<Record<string, boolean>>;
  /** False when the model's thinking was switched off. */
  readonly thinking: boolean;
  /** Ultrathink is written into the prompt, not sent as an effort. */
  readonly ultrathink: boolean;
}

/**
 * Compiles a turn's options for `model`. The effort chosen for the turn wins, then the
 * config's `effort`; with neither, Claude Code's own default applies.
 */
export function compileClaudeSelection(
  model: string,
  selections: readonly ModelOptionSelection[] | undefined,
  configEffort: string | undefined,
): CompiledClaudeSelection {
  const profile = claudeProfile(model);
  if (profile === undefined) {
    // A model the manifest does not know: no options, only a known effort.
    return {
      model,
      ...(configEffort !== undefined && KNOWN_EFFORTS.has(configEffort)
        ? { effort: configEffort as NonNullable<CompiledClaudeSelection["effort"]> }
        : {}),
      settings: {},
      thinking: true,
      ultrathink: false,
    };
  }
  const chosen = applicableModelOptions(profile.options, selections);
  const value = (id: string) => chosen.find((selection) => selection.id === id)?.value;
  const declares = (id: string) => profile.options.some((option) => option.id === id);

  const effortDescriptor = profile.options.find((option) => option.id === "effort");
  const configValid =
    configEffort !== undefined &&
    effortDescriptor?.type === "select" &&
    effortDescriptor.options.some((option) => option.id === configEffort);
  const rawEffort =
    typeof value("effort") === "string"
      ? (value("effort") as string)
      : configValid
        ? configEffort
        : undefined;
  const effortMap = profile.runtime.effortMap ?? {};
  const mapped =
    rawEffort === undefined
      ? undefined
      : Object.prototype.hasOwnProperty.call(effortMap, rawEffort)
        ? (effortMap[rawEffort] ?? undefined)
        : rawEffort;

  const thinkingValue = value("thinking");
  const settings: Record<string, boolean> = {
    ...(declares("thinking") && typeof thinkingValue === "boolean"
      ? { alwaysThinkingEnabled: thinkingValue }
      : {}),
    ...(declares("fastMode") ? { fastMode: value("fastMode") === true } : {}),
    ...(rawEffort === "ultracode" ? { ultracode: true } : {}),
  };

  let id = model.replace(/\[[^\]]*\]$/, "");
  for (const [optionId, suffixes] of Object.entries(profile.runtime.modelSuffixes ?? {})) {
    const optionValue =
      value(optionId) ?? selectDefault(profile.options.find((option) => option.id === optionId));
    if (typeof optionValue === "string" && suffixes[optionValue] !== undefined) {
      id = `${id}${suffixes[optionValue]}`;
      break;
    }
  }

  return {
    model: id,
    ...(mapped !== undefined && KNOWN_EFFORTS.has(mapped)
      ? { effort: mapped as NonNullable<CompiledClaudeSelection["effort"]> }
      : {}),
    settings,
    thinking: thinkingValue !== false,
    ultrathink: rawEffort === "ultrathink",
  };
}

/**
 * Ultrathink as Claude Code takes it: "Ultrathink:" before the message, never before a
 * slash command, which would then be prose (T3's `applyClaudePromptEffortPrefix`).
 */
export function applyUltrathinkPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || /^\/[^\s/]+(?:\s|$)/u.test(trimmed) || trimmed.startsWith("Ultrathink:")) {
    return text;
  }
  return `Ultrathink:\n${trimmed}`;
}
