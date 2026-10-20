// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// packages/shared/src/model.ts (option descriptors and their current values,
// isClaudeUltrathinkPrompt, applyClaudePromptEffortPrefix) and
// apps/web/src/components/chat/TraitsPicker.tsx (the traits menu's logic and its trigger label).
import type { ModelOptionDescriptor, ModelOptionSelection } from "@jhin/agent-api";

export type SelectDescriptor = Extract<ModelOptionDescriptor, { type: "select" }>;

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

const REASONING_SELECT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "reasoning",
  "effort",
  "variant",
  "thinking",
]);

function isUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

function applyUltrathinkPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  // Prefixing a slash command turns it into plain prose, so Claude never runs it.
  if (/^\/[^\s/]+(?:\s|$)/u.test(trimmed) || trimmed.startsWith("Ultrathink:")) return trimmed;
  return `${ULTRATHINK_PROMPT_PREFIX}${trimmed}`;
}

/** A descriptor's value now: the chosen one if the descriptor offers it, else its default. */
export function currentOptionValue(
  descriptor: ModelOptionDescriptor,
  selections: readonly ModelOptionSelection[] | undefined,
): string | boolean | undefined {
  const chosen = selections?.find((selection) => selection.id === descriptor.id)?.value;
  if (descriptor.type === "boolean") return typeof chosen === "boolean" ? chosen : undefined;
  if (typeof chosen === "string" && descriptor.options.some((option) => option.id === chosen)) {
    return chosen;
  }
  return descriptor.options.find((option) => option.isDefault)?.id;
}

function currentOptionLabel(
  descriptor: ModelOptionDescriptor,
  selections: readonly ModelOptionSelection[] | undefined,
): string | undefined {
  const value = currentOptionValue(descriptor, selections);
  if (descriptor.type === "boolean") {
    return typeof value === "boolean" ? (value ? "On" : "Off") : undefined;
  }
  return descriptor.options.find((option) => option.id === value)?.label;
}

/** The selections with `id` set to `value`, every other descriptor keeping its current value. */
export function withOptionValue(
  descriptors: readonly ModelOptionDescriptor[],
  selections: readonly ModelOptionSelection[] | undefined,
  id: string,
  value: string | boolean,
): ModelOptionSelection[] {
  const next: ModelOptionSelection[] = [];
  for (const descriptor of descriptors) {
    const current = descriptor.id === id ? value : currentOptionValue(descriptor, selections);
    if (typeof current === "string" || typeof current === "boolean") {
      next.push({ id: descriptor.id, value: current });
    }
  }
  return next;
}

/** What the traits menu shows for a model's descriptors and the prompt typed. */
export function selectedTraits(descriptors: readonly ModelOptionDescriptor[], prompt: string) {
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ModelOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const ultrathinkPromptControlled =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 && isUltrathinkPrompt(prompt);
  // "ultrathink" written in the text itself, not only as the prefix the menu writes.
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  return {
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  };
}

/**
 * What picking `value` in a select changes: a prompt-injected value (Ultrathink) is
 * written into the prompt; any other replaces the option, and picking another effort
 * takes the Ultrathink prefix out again. Null when nothing may change.
 */
export function traitSelectChange(
  descriptors: readonly ModelOptionDescriptor[],
  selections: readonly ModelOptionSelection[] | undefined,
  descriptor: SelectDescriptor,
  prompt: string,
  value: string,
): { prompt: string; modelOptions?: ModelOptionSelection[] } | null {
  if (!value) return null;
  const selected = selectedTraits(descriptors, prompt);
  if (descriptor.promptInjectedValues?.includes(value)) {
    return {
      prompt: prompt.trim().length === 0 ? ULTRATHINK_PROMPT_PREFIX : applyUltrathinkPrefix(prompt),
    };
  }
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  if (isPrimary && selected.ultrathinkInBodyText) return null;
  return {
    prompt:
      isPrimary && selected.ultrathinkPromptControlled
        ? prompt.replace(/^Ultrathink:\s*/i, "")
        : prompt,
    modelOptions: withOptionValue(descriptors, selections, descriptor.id, value),
  };
}

/** The traits button's label (T3's `buildTraitsTriggerDisplay`): "High · Fast", "Ultrathink". */
export function traitsTriggerLabel(
  descriptors: readonly ModelOptionDescriptor[],
  selections: readonly ModelOptionSelection[] | undefined,
  prompt: string,
): string {
  const { primarySelectDescriptor, ultrathinkPromptControlled } = selectedTraits(
    descriptors,
    prompt,
  );
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = currentOptionValue(descriptor, selections) === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    const label =
      ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${currentOptionValue(descriptor, selections) === true ? "On" : "Off"}`
          : currentOptionLabel(descriptor, selections);
    if (typeof label === "string" && label.length > 0) {
      if (
        reasoningLabelIndex === -1 &&
        descriptor.type === "select" &&
        REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id)
      ) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }
  if (labels.length === 0 && fastModeFallbackLabel !== null) return fastModeFallbackLabel;
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return labels.join(" · ");
}

const STORAGE_KEY = "jhin.composer.model-options.v1";

/**
 * The options last chosen for each model on this device (T3's
 * `stickyOptionsByModelByProvider`), so a new thread or a model picked again starts
 * with them.
 */
export function createModelOptionsMemory(storage: Storage = localStorage) {
  let remembered: Record<string, ModelOptionSelection[]> = {};
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      remembered = Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, ModelOptionSelection[]] =>
            Array.isArray(entry[1]) &&
            entry[1].every(
              (item: unknown) =>
                typeof item === "object" &&
                item !== null &&
                typeof (item as ModelOptionSelection).id === "string" &&
                ["string", "boolean"].includes(typeof (item as ModelOptionSelection).value),
            ),
        ),
      );
    }
  } catch {
    remembered = {};
  }
  const key = (agentId: string, model: string) => `${agentId}|${model}`;
  return {
    get: (agentId: string, model: string): readonly ModelOptionSelection[] | undefined =>
      remembered[key(agentId, model)],
    set(agentId: string, model: string, options: readonly ModelOptionSelection[]) {
      remembered = { ...remembered, [key(agentId, model)]: [...options] };
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(remembered));
      } catch {
        // Not kept beyond this page.
      }
    },
  };
}

export type ModelOptionsMemory = ReturnType<typeof createModelOptionsMemory>;
