// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/provider/model-manifest.json at eb7b35ac: the "claudeAgent" profiles,
// their option descriptors (D297) and how Claude Code takes them (D298).
import type { ModelOptionDescriptor } from "@jhin/agent-api";

/** How Claude Code takes a profile's options: T3's `adapter.claudeCode`. */
interface ClaudeProfileRuntime {
  /** An effort value Claude Code knows under another name; `null`: no effort at all. */
  readonly effortMap?: Readonly<Record<string, string | null>>;
  /** Suffixes of the model id by option value, e.g. `contextWindow: { "1m": "[1m]" }`. */
  readonly modelSuffixes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly contextWindowTokens?: Readonly<Record<string, number>>;
  readonly fixedContextWindowTokens?: number;
}

export interface ClaudeProfile {
  readonly options: readonly ModelOptionDescriptor[];
  readonly runtime: ClaudeProfileRuntime;
}

export const CLAUDE_PROFILES: Readonly<Record<string, ClaudeProfile>> = {
  "fable-5": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
            isDefault: true,
          },
          {
            id: "high",
            label: "High",
          },
          {
            id: "xhigh",
            label: "Extra High",
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultracode",
            label: "Ultracode",
            description: "xhigh effort plus multi-agent workflow orchestration",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
    ],
    runtime: {
      effortMap: {
        ultracode: "xhigh",
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "opus-5-5": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
            isDefault: true,
          },
          {
            id: "high",
            label: "High",
          },
          {
            id: "xhigh",
            label: "Extra High",
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultracode",
            label: "Ultracode",
            description: "xhigh effort plus multi-agent workflow orchestration",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ],
    runtime: {
      effortMap: {
        ultracode: "xhigh",
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "opus-5": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
            isDefault: true,
          },
          {
            id: "xhigh",
            label: "Extra High",
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultracode",
            label: "Ultracode",
            description: "xhigh effort plus multi-agent workflow orchestration",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ],
    runtime: {
      effortMap: {
        ultracode: "xhigh",
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "opus-4-8": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
            isDefault: true,
          },
          {
            id: "xhigh",
            label: "Extra High",
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultracode",
            label: "Ultracode",
            description: "xhigh effort plus multi-agent workflow orchestration",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ],
    runtime: {
      effortMap: {
        ultracode: "xhigh",
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "opus-4-7": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
          },
          {
            id: "xhigh",
            label: "Extra High",
            isDefault: true,
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ],
    runtime: {
      effortMap: {
        xhigh: "max",
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "opus-4-6": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
            isDefault: true,
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          {
            id: "200k",
            label: "200k",
          },
          {
            id: "1m",
            label: "1M",
            isDefault: true,
          },
        ],
      },
    ],
    runtime: {
      effortMap: {
        ultrathink: null,
      },
      modelSuffixes: {
        contextWindow: {
          "1m": "[1m]",
        },
      },
      contextWindowTokens: {
        "200k": 200000,
        "1m": 1000000,
      },
    },
  },
  "opus-4-5": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
            isDefault: true,
          },
          {
            id: "max",
            label: "Max",
          },
        ],
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ],
    runtime: {
      fixedContextWindowTokens: 200000,
    },
  },
  "sonnet-5": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
            isDefault: true,
          },
          {
            id: "xhigh",
            label: "Extra High",
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
    ],
    runtime: {
      effortMap: {
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "sonnet-4-6": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
          },
          {
            id: "high",
            label: "High",
            isDefault: true,
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          {
            id: "200k",
            label: "200k",
            isDefault: true,
          },
          {
            id: "1m",
            label: "1M",
          },
        ],
      },
    ],
    runtime: {
      effortMap: {
        max: "high",
        ultrathink: null,
      },
      modelSuffixes: {
        contextWindow: {
          "1m": "[1m]",
        },
      },
      contextWindowTokens: {
        "200k": 200000,
        "1m": 1000000,
      },
    },
  },
  "haiku-5-5": {
    options: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "low",
            label: "Low",
          },
          {
            id: "medium",
            label: "Medium",
            isDefault: true,
          },
          {
            id: "high",
            label: "High",
          },
          {
            id: "xhigh",
            label: "Extra High",
          },
          {
            id: "max",
            label: "Max",
          },
          {
            id: "ultrathink",
            label: "Ultrathink",
          },
        ],
        promptInjectedValues: ["ultrathink"],
      },
    ],
    runtime: {
      effortMap: {
        ultrathink: null,
      },
      fixedContextWindowTokens: 1000000,
    },
  },
  "haiku-4-5": {
    options: [
      {
        id: "thinking",
        label: "Thinking",
        type: "boolean",
      },
    ],
    runtime: {
      fixedContextWindowTokens: 200000,
    },
  },
};

/** Every Claude model of the manifest, current and legacy, with its aliases and profile. */
export const CLAUDE_MODEL_PROFILES: readonly {
  readonly slug: string;
  readonly aliases: readonly string[];
  readonly profile: string;
}[] = [
  {
    slug: "claude-opus-5-5",
    aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
    profile: "opus-5-5",
  },
  {
    slug: "claude-sonnet-5-5",
    aliases: ["sonnet", "sonnet-5.5", "claude-sonnet-5.5"],
    profile: "sonnet-5",
  },
  {
    slug: "claude-fable-5-1",
    aliases: ["fable", "fable-5.1", "claude-fable-5.1"],
    profile: "fable-5",
  },
  {
    slug: "claude-fable-5",
    aliases: [],
    profile: "fable-5",
  },
  {
    slug: "claude-opus-5",
    aliases: ["opus-5", "claude-opus-5.0", "claude-opus-5-0"],
    profile: "opus-5",
  },
  {
    slug: "claude-opus-4-8",
    aliases: ["opus-4.8", "claude-opus-4.8"],
    profile: "opus-4-8",
  },
  {
    slug: "claude-opus-4-7",
    aliases: ["opus-4.7", "claude-opus-4.7"],
    profile: "opus-4-7",
  },
  {
    slug: "claude-opus-4-6",
    aliases: ["opus-4.6", "claude-opus-4.6", "claude-opus-4-6-20251117"],
    profile: "opus-4-6",
  },
  {
    slug: "claude-opus-4-5",
    aliases: [],
    profile: "opus-4-5",
  },
  {
    slug: "claude-sonnet-5",
    aliases: ["sonnet-5", "claude-sonnet-5.0", "claude-sonnet-5-0"],
    profile: "sonnet-5",
  },
  {
    slug: "claude-sonnet-4-6",
    aliases: ["sonnet-4.6", "claude-sonnet-4.6", "claude-sonnet-4-6-20251117"],
    profile: "sonnet-4-6",
  },
  {
    slug: "claude-haiku-5-5",
    aliases: ["haiku", "haiku-5.5", "claude-haiku-5.5"],
    profile: "haiku-5-5",
  },
  {
    slug: "claude-haiku-4-5",
    aliases: ["haiku-4.5", "claude-haiku-4.5", "claude-haiku-4-5-20251001"],
    profile: "haiku-4-5",
  },
];
