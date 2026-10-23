// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/chat/composerSlashCommandSearch.ts, apps/web/src/providerSkillSearch.ts,
// packages/shared/src/inlineSkills.ts (formatProviderSkillDisplayName),
// packages/shared/src/composerPullRequestMatches.ts (filterComposerPullRequestMatches),
// apps/web/src/components/pullRequest/pullRequestList.logic.ts (scorePullRequestMatch,
// rankPullRequestMatches), packages/client-runtime/src/composerThreadItems.ts
// (matchComposerThreadItems) and the menu items of apps/web/src/components/chat/ChatComposer.tsx
// (the built-in commands, files and folders, pull requests and their empty states).
import {
  type AgentSkill,
  type AgentSlashCommand,
  formatContextReference,
  type MessageContextRecord,
} from "@jhin/agent-api";
import type { ThreadRecord } from "@jhin/client-api";
import type { PullRequest } from "@jhin/source-control-api";

import { pullRequestContextRecord, threadContextRecord } from "./composer-context.ts";
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
    }
  | {
      readonly type: "pull-request";
      readonly id: string;
      readonly pullRequest: Pick<
        PullRequest,
        "number" | "title" | "url" | "headBranch" | "baseBranch" | "state" | "isDraft"
      >;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly type: "thread";
      readonly id: string;
      readonly threadId: string;
      /** Its `jhin://<nodeId>/threads/<id>` address, which the prompt links to. */
      readonly address: string;
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
  if (item.type === "path" || item.type === "pull-request" || item.type === "thread") return null;
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
  /** T3's "Show skills in slash menu" (D845); off, a command named like a skill shows again. */
  readonly showSkills: boolean;
  readonly query: string;
  readonly atPromptStart: boolean;
  readonly promptOtherwiseEmpty: boolean;
}): ComposerMenuItem[] {
  const skills = !input.showSkills ? [] : dedupeSkills(input.skills);
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

/** At most this many pull requests in the `#` menu (T3's COMPOSER_PULL_REQUEST_RESULT_LIMIT). */
const PULL_REQUEST_RESULT_LIMIT = 12;
/** At most this many threads at the top of the `@` menu (T3's COMPOSER_THREAD_RESULT_LIMIT). */
const THREAD_RESULT_LIMIT = 5;

type ListedPullRequest = Pick<
  PullRequest,
  "number" | "title" | "url" | "headBranch" | "baseBranch" | "state" | "isDraft" | "updatedAt"
>;

/** T3's scorePullRequestMatch, without the author and repository a listed entry lacks here. */
function scorePullRequestMatch(entry: ListedPullRequest, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;
  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if (terms.some((term) => title.includes(term))) return 30;
  return 10;
}

const updatedAtOf = (entry: ListedPullRequest) => entry.updatedAt ?? "";

/**
 * The `#` menu (T3's ChatComposer): a number (or a lone `#`) lists the pull requests whose
 * number holds it, the exact one first, then the thread's linked ones, then the most recently
 * updated; words rank what the forge found for them. Every forge that lists pull requests here
 * searches on its host (T3's `searchesOnHost`), so its answers are not filtered again.
 */
export function pullRequestMenuItems(input: {
  /** The repository's pull requests, as `git.pr.search` lists them. */
  readonly entries: readonly ListedPullRequest[];
  /** The one a number names, looked up when the list lacks it. */
  readonly exact?: ListedPullRequest | undefined;
  /** The pull requests linked to the thread. */
  readonly linked?: readonly ListedPullRequest[];
  readonly query: string;
}): ComposerMenuItem[] {
  const { query } = input;
  let matches: ListedPullRequest[];
  if (/^\d*$/u.test(query)) {
    const keyOf = (entry: ListedPullRequest) => entry.url.trim().toLowerCase();
    const linked = (input.linked ?? []).filter((entry) => String(entry.number).includes(query));
    const linkedKeys = new Set(linked.map(keyOf));
    const unique = new Map<string, ListedPullRequest>();
    const listed = [...(input.exact === undefined ? [] : [input.exact]), ...input.entries];
    for (const candidate of [
      ...listed.filter((entry) => String(entry.number).includes(query)),
      ...linked,
    ]) {
      if (!unique.has(keyOf(candidate))) unique.set(keyOf(candidate), candidate);
    }
    const isExact = (entry: ListedPullRequest) => String(entry.number) === query;
    const isLinked = (entry: ListedPullRequest) => linkedKeys.has(keyOf(entry));
    matches = [...unique.values()]
      .toSorted(
        (left, right) =>
          Number(isExact(right)) - Number(isExact(left)) ||
          Number(isLinked(right)) - Number(isLinked(left)) ||
          updatedAtOf(right).localeCompare(updatedAtOf(left)),
      )
      .slice(0, PULL_REQUEST_RESULT_LIMIT);
  } else {
    matches = input.entries
      .toSorted((left, right) => {
        const byScore = scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query);
        return byScore !== 0 ? byScore : updatedAtOf(right).localeCompare(updatedAtOf(left));
      })
      .slice(0, PULL_REQUEST_RESULT_LIMIT);
  }
  return matches.map((pullRequest) => ({
    type: "pull-request",
    id: `pull-request:${pullRequest.url}`,
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
    },
    label: `#${pullRequest.number}`,
    description: pullRequest.title,
  }));
}

