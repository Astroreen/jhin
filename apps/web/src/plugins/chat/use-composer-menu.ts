// The composer's `/`, `#`, `$` and `@` menus follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ChatComposer.tsx at eb7b35ac (the trigger at the caret, the
// items it offers, arrow keys that wrap, Enter or Tab picking, Escape dismissing; pull requests
// listed up to 99 and searched or looked up by number 180 ms after typing, other threads first
// in `@`) and apps/web/src/state/queries.ts (path searches 120 ms after typing, up to 80 results).
import type { AgentSkill, AgentSlashCommand } from "@jhin/agent-api";
import type { ThreadRecord } from "@jhin/client-api";
import type { PullRequest, ThreadPullRequest } from "@jhin/source-control-api";
import { useEffect, useRef, useState } from "react";

import {
  pathItem,
  pullRequestEmptyState,
  pullRequestMenuItems,
  searchSkills,
  skillItem,
  slashMenuItems,
  threadMenuItems,
  type ComposerMenuItem,
} from "../../lib/composer-menu.ts";
import { detectComposerTrigger, type ComposerTrigger } from "../../lib/composer-trigger.ts";
import type { NodeCall } from "../../lib/uploads.ts";

const PATH_SEARCH_DEBOUNCE_MS = 120;
const PATH_SEARCH_LIMIT = 80;
/** T3's pause before a `#` query is searched or its number looked up. */
const PULL_REQUEST_DEBOUNCE_MS = 180;
/** T3's COMPOSER_PULL_REQUEST_LIST_LIMIT. */
const PULL_REQUEST_LIST_LIMIT = 99;
/**
 * Errors that mean the project has no pull requests to offer: no repository, no forge that
 * lists them, or a node without the source-control plugin.
 */
const PULL_REQUESTS_UNAVAILABLE = new Set([
  "ACTION_UNAVAILABLE",
  "NOT_A_REPOSITORY",
  "PROJECT_NOT_FOUND",
  // The kernel's code for a command no plugin registered.
  "COMMAND_NOT_FOUND",
]);

const errorCode = (error: unknown) => String((error as { code?: unknown } | null)?.code);

interface PullRequestList {
  readonly key: string;
  readonly status: "ready" | "unavailable" | "error";
  readonly entries: readonly PullRequest[];
}
/** Commands and skills are asked of the node again after this (T3's snapshot TTL). */
const COMMANDS_TTL_MS = 5 * 60 * 1000;
/** A `#` list is read from the forge again after this; a new `#` within it reuses the last. */
const PULL_REQUEST_LIST_TTL_MS = 60 * 1000;

interface Offered {
  readonly commands: readonly AgentSlashCommand[];
  readonly skills: readonly AgentSkill[];
}

