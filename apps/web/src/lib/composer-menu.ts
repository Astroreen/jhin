// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/chat/composerSlashCommandSearch.ts, apps/web/src/providerSkillSearch.ts,
// packages/shared/src/inlineSkills.ts (formatProviderSkillDisplayName) and the menu items of
// apps/web/src/components/chat/ChatComposer.tsx (the built-in commands, files and folders).
import type { AgentSkill, AgentSlashCommand } from "@jhin/agent-api";

import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "./search-ranking.ts";

/** One row of the composer's `/`, `$` or `@` menu (T3's ComposerCommandItem). */
export type ComposerMenuItem =
  | {
      readonly type: "slash-command";
      readonly id: string;
      readonly command: "model" | "plan" | "default";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly type: "provider-slash-command";
      readonly id: string;
      readonly command: AgentSlashCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly type: "skill";
      readonly id: string;
      readonly skill: AgentSkill;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly type: "path";
      readonly id: string;
      readonly path: string;
      readonly pathKind: "file" | "directory";
      readonly label: string;
      readonly description: string;
    };

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function skillDisplayName(skill: Pick<AgentSkill, "name" | "displayName">): string {
  const displayName = skill.displayName?.trim();
  return displayName ? displayName : titleCaseWords(skill.name);
}

/** T3's built-ins: `/model` always, `/plan` and `/default` when the agent has plan mode. */
function builtInCommands(planMode: boolean): ComposerMenuItem[] {
  return [
    {
      type: "slash-command",
      id: "slash:model",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    },
    ...(planMode
      ? ([
          {
            type: "slash-command",
            id: "slash:plan",
            command: "plan",
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
          {
            type: "slash-command",
            id: "slash:default",
            command: "default",
            label: "/default",
            description: "Switch this thread back to normal build mode",
          },
        ] as const)
      : []),
  ];
}

function providerCommandItem(command: AgentSlashCommand): ComposerMenuItem {
  return {
    type: "provider-slash-command",
    id: `provider:${command.name}`,
    command,
    label: `/${command.name}`,
    description: command.description ?? command.input?.hint ?? "Run provider command",
  };
}

export function skillItem(skill: AgentSkill, menu: "slash" | "skill"): ComposerMenuItem {
  return {
    type: "skill",
    id: `skill:${skill.name}`,
    skill,
    label: menu === "slash" ? `/skill:${skill.name}` : skillDisplayName(skill),
    description: skill.description ?? "",
  };
}

/** A file or folder as T3 lists it: its name, and the folder it is in. */
export function pathItem(path: string, pathKind: "file" | "directory"): ComposerMenuItem {
  const slash = path.lastIndexOf("/");
  return {
    type: "path",
    id: `path:${pathKind}:${path}`,
    path,
    pathKind,
    label: slash === -1 ? path : path.slice(slash + 1),
    description: slash === -1 ? "" : path.slice(0, slash),
  };
}

function dedupeSkills(skills: readonly AgentSkill[]): AgentSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const name = skill.name.trim().toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function scoreSkill(skill: AgentSkill, query: string): number | null {
  const scores = [
    scoreQueryMatch({
      value: skill.name.toLowerCase(),
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: skillDisplayName(skill).toLowerCase(),
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 5,
      includesBase: 7,
      fuzzyBase: 110,
    }),
    scoreQueryMatch({
      value: skill.description?.toLowerCase() ?? "",
      query,
      exactBase: 30,
      prefixBase: 32,
      boundaryBase: 34,
      includesBase: 36,
    }),
    scoreQueryMatch({
      value: skill.scope?.toLowerCase() ?? "",
      query,
      exactBase: 40,
      prefixBase: 42,
      includesBase: 44,
    }),
  ].filter((score): score is number => score !== null);
  return scores.length === 0 ? null : Math.min(...scores);
}

/** T3's searchProviderSkills: the `$` menu. */
export function searchSkills(skills: readonly AgentSkill[], query: string): AgentSkill[] {
  const unique = dedupeSkills(skills);
  const normalized = normalizeSearchQuery(query, { trimLeadingPattern: /^\p{Sc}+/u });
  if (!normalized) return unique;
  const ranked: { item: AgentSkill; score: number; tieBreaker: string }[] = [];
  for (const skill of unique) {
    const score = scoreSkill(skill, normalized);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      {
        item: skill,
        score,
        tieBreaker: `${skillDisplayName(skill).toLowerCase()}\u0000${skill.name}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }
  return ranked.map((entry) => entry.item);
}

function scoreSlashItem(item: ComposerMenuItem, query: string): number | null {
  if (item.type === "path") return null;
  if (item.type === "skill") {
    if (query === "skill") return 0;
    const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
    const skillScore = skillQuery ? scoreSkill(item.skill, skillQuery) : 0;
    if (skillScore !== null) return skillScore;
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }
  const primary = (item.type === "slash-command" ? item.command : item.command.name).toLowerCase();
  const scores = [
    scoreQueryMatch({
      value: primary,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: item.description.toLowerCase(),
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);
  return scores.length === 0 ? null : Math.min(...scores);
}

/**
 * The `/` menu (T3's composerSlashCommandSearch): built-ins, then the runtime's
 * commands (only at the start of the prompt, the one place the agent runs them;
 * `/compact` only in an otherwise empty composer), then skills, ranked by the query.
 */
export function slashMenuItems(input: {
  readonly planMode: boolean;
  readonly commands: readonly AgentSlashCommand[];
  readonly skills: readonly AgentSkill[];
  readonly query: string;
  readonly atPromptStart: boolean;
  readonly promptOtherwiseEmpty: boolean;
}): ComposerMenuItem[] {
  const skills = dedupeSkills(input.skills);
  const skillNames = new Set(skills.map((skill) => skill.name.toLowerCase()));
  const items: ComposerMenuItem[] = [
    ...builtInCommands(input.planMode),
    ...(input.atPromptStart
      ? input.commands
          .filter((command) => !skillNames.has(command.name.toLowerCase()))
          .filter((command) => command.name !== "compact" || input.promptOtherwiseEmpty)
          .map(providerCommandItem)
      : []),
    ...skills.map((skill) => skillItem(skill, "slash")),
  ];
  const normalized = normalizeSearchQuery(input.query, { trimLeadingPattern: /^\/+/ });
  if (!normalized) return items;
  const ranked: { item: ComposerMenuItem; score: number; tieBreaker: string }[] = [];
  for (const item of items) {
    const score = scoreSlashItem(item, normalized);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker:
          item.type === "slash-command"
            ? `0\u0000${item.command}`
            : item.type === "provider-slash-command"
              ? `1\u0000${item.command.name}`
              : item.type === "skill"
                ? `2\u0000${item.skill.name}`
                : `3\u0000${item.id}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }
  return ranked.map((entry) => entry.item);
}

/** The text a pick puts in place of the typed trigger (T3: `/name `, `$name `, a file link). */
export function menuInsertion(
  item: ComposerMenuItem,
  serializeFileLink: (path: string) => string,
): string | undefined {
  switch (item.type) {
    case "provider-slash-command":
      return `/${item.command.name} `;
    case "skill":
      return `$${item.skill.name} `;
    case "path":
      return `${serializeFileLink(item.path)} `;
    case "slash-command":
      // Built-ins act instead of inserting: the token goes.
      return undefined;
  }
}
