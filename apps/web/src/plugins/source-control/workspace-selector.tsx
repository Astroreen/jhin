// The workspace menu of the branch toolbar follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/BranchToolbar.tsx and BranchToolbar.logic.ts (the menu and its
// labels) and PreviousWorktreeItemContent.tsx. A chunk of its own with the toolbar (D440).
import type { NodeTarget, ProjectRecord, ThreadRecord } from "@jhin/client-api";
import type { ProjectStatus } from "@jhin/source-control-api";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  HistoryIcon,
} from "lucide-react";

import { ComposerControl } from "../../lib/composer-control.tsx";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import { useSourceControl, type SourceControlServices } from "./services.ts";
import {
  draftKey,
  previousWorktree,
  useDraftWorkspace,
  type DraftWorkspace,
  type DraftWorkspaces,
} from "./workspace.tsx";

const LOCAL: DraftWorkspace = { mode: "local", startFromOrigin: false };

// T3's BranchToolbar.logic labels.
const currentWorkspaceLabel = (worktree: string | undefined) =>
  worktree ? "Current worktree" : "Current checkout";
const lockedWorkspaceLabel = (worktree: string | undefined) =>
  worktree ? "Worktree" : "Local checkout";

function PreviousWorktreeItemContent({ branch }: { branch: string | null }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <HistoryIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span>Previous worktree</span>
        {branch ? (
          <span className="min-w-0 text-xs text-muted-foreground">
            <MiddleTruncate value={branch} />
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * T3's workspace menu in the branch toolbar (D253): where a draft's thread will
 * work. A thread already started shows where it works, fixed.
 */
export function WorkspaceSelector(props: {
  services: SourceControlServices;
  drafts: DraftWorkspaces;
  target: NodeTarget;
  project: ProjectRecord;
  thread: ThreadRecord | undefined;
  status: ProjectStatus;
  threads: readonly ThreadRecord[];
}) {
  const { drafts, target, project, thread, status } = props;
  const view = useSourceControl(props.services.store, target);
  const key = draftKey(target, project.id);
  const draft = useDraftWorkspace(drafts, key);
  if (thread !== undefined) {
    const label = lockedWorkspaceLabel(thread.worktreePath);
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={`Workspace: ${label}`}
              className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
              data-composer-context-item
              role="img"
            />
          }
        >
          {thread.worktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <span className="truncate">{label}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  }
  const previous = previousWorktree(
    props.threads,
    project.id,
    (threadId) => view.threads.get(threadId)?.branch,
  );
  const label =
    draft.mode === "worktree"
      ? "New worktree"
      : draft.mode === "previous"
        ? "Previous worktree"
        : currentWorkspaceLabel(undefined);
  const choose = (value: string) => {
    if (value === "worktree") {
      drafts.set(key, {
        mode: "worktree",
        startFromOrigin: draft.startFromOrigin,
        ...(status.branch === null ? {} : { baseRef: draft.baseRef ?? status.branch }),
      });
    } else if (value === "previous" && previous !== undefined) {
      drafts.set(key, { mode: "previous", startFromOrigin: false, previous });
    } else drafts.set(key, LOCAL);
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Workspace"
              className="min-w-0 shrink active:scale-100"
              data-composer-context-item
              render={<ComposerControl size="xs" />}
            />
          }
        >
          {draft.mode === "local" ? (
            <FolderIcon className="size-3 shrink-0 opacity-70" />
          ) : draft.mode === "previous" ? (
            <FolderGitIcon className="size-3 shrink-0 opacity-70" />
          ) : (
            <FolderGit2Icon className="size-3 shrink-0 opacity-70" />
          )}
          <span className="min-w-0 truncate" data-composer-control-label>
            {label}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        className={previous === undefined ? undefined : "w-[min(21rem,calc(100vw-2rem))]"}
        side="top"
      >
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup onValueChange={(value) => choose(String(value))} value={draft.mode}>
            <MenuRadioItem closeOnClick value="local">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderIcon className="size-3" />
                <MiddleTruncate value={currentWorkspaceLabel(undefined)} />
              </span>
            </MenuRadioItem>
            <MenuRadioItem closeOnClick value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">New worktree</span>
              </span>
            </MenuRadioItem>
            {previous === undefined ? null : (
              <MenuRadioItem closeOnClick value="previous">
                <PreviousWorktreeItemContent branch={previous.branch} />
              </MenuRadioItem>
            )}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
