// The worktree icon, the draft's workspace and the worktree clean-up follow T3 Code (MIT,
// see THIRD_PARTY_NOTICES.md): ThreadStatusIndicators.tsx (ThreadWorktreeIndicator),
// BranchToolbar.logic.ts (resolvePreviousWorktreeSeed), apps/web/src/worktreeCleanup.ts and
// hooks/useThreadActions.ts (offering to delete a worktree only its thread used). The
// workspace menu itself is workspace-selector.tsx, loaded with the branch toolbar (D440).
import {
  THREAD_CREATE_HOOK,
  THREAD_DELETE_HOOK,
  targetKey,
  type NodeTarget,
  type ThreadCreateInput,
  type ThreadDeleteInput,
  type ThreadIndicatorProps,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { Tooltip, TooltipPopup, TooltipTrigger, type Dialogs, type Toasts } from "@jhin/ui";
import { FolderGit2Icon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useSourceControl, type SourceControlServices } from "./services.ts";

/** T3's EnvMode, and the previous worktree a draft can reuse. */
type WorkspaceMode = "local" | "worktree" | "previous";

/** What a draft's first message will create its thread in. */
export interface DraftWorkspace {
  readonly mode: WorkspaceMode;
  /** For a new worktree: the ref it starts from (the checked-out branch by default). */
  readonly baseRef?: string;
  readonly startFromOrigin: boolean;
  /** For `previous`: the worktree reused. */
  readonly previous?: { readonly path: string; readonly branch: string | null };
}

const LOCAL: DraftWorkspace = { mode: "local", startFromOrigin: false };

export interface DraftWorkspaces {
  get(key: string): DraftWorkspace;
  set(key: string, workspace: DraftWorkspace): void;
  subscribe(listener: () => void): () => void;
  /** The workspace menu on screen offers to be opened by T3's `composer.workspace` (D906). */
  offerMenu(open: () => void): () => void;
  /** Opens the workspace menu on screen; false when there is none (no draft shown). */
  openMenu(): boolean;
}

export function createDraftWorkspaces(): DraftWorkspaces {
  const drafts = new Map<string, DraftWorkspace>();
  const listeners = new Set<() => void>();
  // The last menu shown is the one opened.
  const menus: (() => void)[] = [];
  return {
    offerMenu(open) {
      menus.push(open);
      return () => {
        const index = menus.lastIndexOf(open);
        if (index !== -1) menus.splice(index, 1);
      };
    },
    openMenu() {
      const open = menus.at(-1);
      open?.();
      return open !== undefined;
    },
    get: (key) => drafts.get(key) ?? LOCAL,
    set(key, workspace) {
      if (workspace.mode === "local") drafts.delete(key);
      else drafts.set(key, workspace);
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const draftKey = (target: NodeTarget, projectId: string) =>
  `${targetKey(target)}|${projectId}`;

export function useDraftWorkspace(drafts: DraftWorkspaces, key: string): DraftWorkspace {
  return useSyncExternalStore(drafts.subscribe, () => drafts.get(key));
}

const basename = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;

/**
 * T3's previous-worktree seed: the most recently changed thread of the project,
 * not archived, that works in a worktree.
 */
export function previousWorktree(
  threads: readonly ThreadRecord[],
  projectId: string,
  branches: (threadId: string) => string | null | undefined,
): DraftWorkspace["previous"] | undefined {
  const seed = threads
    .filter(
      (thread) =>
        thread.projectId === projectId &&
        thread.archivedAt === undefined &&
        thread.worktreePath !== undefined,
    )
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))[0];
  if (seed?.worktreePath === undefined) return undefined;
  return { path: seed.worktreePath, branch: branches(seed.id) ?? null };
}

/**
 * `thread.create` (D252, D253): a draft's first message creates its thread in
 * the workspace chosen for it; the choice is used up.
 */
export function registerWorkspaceHook(context: PluginContext, drafts: DraftWorkspaces) {
  return context.hooks.before<ThreadCreateInput>(THREAD_CREATE_HOOK, (input) => {
    const key = draftKey(input.target, input.projectId);
    const draft = drafts.get(key);
    if (draft.mode === "local") return input;
    drafts.set(key, LOCAL);
    if (draft.mode === "previous" && draft.previous !== undefined) {
      return {
        ...input,
        params: {
          ...input.params,
          workspace: { type: "existing_worktree", worktreePath: draft.previous.path },
        },
      };
    }
    if (draft.mode !== "worktree" || draft.baseRef === undefined) return input;
    return {
      ...input,
      params: {
        ...input.params,
        workspace: {
          type: "worktree",
          baseRef: draft.baseRef,
          ...(draft.startFromOrigin ? { startFromOrigin: true } : {}),
        },
      },
    };
  });
}

/** T3's ThreadWorktreeIndicator on a worktree thread's card (D254). */
export function createWorktreeIndicator(services: SourceControlServices) {
  return function WorktreeIndicator({ target, thread }: ThreadIndicatorProps) {
    const view = useSourceControl(services.store, target);
    const path = thread.worktreePath;
    if (path === undefined) return null;
    const branch = view.threads.get(thread.id)?.branch;
    const label = branch
      ? `Worktree: ${basename(path)} (${branch})`
      : `Worktree: ${basename(path)}`;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={label}
              className="inline-flex shrink-0 text-muted-foreground/50"
              data-thread-worktree
              role="img"
            />
          }
        >
          <FolderGit2Icon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  };
}

/**
 * Around a thread's deletion (D255): when no other thread works in its
 * worktree, T3's question whether to delete the worktree too; the thread is
 * deleted first, then the worktree (with `force`).
 */
export function registerWorktreeCleanup(
  context: PluginContext,
  threads: ThreadsCatalog,
  dialogs: Dialogs | undefined,
  toasts: Toasts | undefined,
) {
  return context.hooks.around<ThreadDeleteInput, boolean>(
    THREAD_DELETE_HOOK,
    async (input, next) => {
      const { target, thread } = input;
      const path = thread.worktreePath?.trim();
      if (path === undefined || path === "" || dialogs === undefined) return next(input);
      // Only a worktree this node made, and that no other thread works in (the node's
      // own list, not this client's catalog); one made by hand is never offered.
      const listed = await threads
        .call<{ worktrees: { path: string; managed: boolean; threadIds: string[] }[] }>(
          target,
          "git.worktree.list",
          { projectId: thread.projectId },
        )
        .then((answer) => answer.worktrees.find((entry) => entry.path === path))
        .catch(() => undefined);
      const alone =
        listed !== undefined &&
        listed.managed &&
        listed.threadIds.every((threadId) => threadId === thread.id);
      if (!alone) return next(input);
      // Declining keeps the worktree; the thread is deleted either way.
      const removeToo = await dialogs.confirm({
        title: "Delete the worktree too?",
        description: `This thread is the only one linked to this worktree:\n${basename(path)}\n\nIts uncommitted changes are lost; its branch stays.`,
        confirmLabel: "Delete worktree",
        variant: "destructive",
      });
      const deleted = await next(input);
      if (!deleted || !removeToo) return deleted;
      try {
        await threads.call(target, "git.worktree.remove", {
          projectId: thread.projectId,
          path,
          force: true,
        });
      } catch (error) {
        toasts?.show({
          type: "error",
          title: "Failed to delete worktree",
          description: `Could not remove ${basename(path)}. ${(error as Error).message}`,
        });
      }
      return deleted;
    },
  );
}