export function useComposerMenu(options: {
  readonly call: NodeCall;
  /** The project the composer sends to: commands, skills and files are its. */
  readonly projectId: string | undefined;
  readonly agentId: string | undefined;
  readonly prompt: string;
  readonly cursor: number;
  readonly planMode: boolean;
  /** T3's "Show skills in slash menu" (D845). */
  readonly showSkillsInSlashMenu: boolean;
  /** No menu while the composer answers a question or an approval. */
  readonly enabled: boolean;
  /** The composer's thread: not offered in `@`, and its linked pull requests come first in `#`. */
  readonly threadId?: string | undefined;
  /** The threads of the composer's node, offered in `@`. */
  readonly threads?: readonly ThreadRecord[];
  /** A thread's `jhin://` address; `undefined` while the node's id is not known. */
  readonly threadAddress?: (threadId: string) => string | undefined;
}) {
  const { call, projectId, agentId, prompt, cursor, threadId } = options;
  const detected = options.enabled ? detectComposerTrigger(prompt, cursor) : null;
  // Escape dismisses the trigger being typed until another one starts.
  const [dismissed, setDismissed] = useState<number | undefined>();
  const trigger: ComposerTrigger | null =
    detected !== null && detected.rangeStart !== dismissed ? detected : null;

  const [offered, setOffered] = useState<{ key: string; at: number; value: Offered }>();
  const offeredKey = `${projectId}|${agentId}`;
  const loading = useRef<string | undefined>(undefined);
  const needsCommands =
    trigger !== null &&
    (trigger.kind === "slash-command" || trigger.kind === "skill") &&
    projectId !== undefined;
  useEffect(() => {
    if (!needsCommands) return;
    const fresh =
      offered !== undefined &&
      offered.key === offeredKey &&
      Date.now() - offered.at < COMMANDS_TTL_MS;
    if (fresh || loading.current === offeredKey) return;
    loading.current = offeredKey;
    void call<Offered>("agents.commands", {
      projectId,
      ...(agentId === undefined ? {} : { agentId }),
    })
      .then(
        (value) => setOffered({ key: offeredKey, at: Date.now(), value }),
        // A failure is not kept: the next trigger asks again.
        () => undefined,
      )
      .finally(() => {
        if (loading.current === offeredKey) loading.current = undefined;
      });
  }, [needsCommands, offeredKey]);

  const pathQuery = trigger?.kind === "path" ? trigger.query : undefined;
  const [paths, setPaths] = useState<{ query: string; items: ComposerMenuItem[] }>();
  useEffect(() => {
    if (pathQuery === undefined || projectId === undefined) return;
    let current = true;
    const timer = setTimeout(() => {
      void call<{ entries: { path: string; kind: "file" | "directory" }[] }>(
        "projects.search-entries",
        { projectId, query: pathQuery, limit: PATH_SEARCH_LIMIT },
      ).then(
        (found) => {
          if (current) {
            setPaths({
              query: pathQuery,
              items: found.entries.map((entry) => pathItem(entry.path, entry.kind)),
            });
          }
        },
        () => {
          if (current) setPaths({ query: pathQuery, items: [] });
        },
      );
    }, PATH_SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [pathQuery, projectId]);

  // `#`: the repository's pull requests, kept per query for a while as T3's query cache keeps
  // them; words are searched on the forge once typing pauses, a number is looked up when the
  // list lacks it.
  const prTrigger = trigger?.kind === "pull-request" ? trigger : undefined;
  const prQuery = prTrigger?.query ?? "";
  const prTextQuery = prQuery.length > 0 && !/^\d+$/u.test(prQuery) ? prQuery : "";
  const prListKey = prTrigger === undefined ? undefined : `${projectId}|${prTextQuery}`;
  const [prList, setPrList] = useState<PullRequestList>();
  const prListCache = useRef(new Map<string, { at: number; list: PullRequestList }>());
  useEffect(() => {
    if (prListKey === undefined || projectId === undefined) return;
    const cached = prListCache.current.get(prListKey);
    if (cached !== undefined && Date.now() - cached.at < PULL_REQUEST_LIST_TTL_MS) {
      setPrList(cached.list);
      return;
    }
    let current = true;
    const read = () =>
      void call<{ pullRequests: PullRequest[] }>("git.pr.search", {
        projectId,
        limit: PULL_REQUEST_LIST_LIMIT,
        ...(prTextQuery === "" ? {} : { query: prTextQuery }),
      }).then(
        (found) => {
          if (!current) return;
          const list = { key: prListKey, status: "ready" as const, entries: found.pullRequests };
          prListCache.current.set(prListKey, { at: Date.now(), list });
          setPrList(list);
        },
        (error: unknown) => {
          if (!current) return;
          const status = PULL_REQUESTS_UNAVAILABLE.has(errorCode(error)) ? "unavailable" : "error";
          setPrList({ key: prListKey, status, entries: [] });
        },
      );
    if (prTextQuery === "") {
      read();
      return () => {
        current = false;
      };
    }
    const timer = setTimeout(read, PULL_REQUEST_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [prListKey]);
  const prListReady = prList !== undefined && prList.key === prListKey;

  const prNumber = /^\d+$/u.test(prQuery) && Number(prQuery) > 0 ? Number(prQuery) : undefined;
  const listedHasNumber = prListReady && prList.entries.some((entry) => entry.number === prNumber);
  const exactKey =
    prTrigger === undefined ||
    prNumber === undefined ||
    !prListReady ||
    prList.status !== "ready" ||
    listedHasNumber
      ? undefined
      : `${projectId}|${prTrigger.rangeStart}|${prNumber}`;
  const [exact, setExact] = useState<{ key: string; pullRequest: PullRequest | null }>();
  useEffect(() => {
    if (exactKey === undefined || projectId === undefined || prNumber === undefined) return;
    let current = true;
    const timer = setTimeout(() => {
      void call<{ pullRequest: PullRequest }>("git.pr.resolve", {
        projectId,
        reference: String(prNumber),
      }).then(
        (found) => {
          if (current) setExact({ key: exactKey, pullRequest: found.pullRequest });
        },
        () => {
          if (current) setExact({ key: exactKey, pullRequest: null });
        },
      );
    }, PULL_REQUEST_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [exactKey]);
  const exactReady = exactKey === undefined || exact?.key === exactKey;

  const linkedKey =
    prTrigger === undefined || threadId === undefined
      ? undefined
      : `${threadId}|${prTrigger.rangeStart}`;
  const [linked, setLinked] = useState<{ key: string; entries: readonly PullRequest[] }>();
  useEffect(() => {
    if (linkedKey === undefined || threadId === undefined) return;
    let current = true;
    void call<{ pullRequests: ThreadPullRequest[] }>("git.pr.list", { threadId }).then(
      (found) => {
        if (!current) return;
        setLinked({
          key: linkedKey,
          entries: found.pullRequests.flatMap((link) =>
            link.snapshot === null ? [] : [{ ...link.snapshot, url: link.url }],
          ),
        });
      },
      () => {
        if (current) setLinked({ key: linkedKey, entries: [] });
      },
    );
    return () => {
      current = false;
    };
  }, [linkedKey]);

  const commandsReady = offered !== undefined && offered.key === offeredKey;
  const value = commandsReady ? offered.value : { commands: [], skills: [] };
  let items: ComposerMenuItem[] = [];
  let isLoading = false;
  let emptyState: string | undefined;
  if (trigger?.kind === "slash-command") {
    const before = prompt.slice(0, trigger.rangeStart);
    const after = prompt.slice(trigger.rangeEnd);
    items = slashMenuItems({
      planMode: options.planMode,
      commands: value.commands,
      skills: value.skills,
      showSkills: options.showSkillsInSlashMenu,
      query: trigger.query,
      atPromptStart: before.trim() === "",
      promptOtherwiseEmpty: before.trim() === "" && after.trim() === "",
    });
    isLoading = !commandsReady && projectId !== undefined;
  } else if (trigger?.kind === "skill") {
    items = searchSkills(value.skills, trigger.query).map((skill) => skillItem(skill, "skill"));
    isLoading = !commandsReady && projectId !== undefined;
  } else if (trigger?.kind === "path") {
    items = [
      ...threadMenuItems({
        threads: options.threads ?? [],
        excludeThreadId: threadId,
        query: trigger.query,
        addressOf: (id) => options.threadAddress?.(id),
      }),
      ...(paths?.query === trigger.query ? paths.items : []),
    ];
    isLoading = paths?.query !== trigger.query && projectId !== undefined;
  } else if (trigger?.kind === "pull-request") {
    const status = projectId === undefined ? "unavailable" : prListReady ? prList.status : "ready";
    items =
      status === "ready" && prListReady
        ? pullRequestMenuItems({
            entries: prList.entries,
            exact: exact?.key === exactKey ? (exact?.pullRequest ?? undefined) : undefined,
            linked: linked !== undefined && linked.key === linkedKey ? linked.entries : [],
            query: trigger.query,
          })
        : [];
    isLoading = projectId !== undefined && (!prListReady || !exactReady);
    emptyState = pullRequestEmptyState({ status, query: trigger.query });
  }

  const [activeId, setActiveId] = useState<string | null>(null);
  const active = items.find((item) => item.id === activeId) ?? items[0];
  // A new list highlights its first row again.
  const listKey = `${trigger?.kind}|${trigger?.rangeStart}|${items.map((item) => item.id).join(",")}`;
  useEffect(() => setActiveId(null), [listKey]);

  return {
    trigger,
    items,
    isLoading,
    /** What the menu says when it has no rows and is not loading; T3's own words otherwise. */
    emptyState,
    activeId: active?.id ?? null,
    setActiveId,
    /**
     * The menu's keys (T3's onComposerCommandKey): true when the key was the
     * menu's, and `pick` got the row Enter or Tab chose.
     */
    onKeyDown(event: KeyboardEvent, pick: (item: ComposerMenuItem) => void): boolean {
      if (trigger === null) return false;
      if (event.key === "Escape") {
        setDismissed(trigger.rangeStart);
        return true;
      }
      if (items.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const index = items.findIndex((item) => item.id === active?.id);
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
        setActiveId(items[next]!.id);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        if (active !== undefined) pick(active);
        return true;
      }
      return false;
    },
  };
}
