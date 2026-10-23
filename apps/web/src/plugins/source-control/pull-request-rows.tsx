// The pull request rows of the thread details panel follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ThreadDetailsPrRows.tsx (the current
// one, the others behind "Show N more") and ThreadDetailsPrRow.tsx (a row, its tooltip and
// its "Stop watching"). A chunk of its own, loaded with the panel (D440).
// docs/plans/source-control.md, D1283.
import type { ChatThreadDetailsProps } from "@jhin/client-api";
import type { PullRequest, ThreadPullRequest } from "@jhin/source-control-api";
import { ThreadDetailsSection, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import {
  EyeIcon,
  EyeOffIcon,
  GitBranchIcon,
  GitPullRequestArrowIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import {
  currentPullRequest,
  pullRequestChecksPresentation,
  pullRequestListLines,
  resolvePullRequestState,
} from "../../lib/pull-request.ts";
import {
  ROW,
  ROW_CONTENT,
  SPLIT_GROUP,
  SPLIT_PRIMARY,
  SPLIT_SECONDARY,
  SPLIT_SEPARATOR,
} from "../../lib/thread-details-styles.ts";
import { useSourceControl, type SourceControlServices } from "./services.ts";

/** Only a web page is opened: a forge's answer is no reason to run anything else. */
const openUrl = (url: string) => {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
};

/** T3's row tooltip: the title and number, the state, base ← head, the checks while open. */
function RowTooltip({ pr }: { pr: PullRequest }) {
  const state = resolvePullRequestState(pr);
  const checks = pr.state === "open" ? pullRequestChecksPresentation(pr.checks) : null;
  return (
    <TooltipPopup
      align="start"
      className="max-w-80 text-left whitespace-normal"
      side="top"
      sideOffset={4}
      variant="glass"
    >
      <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
        <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-none">
          <span className="min-w-0 truncate font-medium text-foreground">{pr.title}</span>
          <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <state.Icon aria-hidden className={cn("size-3 shrink-0", state.toneClassName)} />
            <div className="min-w-0 truncate text-foreground/75">{state.label}</div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              {pr.baseBranch} ← {pr.headBranch}
            </div>
          </div>
          {checks === null ? null : (
            <div className="flex min-w-0 items-center gap-2">
              <checks.Icon aria-hidden className={cn("size-3 shrink-0", checks.toneClassName)} />
              <div className="min-w-0 truncate text-foreground/75">
                {checks.label} ({pr.checks.passed}/{pr.checks.total})
              </div>
            </div>
          )}
        </div>
      </div>
    </TooltipPopup>
  );
}

/** One pull request: its state icon and "#N: title", opening it; a watched one can stop. */
function PullRequestRow({
  number,
  url,
  pr,
  onStopWatching,
}: {
  number: number;
  url: string;
  /** What the forge last said; `null` until it was read. */
  pr: PullRequest | null;
  onStopWatching: (() => void) | undefined;
}) {
  const state = pr === null ? null : resolvePullRequestState(pr);
  const icon =
    state === null ? (
      <GitPullRequestArrowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    ) : (
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
    );
  const label = `#${number}${pr === null ? "" : `: ${pr.title}`}`;
  const openRow = (className: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={url}
            className={className}
            onClick={() => openUrl(url)}
            type="button"
          />
        }
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </TooltipTrigger>
      {pr === null ? (
        <TooltipPopup side="top">{`Pull request #${number}`}</TooltipPopup>
      ) : (
        <RowTooltip pr={pr} />
      )}
    </Tooltip>
  );
  const watching = onStopWatching !== undefined && (pr?.state ?? "open") === "open";
  if (!watching) return openRow(ROW);
  return (
    <div className={SPLIT_GROUP}>
      {openRow(SPLIT_PRIMARY)}
      <span aria-hidden="true" className={SPLIT_SEPARATOR} />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`Stop watching #${number}`}
              className={cn(SPLIT_SECONDARY, "group/watch")}
              onClick={onStopWatching}
              type="button"
            />
          }
        >
          <EyeIcon aria-hidden className="size-4 group-hover/watch:hidden" />
          <EyeOffIcon aria-hidden className="hidden size-4 group-hover/watch:block" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          Watching: the agent wakes when checks finish, someone comments, or the branch conflicts.
          Click to stop.
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The rows themselves: the current pull request, then the others behind "Show N more". */
export function PullRequestRows({
  links,
  branchPullRequest,
  onStopWatching,
}: {
  links: readonly ThreadPullRequest[];
  /** The branch's pull request, shown when nothing is linked. */
  branchPullRequest: PullRequest | null;
  onStopWatching: (link: ThreadPullRequest) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const current = currentPullRequest(links);
  const stop = (link: ThreadPullRequest) =>
    link.watch === undefined ? undefined : () => onStopWatching(link);
  if (current === undefined) {
    if (branchPullRequest === null) return null;
    return (
      <PullRequestRow
        number={branchPullRequest.number}
        onStopWatching={undefined}
        pr={branchPullRequest}
        url={branchPullRequest.url}
      />
    );
  }
  const row = (link: ThreadPullRequest) => (
    <PullRequestRow
      key={link.key}
      number={link.number}
      onStopWatching={stop(link)}
      pr={link.snapshot}
      url={link.url}
    />
  );
  const rest = pullRequestListLines(links)
    .map((line) => line.link)
    .filter((link) => link.key !== current.key);
  return (
    <>
      {row(current)}
      {expanded ? rest.map(row) : null}
      {rest.length === 0 ? null : (
        <button
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${ROW_CONTENT} text-[13px] font-medium text-muted-foreground/70 hover:bg-black/[0.035] hover:text-foreground/80 dark:hover:bg-white/[0.08]`}
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? (
            <MinusIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <PlusIcon aria-hidden className="size-4 shrink-0" />
          )}
          {expanded ? "Show less" : `Show ${rest.length} more`}
        </button>
      )}
    </>
  );
}

/** The section of `chat.thread.details` (D1283). */
export function createPullRequestRows(services: SourceControlServices) {
  const { store, threads, toasts } = services;
  return function ThreadPullRequestRows({ target, thread }: ChatThreadDetailsProps) {
    const view = useSourceControl(store, target);
    const links = view.links.get(thread.id) ?? [];
    const branch = view.threads.get(thread.id)?.branch;
    const branchPullRequest =
      branch == null ? null : (view.projects.get(thread.projectId)?.pullRequests[branch] ?? null);
    if (links.length === 0 && branchPullRequest === null) return null;
    const stopWatching = (link: ThreadPullRequest) =>
      void threads
        .call(target, "git.pr.unwatch", { threadId: thread.id, url: link.url })
        .catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Could not change the watch",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
    return (
      <ThreadDetailsSection
        headingId="thread-details-version-control-heading"
        showHeading={false}
        title="Version Control"
      >
        <div className="flex flex-col">
          <PullRequestRows
            branchPullRequest={branchPullRequest}
            links={links}
            onStopWatching={stopWatching}
          />
        </div>
      </ThreadDetailsSection>
    );
  };
}
