// Derived from T3 Code (https://github.com/pingdotgg/t3code) at eb7b35ac:
// apps/server/src/provider/ClaudeProvider.ts (parseClaudeInitializationCommands, the
// /compact command it adds), apps/server/src/provider/Drivers/ClaudeSkills.ts (skills read
// from SKILL.md files) and ClaudeSkillDispatch.ts (how a `$skill` reaches Claude Code).
import * as Fs from "node:fs";
import * as Path from "node:path";

import { skillMentionPattern, type AgentSkill, type AgentSlashCommand } from "@jhin/agent-api";

/** T3's COMPACT_SLASH_COMMAND: Claude Code compacts, but its initialization does not list it. */
export const COMPACT_SLASH_COMMAND: AgentSlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Claude Code's `initializationResult().commands`, deduplicated by name (case-insensitive). */
export function parseInitializationCommands(commands: readonly unknown[] | undefined) {
  const byName = new Map<string, AgentSlashCommand>();
  for (const raw of commands ?? []) {
    const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = text(record["name"]);
    if (name === undefined) continue;
    const description = text(record["description"]);
    const hint = text(record["argumentHint"]);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, {
        name,
        ...(description === undefined ? {} : { description }),
        ...(hint === undefined ? {} : { input: { hint } }),
      });
      continue;
    }
    byName.set(key, {
      ...existing,
      ...(existing.description === undefined && description !== undefined ? { description } : {}),
      ...(existing.input === undefined && hint !== undefined ? { input: { hint } } : {}),
    });
  }
  return [...byName.values()];
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The few keys of a SKILL.md frontmatter T3 reads: `description` (a plain, quoted or block
 * scalar), `disable-model-invocation` and `user-invocable`. Undefined when it has none.
 */
export function parseSkillFrontmatter(
  contents: string,
): { description?: string; userInvocable?: false } | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) return undefined;
  const lines = (match[1] ?? "").split(/\r?\n/);
  const values = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = /^([\w-]+):[ \t]*(.*)$/.exec(lines[index]!);
    if (line === null) continue;
    let value = line[2]!.replace(/[ \t]+#.*$/, "").trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      // A block scalar: the indented lines that follow.
      const block: string[] = [];
      while (index + 1 < lines.length && /^([ \t]+|$)/.test(lines[index + 1]!)) {
        index += 1;
        block.push(lines[index]!.trim());
      }
      value = block.join(value.startsWith("|") ? "\n" : " ").trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    values.set(line[1]!, value);
  }
  const description = text(values.get("description"));
  return {
    ...(description === undefined ? {} : { description }),
    ...(values.get("user-invocable") === "false" ? { userInvocable: false as const } : {}),
  };
}

/**
 * Skills as Claude Code names them: by their folder (not the frontmatter's `name`, T3
 * checked the CLI), user skills under Claude's config directory first, then the
 * project's `.claude/skills`. Skills the user cannot invoke are left out.
 */
export async function discoverSkills(configDir: string, cwd: string): Promise<AgentSkill[]> {
  const roots = [
    { directory: Path.join(configDir, "skills"), scope: "user" },
    { directory: Path.join(cwd, ".claude", "skills"), scope: "project" },
  ];
  const skills = new Map<string, AgentSkill>();
  for (const root of roots) {
    const entries = await Fs.promises.readdir(root.directory).catch(() => [] as string[]);
    for (const entry of entries.toSorted()) {
      const name = entry.trim();
      if (name === "" || skills.has(name)) continue;
      const path = Path.join(root.directory, entry, "SKILL.md");
      const contents = await Fs.promises.readFile(path, "utf8").catch(() => undefined);
      if (contents === undefined) continue;
      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter?.userInvocable === false) continue;
      skills.set(name, {
        name,
        path,
        scope: root.scope,
        ...(frontmatter?.description === undefined ? {} : { description: frontmatter.description }),
      });
    }
  }
  return [...skills.values()];
}

/**
 * Claude Code expands `/name args` only when it starts a text block, and only one skill
 * per message: the last `$skill` becomes the last block's `/name` with the text after it
 * as its arguments, and earlier ones become inline `/x` (T3's planClaudeSkillDispatch).
 * Undefined when the prompt names no known skill.
 */
export function planSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): { leadingText?: string; commandText: string; skillName: string } | undefined {
  const mentions = [...prompt.matchAll(skillMentionPattern())].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (last === undefined) return undefined;
  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) =>
        `${text.slice(0, mention.start)}/${mention.name}${text.slice(mention.end)}`,
      leading,
    )
    .trimEnd();
  return {
    ...(leadingWithInlineSlashes.length > 0 ? { leadingText: leadingWithInlineSlashes } : {}),
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}
