// The pull request rows of the thread details panel follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ThreadDetailsPrRows.tsx (the current
// one, the others behind "Show N more") and ThreadDetailsPrRow.tsx (a row, its tooltip with the
// files count, its "Stop watching", its second line with the checks and one action: Merge,
// Ready, Fix or Resolve, and the Merge dialog), with the hand-offs of
// pullRequest/usePullRequestActions.ts. A chunk of its own, loaded with the panel (D440).
// docs/plans/source-control.md, D1283, D1456, D1457.
import type { ChatThreadDetailsProps, NodeTarget } from "@jhin/client-api";
import type {
  PreparedPullRequest,
  PullRequest,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  ThreadPullRequest,
} from "@jhin/source-control-api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  Button,
  ThreadDetailsSection,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  ArrowUpRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitPullRequestArrowIcon,
  MinusIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ACTION_FAILURE_HINTS,
  ACTION_FAILURE_LABELS,
  ACTION_SUCCESS_LABELS,
  buildFixChecksPrompt,
  buildResolveConflictsPrompt,
  classifyPullRequestChecks,
  describePullRequestChecks,
  isPullRequestConflicting,
  pullRequestChecksState,
  readableFailure,
  resolveSelectedMergeMethod,
  resolveThreadPanelPullRequestAction,
} from "../../lib/pull-request-detail.ts";
import {
  currentPullRequest,
  pullRequestChecksPresentation,
  pullRequestListLines,
  resolvePullRequestState,
  webPageUrl,
  WATCHING_DESCRIPTION,
} from "../../lib/pull-request.ts";
import {
  ICON_ACTION,
  META_ACTION,
  ROW,
  ROW_CONTENT,
  SPLIT_GROUP,
  SPLIT_PRIMARY,
  SPLIT_SECONDARY,
  SPLIT_SEPARATOR,
} from "../../lib/thread-details-styles.ts";
import {
  PullRequestCheckStatusIcon,
  PullRequestChecksPopover,
  PullRequestDiffStat,
} from "./pull-request-presentation.tsx";
import { useSourceControl, type SourceControlServices } from "./services.ts";
import { draftKey, type DraftWorkspaces } from "./workspace.tsx";

const openUrl = (url: string) => {
  const page = webPageUrl(url);
  if (page !== undefined) window.open(page, "_blank", "noopener,noreferrer");
};

/** What a row reads and does through the node: absent where nothing can be acted on. */
export interface RowAccess {
  detail(url: string): Promise<PullRequestDetail>;
  act(url: string, action: PullRequestAction, method?: PullRequestMergeMethod): Promise<void>;
  /** T3's hand-off: the pull request checked out in a worktree and a new thread's draft with `prompt`. */
  handoff(url: string, prompt: string): Promise<void>;
}

/**
 * T3's row tooltip: the title and number, the state, base ← head, the checks while open, a
 * draft's conflict and the files count with the diff stat once the detail is read.
 */
function RowTooltip({ pr, detail }: { pr: PullRequest; detail: PullRequestDetail | null }) {
  const state = resolvePullRequestState(pr);
  const checks = detail?.checks;
  const checksState = checks === undefined ? "none" : classifyPullRequestChecks(checks);
  const rollup = pr.state === "open" ? pullRequestChecksPresentation(pr.checks) : null;
  const conflicting = pr.isDraft && isPullRequestConflicting(detail);
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
          {pr.state !== "open" ? null : checks !== undefined ? (
            checksState === "none" ? null : (
              <div className="flex min-w-0 items-center gap-2">
                <PullRequestCheckStatusIcon
                  status={
                    checksState === "failing"
                      ? "failure"
                      : checksState === "pending"
                        ? "pending"
                        : "success"
                  }
                />
                <div className="min-w-0 truncate text-foreground/75">
                  {describePullRequestChecks(checks)}
                </div>
              </div>
            )
          ) : rollup === null ? null : (
            <div className="flex min-w-0 items-center gap-2">
              <rollup.Icon aria-hidden className={cn("size-3 shrink-0", rollup.toneClassName)} />
              <div className="min-w-0 truncate text-foreground/75">
                {rollup.label} ({pr.checks.passed}/{pr.checks.total})
              </div>
            </div>
          )}
          {conflicting ? (
            <div className="flex min-w-0 items-start gap-2 text-destructive">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                Merge conflicts with {pr.baseBranch}
              </div>
            </div>
          ) : null}
          {pr.changedFiles === undefined ? null : (
            <div className="flex min-w-0 items-center gap-2">
              <FileDiffIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="flex min-w-0 items-baseline gap-1 truncate text-foreground/75">
                {pr.changedFiles.toLocaleString()} {pr.changedFiles === 1 ? "file" : "files"}
                <PullRequestDiffStat additions={pr.additions ?? 0} deletions={pr.deletions ?? 0} />
              </div>
            </div>
          )}
        </div>
      </div>
    </TooltipPopup>
  );
}

