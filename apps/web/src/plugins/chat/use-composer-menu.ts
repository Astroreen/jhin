// The composer's `/`, `$` and `@` menus follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ChatComposer.tsx at eb7b35ac (the trigger at the caret, the
// items it offers, arrow keys that wrap, Enter or Tab picking, Escape dismissing) and
// apps/web/src/state/queries.ts (path searches 120 ms after typing, up to 80 results).
import type { AgentSkill, AgentSlashCommand } from "@jhin/agent-api";
import { useEffect, useRef, useState } from "react";

import {
  pathItem,
  searchSkills,
  skillItem,
  slashMenuItems,
  type ComposerMenuItem,
} from "../../lib/composer-menu.ts";
import { detectComposerTrigger, type ComposerTrigger } from "../../lib/composer-trigger.ts";
import type { NodeCall } from "../../lib/uploads.ts";

const PATH_SEARCH_DEBOUNCE_MS = 120;
const PATH_SEARCH_LIMIT = 80;
/** Commands and skills are asked of the node again after this (T3's snapshot TTL). */
const COMMANDS_TTL_MS = 5 * 60 * 1000;

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
  /** No menu while the composer answers a question or an approval. */
  readonly enabled: boolean;
}) {
  const { call, projectId, agentId, prompt, cursor } = options;
  const detected = options.enabled ? detectComposerTrigger(prompt, cursor) : null;
  // Escape dismisses the trigger being typed until another one starts.
  const [dismissed, setDismissed] = useState<number | undefined>();
  const trigger: ComposerTrigger | null =
    detected !== null && detected.rangeStart !== dismissed ? detected : null;

  const [offered, setOffered] = useState<{ key: string; at: number; value: Offered }>();
  const offeredKey = `${projectId}|${agentId}`;
  const loading = useRef<string | undefined>(undefined);
  const needsCommands = trigger !== null && trigger.kind !== "path" && projectId !== undefined;
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
        () => setOffered({ key: offeredKey, at: Date.now(), value: { commands: [], skills: [] } }),
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

  const commandsReady = offered !== undefined && offered.key === offeredKey;
  const value = commandsReady ? offered.value : { commands: [], skills: [] };
  let items: ComposerMenuItem[] = [];
  let isLoading = false;
  if (trigger?.kind === "slash-command") {
    const before = prompt.slice(0, trigger.rangeStart);
    const after = prompt.slice(trigger.rangeEnd);
    items = slashMenuItems({
      planMode: options.planMode,
      commands: value.commands,
      skills: value.skills,
      query: trigger.query,
      atPromptStart: before.trim() === "",
      promptOtherwiseEmpty: before.trim() === "" && after.trim() === "",
    });
    isLoading = !commandsReady && projectId !== undefined;
  } else if (trigger?.kind === "skill") {
    items = searchSkills(value.skills, trigger.query).map((skill) => skillItem(skill, "skill"));
    isLoading = !commandsReady && projectId !== undefined;
  } else if (trigger?.kind === "path") {
    items = paths?.query === trigger.query ? paths.items : [];
    isLoading = paths?.query !== trigger.query && projectId !== undefined;
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