/** Why the `#` menu shows no pull requests, in T3's words. */
export function pullRequestEmptyState(input: {
  readonly status: "unavailable" | "error" | "ready";
  readonly query: string;
}): string {
  if (input.status === "unavailable") return "Pull requests are not available for this project.";
  if (input.status === "error") return "Pull requests could not be read for this project.";
  return input.query
    ? `No pull request matches ${input.query}.`
    : "No pull requests found in this repository.";
}

/**
 * T3's matchComposerThreadItems: the `@` menu's first rows are up to five other threads of the
 * composer's node whose title holds the query, most recently changed first. The agent can only
 * read threads on its own node, so no other node's are offered; archived ones are not either.
 */
export function threadMenuItems(input: {
  readonly threads: readonly ThreadRecord[];
  readonly excludeThreadId: string | undefined;
  readonly query: string;
  /** The thread's address, or `undefined` while the node's id is not known. */
  addressOf(threadId: string): string | undefined;
}): ComposerMenuItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const items: ComposerMenuItem[] = [];
  for (const thread of input.threads
    .filter(
      (candidate) =>
        candidate.id !== input.excludeThreadId &&
        candidate.archivedAt === undefined &&
        candidate.title.toLowerCase().includes(query),
    )
    .toSorted((left, right) =>
      (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
    )) {
    if (items.length === THREAD_RESULT_LIMIT) break;
    const address = input.addressOf(thread.id);
    if (address === undefined) continue;
    items.push({
      type: "thread",
      id: `thread:${thread.id}`,
      threadId: thread.id,
      address,
      label: thread.title,
      description: "Thread",
    });
  }
  return items;
}

/**
 * The context record a pick puts beside the prompt (D1006): a pull request's or a thread's,
 * which its reference link names.
 */
export function menuContextRecord(item: ComposerMenuItem): MessageContextRecord | undefined {
  if (item.type === "pull-request") return pullRequestContextRecord(item.pullRequest);
  if (item.type !== "thread") return undefined;
  const nodeId = /^jhin:\/\/([^/]+)\/threads\//.exec(item.address)?.[1];
  if (nodeId === undefined) return undefined;
  return threadContextRecord({ nodeId, threadId: item.threadId, title: item.label });
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
    case "pull-request":
    case "thread": {
      const record = menuContextRecord(item);
      return record === undefined ? undefined : `${formatContextReference(record)} `;
    }
    case "slash-command":
      // Built-ins act instead of inserting: the token goes.
      return undefined;
  }
}

/** The element id of a menu item, T3's `composerSuggestionOptionId` (D1348). */
export function composerSuggestionOptionId(listId: string, itemId: string): string {
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}