/** What changes in a snapshot that makes the detail worth reading again. */
const detailKey = (pr: PullRequest | null) =>
  pr === null
    ? ""
    : [
        pr.state,
        pr.isDraft,
        pr.headSha ?? "",
        pr.mergeability ?? "",
        pr.checks.passed,
        pr.checks.failed,
        pr.checks.pending,
        pr.checks.total,
        pr.updatedAt ?? "",
      ].join("|");

/** T3's ThreadDetailsPrRow: the row, and while it is open, its checks and one action. */
function PullRequestRow({
  number,
  url,
  pr,
  access,
  onStopWatching,
}: {
  number: number;
  url: string;
  /** What the forge last said; `null` until it was read. */
  pr: PullRequest | null;
  access: RowAccess | undefined;
  onStopWatching: (() => void) | undefined;
}) {
  const [read, setDetail] = useState<PullRequestDetail | null>(null);
  // A snapshot that left "open" (merged, closed elsewhere) outranks a detail read before.
  const detail = pr !== null && pr.state !== "open" ? null : read;
  const [reads, setReads] = useState(0);
  const [pending, setPending] = useState<"action" | "handoff" | null>(null);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const busy = useRef(false);
  const isOpen = (detail?.pullRequest.state ?? pr?.state) === "open";
  const key = detailKey(pr);
  // Read while open, again when the snapshot moves and after an action (T3's refreshes).
  useEffect(() => {
    if (access === undefined || pr === null || pr.state !== "open") return;
    let live = true;
    access.detail(url).then(
      (answer) => {
        if (live) setDetail(answer);
      },
      // Unread, the row offers no action rather than one from an older read.
      () => {
        if (live) setDetail(null);
      },
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the snapshot
  }, [access, url, key, reads]);

  const shown = detail?.pullRequest ?? pr;
  const state = shown === null ? null : resolvePullRequestState(shown);
  const icon =
    state === null ? (
      <GitPullRequestArrowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    ) : (
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
    );
  const label = `#${number}${shown === null ? "" : `: ${shown.title}`}`;
  const openRow = (text: string, className: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-description={url}
            className={className}
            onClick={() => openUrl(url)}
            type="button"
          />
        }
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{text}</span>
      </TooltipTrigger>
      {shown === null ? (
        <TooltipPopup side="top">{`Pull request #${number}`}</TooltipPopup>
      ) : (
        <RowTooltip detail={detail} pr={shown} />
      )}
    </Tooltip>
  );

  const rowAction = isOpen ? resolveThreadPanelPullRequestAction(detail) : null;
  if (confirmingMerge && rowAction !== "merge") setConfirmingMerge(false);
  const conflicting = isPullRequestConflicting(detail);
  const checksRollup = detail === null ? null : pullRequestChecksState(detail.checks);
  const method = resolveSelectedMergeMethod(detail?.mergeMethods ?? []);

  const perform = async (action: PullRequestAction, mergeMethod?: PullRequestMergeMethod) => {
    if (access === undefined || busy.current) return;
    busy.current = true;
    setPending("action");
    try {
      await access.act(url, action, mergeMethod);
      setReads((count) => count + 1);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  const handoff = async (prompt: string) => {
    if (access === undefined || busy.current) return;
    busy.current = true;
    setPending("handoff");
    try {
      await access.handoff(url, prompt);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  const trailing =
    detail === null || rowAction === null
      ? null
      : rowAction === "resolve"
        ? {
            label: "Resolve",
            pendingLabel: "Preparing...",
            pending: pending === "handoff",
            destructive: true,
            suffix: true,
            tooltip: "Check the branch out and resolve the conflicts in a new thread",
            onClick: () => void handoff(buildResolveConflictsPrompt(detail.pullRequest)),
          }
        : rowAction === "ready"
          ? {
              label: "Ready",
              pendingLabel: "Marking...",
              pending: pending === "action",
              destructive: false,
              suffix: false,
              tooltip: "Mark this pull request as ready for review",
              onClick: () => void perform("ready"),
            }
          : rowAction === "fix"
            ? {
                label: "Fix",
                pendingLabel: "Preparing...",
                pending: pending === "handoff",
                destructive: true,
                suffix: true,
                tooltip: "Fix the failing checks in a new thread",
                onClick: () =>
                  void handoff(buildFixChecksPrompt(detail.pullRequest, detail.checks)),
              }
            : {
                label: "Merge",
                pendingLabel: "Merging...",
                pending: pending === "action",
                destructive: false,
                suffix: false,
                tooltip: `Merge this pull request (${method})`,
                onClick: () => setConfirmingMerge(true),
              };

  const watching = onStopWatching !== undefined && (shown?.state ?? "open") === "open";
  const watchControl = (className: string, small: boolean) =>
    watching ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`Stop watching #${number}`}
              className={cn(className, "group/watch")}
              onClick={onStopWatching}
              type="button"
            />
          }
        >
          <EyeIcon
            aria-hidden
            className={cn(small ? "size-3.5" : "size-4", "group-hover/watch:hidden")}
          />
          <EyeOffIcon
            aria-hidden
            className={cn(small ? "size-3.5" : "size-4", "hidden group-hover/watch:block")}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{`${WATCHING_DESCRIPTION}. Click to stop.`}</TooltipPopup>
      </Tooltip>
    ) : null;

  const showChecks =
    detail !== null && checksRollup !== null && !conflicting && !detail.pullRequest.isDraft;
  const body =
    detail !== null && isOpen && (showChecks || trailing !== null || watching) ? (
      <div className="pb-2">
        {openRow(detail.pullRequest.title, ROW)}
        <div className="-mt-1 flex h-6 min-w-0 items-center gap-0.5 ps-9 pe-1 text-xs text-muted-foreground">
          <span className="me-1 shrink-0 tabular-nums">#{number}</span>
          {showChecks && checksRollup !== null ? (
            <PullRequestChecksPopover
              checks={detail.checks}
              checksState={checksRollup}
              openUrl={openUrl}
              render={<button className={META_ACTION} type="button" />}
              variant="count"
            />
          ) : null}
          {watchControl(ICON_ACTION, true)}
          <span className="flex-1" />
          {trailing === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    className={cn(
                      META_ACTION,
                      trailing.destructive
                        ? "text-destructive hover:text-destructive"
                        : "text-primary hover:text-primary",
                    )}
                    disabled={pending !== null}
                    onClick={trailing.onClick}
                    type="button"
                  />
                }
              >
                {trailing.pending ? trailing.pendingLabel : trailing.label}
                {trailing.suffix ? (
                  <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="top">{trailing.tooltip}</TooltipPopup>
            </Tooltip>
          )}
        </div>
      </div>
    ) : watching ? (
      <div className={SPLIT_GROUP}>
        {openRow(label, SPLIT_PRIMARY)}
        <span aria-hidden="true" className={SPLIT_SEPARATOR} />
        {watchControl(SPLIT_SECONDARY, false)}
      </div>
    ) : (
      openRow(label, ROW)
    );
  return (
    <>
      {body}
      {rowAction === "merge" ? (
        <AlertDialog
          onOpenChange={(next: boolean) => setConfirmingMerge(next)}
          open={confirmingMerge}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
              <AlertDialogDescription>
                This merges #{number} using {method}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button size="sm" variant="outline" />}>
                Cancel
              </AlertDialogClose>
              <Button
                disabled={pending !== null}
                onClick={() => {
                  setConfirmingMerge(false);
                  void perform("merge", method);
                }}
                size="sm"
              >
                Merge
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </>
  );
}

/** The rows themselves: the current pull request, then the others behind "Show N more". */
export function PullRequestRows({
  links,
  branchPullRequest,
  access,
  onStopWatching,
}: {
  links: readonly ThreadPullRequest[];
  /** The branch's pull request, shown when nothing is linked. */
  branchPullRequest: PullRequest | null;
  access?: RowAccess | undefined;
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
        access={access}
        number={branchPullRequest.number}
        onStopWatching={undefined}
        pr={branchPullRequest}
        url={branchPullRequest.url}
      />
    );
  }
  const row = (link: ThreadPullRequest) => (
    <PullRequestRow
      access={access}
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

/**
 * What the rows of one thread do through its node: `git.pr.detail`, `git.pr.action` with T3's
 * toasts, and T3's hand-off (a worktree checkout, the draft on it, the task in its composer).
 */
export function rowAccess(
  services: SourceControlServices,
  drafts: DraftWorkspaces,
  target: NodeTarget,
  projectId: string,
): RowAccess {
  const { threads, toasts, context } = services;
  return {
    detail: (url) => threads.call<PullRequestDetail>(target, "git.pr.detail", { projectId, url }),
    act: async (url, action, mergeMethod) => {
      try {
        await threads.call(target, "git.pr.action", {
          projectId,
          url,
          action,
          ...(mergeMethod === undefined ? {} : { mergeMethod }),
        });
        toasts?.show({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
      } catch (error) {
        toasts?.show({
          type: "error",
          title: ACTION_FAILURE_LABELS[action],
          description: readableFailure(error, ACTION_FAILURE_HINTS[action]),
        });
      }
    },
    handoff: async (url, prompt) => {
      // A loading toast never expires; the outcome replaces it.
      const id = toasts?.show({
        type: "loading",
        title: "Preparing the pull request checkout...",
        timeout: 0,
      });
      const settle = (toast: Parameters<NonNullable<typeof toasts>["show"]>[0]) =>
        id === undefined ? toasts?.show(toast) : toasts?.update(id, { timeout: 5_000, ...toast });
      let prepared: PreparedPullRequest;
      try {
        prepared = await threads.call<PreparedPullRequest>(target, "git.pr.checkout", {
          projectId,
          reference: url,
          mode: "worktree",
        });
      } catch (error) {
        settle({
          type: "error",
          title: "Could not prepare the pull request checkout",
          description: error instanceof Error ? error.message : undefined,
        });
        return;
      }
      const written = await context.commands
        .execute("chat.draft.write", {
          node: target.node,
          ...(target.remote === undefined ? {} : { remote: target.remote }),
          projectId,
          prompt,
        })
        .then(
          () => true,
          () => false,
        );
      // Once the task is in it, the draft's thread starts in that worktree (D252's existing
      // worktree), as T3 points it.
      if (written && prepared.worktreePath !== null) {
        drafts.set(draftKey(target, projectId), {
          mode: "previous",
          startFromOrigin: false,
          previous: { path: prepared.worktreePath, branch: prepared.branch },
        });
      }
      if (!written) {
        settle({
          type: "error",
          title: "Checked out, but the thread stayed where it was",
          description: `The checkout is ready on \`${prepared.branch}\`. Point a thread at it from the branch picker, then ask again.`,
        });
        return;
      }
      settle(
        prepared.isOnPullRequestHead
          ? {
              type: "success",
              title: "Checkout ready",
              description: "The task is in the composer — read it over, then send.",
            }
          : {
              type: "warning",
              title: "Checked out, but not on the latest commits",
              description:
                "The checkout could not be moved onto the pull request's latest commits, so the code there is older than the pull request. Uncommitted work or local commits keep it where it is.",
            },
      );
    },
  };
}

/** The section of `chat.thread.details` (D1283, D1456). */
export function createPullRequestRows(services: SourceControlServices, drafts: DraftWorkspaces) {
  const { store, threads, toasts } = services;
  return function ThreadPullRequestRows({ target, thread }: ChatThreadDetailsProps) {
    const view = useSourceControl(store, target);
    const links = view.links.get(thread.id) ?? [];
    const branch = view.threads.get(thread.id)?.branch;
    const branchPullRequest =
      branch == null ? null : (view.projects.get(thread.projectId)?.pullRequests[branch] ?? null);
    // One per project and node: a row's reads follow it, not every render.
    const access = useMemo(
      () => rowAccess(services, drafts, target, thread.projectId),
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- the target's parts are its identity
      [target.node, target.remote, thread.projectId],
    );
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
            access={access}
            branchPullRequest={branchPullRequest}
            links={links}
            onStopWatching={stopWatching}
          />
        </div>
      </ThreadDetailsSection>
    );
  };
}
