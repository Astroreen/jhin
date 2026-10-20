// The indicators follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/Sidebar.tsx (the card's branch row and its diff count, and
// SidebarThreadTooltip's branch lines) and ThreadStatusIndicators.tsx
// (ThreadPullRequestBadgeControl, PullRequestBadge and the mini list item its tooltip shows).
import type { ThreadIndicatorProps } from "@jhin/client-api";
import type { PullRequest } from "@jhin/source-control-api";
import { InlineButton, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import { CircleAlertIcon, GitBranchIcon } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";

import { ComposerControl } from "../../lib/composer-control.tsx";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import {
  formatDiffCount,
  prStatusIndicator,
  pullRequestChecksPresentation,
} from "../../lib/pull-request.ts";
import { useSourceControl, type SourceControlServices } from "./services.ts";

/** Opens a pull request in a new tab without the click reaching the row around it. */
const openPullRequest = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

/**
 * A pull request's state icon and number, linking to it; the tooltip names it
 * and its checks. `card` is T3's sidebar badge (an inline link), `toolbar` the
 * branch toolbar's (a composer control).
 */
export function PullRequestBadge({
  pr,
  variant,
}: {
  pr: PullRequest;
  variant: "card" | "toolbar";
}) {
  const status = prStatusIndicator(pr)!;
  const checks = pullRequestChecksPresentation(pr.checks);
  const anchor: ReactElement = <a href={pr.url} rel="noopener noreferrer" target="_blank" />;
  const label = checks === null ? status.tooltip : `${status.tooltip}. ${checks.label}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          variant === "card" ? (
            <InlineButton
              aria-label={label}
              data-pull-request={pr.state}
              onClick={openPullRequest}
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              render={anchor}
            />
          ) : (
            <ComposerControl
              aria-label={label}
              data-composer-context-item
              data-pull-request={pr.state}
              render={anchor}
              size="xs"
            />
          )
        }
      >
        <span className={cn("contents font-normal text-xs tabular-nums", status.colorClass)}>
          <status.Icon aria-hidden className="size-3 shrink-0" />
          <span>{pr.number}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup
        className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
        side="top"
        sideOffset={0}
        variant="glass"
      >
        <div className="-mx-1 flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1">
            <status.Icon aria-hidden className={cn("size-3 shrink-0", status.colorClass)} />
            <span className="shrink-0 font-mono tabular-nums">#{pr.number}</span>
            <span className="min-w-0 truncate text-foreground/75">{pr.title}</span>
          </div>
          {checks === null ? null : (
            <div className="flex min-w-0 items-center gap-2 px-1 pb-1 text-muted-foreground">
              <checks.Icon aria-hidden className={cn("size-3 shrink-0", checks.toneClassName)} />
              <span className="min-w-0 truncate">{checks.label}</span>
              <span className="ml-auto shrink-0 tabular-nums">
                {pr.checks.passed}/{pr.checks.total}
              </span>
            </div>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The card's indicators: the thread's branch, its pull request and the uncommitted diff. */
export function createCardIndicators(services: SourceControlServices) {
  const { store } = services;

  function Branch({ target, thread }: ThreadIndicatorProps) {
    const view = useSourceControl(store, target);
    const branch = view.threads.get(thread.id)?.branch;
    if (branch === undefined || branch === null) return null;
    return (
      <span
        aria-label={`Branch ${branch}`}
        className="flex min-w-0 flex-1 text-muted-foreground/40"
        data-thread-branch
        role="img"
      >
        <MiddleTruncate showTitle={false} value={branch} />
      </span>
    );
  }

  function PullRequestIndicator({ target, thread }: ThreadIndicatorProps) {
    const view = useSourceControl(store, target);
    const recorded = view.threads.get(thread.id);
    if (recorded?.branch === undefined || recorded.branch === null) return null;
    const pr = view.projects.get(recorded.projectId)?.pullRequests[recorded.branch];
    return pr ? <PullRequestBadge pr={pr} variant="card" /> : null;
  }

  /**
   * T3's diff count (`+12 −3`): here the uncommitted changes of the thread's
   * project while the thread's branch is the one checked out (per-turn diffs
   * need checkpoints, docs/plans/source-control.md).
   */
  function DiffCount({ target, thread }: ThreadIndicatorProps) {
    const view = useSourceControl(store, target);
    const status = view.projects.get(thread.projectId);
    const branch = view.threads.get(thread.id)?.branch;
    if (status === undefined || !status.isRepo || branch == null || branch !== status.branch) {
      return null;
    }
    const { insertions, deletions } = status.workingTree;
    if (insertions === 0 && deletions === 0) return null;
    return (
      <span
        aria-label={`${insertions} additions, ${deletions} deletions`}
        className="shrink-0 font-mono"
        data-thread-diff
        role="img"
      >
        <span className="text-diff-addition-foreground">+{formatDiffCount(insertions)}</span>{" "}
        <span className="text-diff-deletion-foreground">−{formatDiffCount(deletions)}</span>
      </span>
    );
  }

  /** The hover card's branch line (T3's SidebarThreadTooltip, GitBranchIcon). */
  function BranchDetail({ target, thread }: ThreadIndicatorProps) {
    const view = useSourceControl(store, target);
    const branch = view.threads.get(thread.id)?.branch;
    if (branch === undefined || branch === null) return null;
    return (
      <div className="flex min-w-0 items-center gap-2" data-thread-branch-detail>
        <GitBranchIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
        <MiddleTruncate className="flex text-foreground/75" value={branch} />
      </div>
    );
  }

  /**
   * T3's warning under it (resolveLocalCheckoutBranchMismatch): the project has
   * another branch checked out than the thread's. Threads have no worktree of
   * their own yet, so every thread works in the project's checkout.
   */
  function BranchMismatch({ target, thread }: ThreadIndicatorProps) {
    const view = useSourceControl(store, target);
    const branch = view.threads.get(thread.id)?.branch;
    const current = view.projects.get(thread.projectId);
    if (branch == null || current?.isRepo !== true || current.branch == null) return null;
    if (current.branch === branch) return null;
    return (
      <div className="flex min-w-0 items-start gap-2 text-warning" data-thread-branch-mismatch>
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
        <div className="min-w-0 flex-1 wrap-break-word leading-5">
          You're currently checked out on another branch.
        </div>
      </div>
    );
  }

  return { Branch, PullRequestIndicator, DiffCount, BranchDetail, BranchMismatch };
}
