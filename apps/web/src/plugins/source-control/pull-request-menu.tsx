// A pull request's actions in a panel row's menu follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx (its
// header menu: the draft toggle, "Merge now", auto-merge, the merge methods, close, reopen,
// revert and "Delete branch" with its confirmation) and useInlineActionConfirm.ts (an item
// that asks "Confirm …?" before it acts). Jhin has no pull request page yet, so the menu goes
// where the row's is. docs/plans/source-control.md D1663, D1664.
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  ThreadPullRequest,
} from "@jhin/source-control-api";
import { parsePullRequestUrl } from "@jhin/source-control-api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  Button,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@jhin/ui";
import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestCreateArrowIcon,
  GitPullRequestDraftIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import {
  isPullRequestConflicting,
  lastSelectedMergeMethod,
  MERGE_METHOD_LABELS,
  rememberMergeMethod,
  resolvePullRequestMergeMethod,
} from "../../lib/pull-request-detail.ts";

/** T3's useInlineActionConfirm: the first click arms an item, the second acts. */
function useInlineActionConfirm(scopeKey: string) {
  const [armed, setArmed] = useState<{
    scopeKey: string;
    action: string;
    element: HTMLElement;
  } | null>(null);
  const active = armed?.scopeKey === scopeKey ? armed : null;
  useEffect(() => {
    if (!armed) return;
    const disarm = () => setArmed(null);
    if (armed.scopeKey !== scopeKey) {
      disarm();
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !armed.element.contains(event.target)) disarm();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") disarm();
    };
    const timeout = window.setTimeout(disarm, 3000);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarm);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarm);
    };
  }, [armed, scopeKey]);
  return {
    isArmed: (action: string) => active?.action === action,
    props: (action: string, onConfirm: () => void) => ({
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (active?.action === action && active.element === event.currentTarget) {
          setArmed(null);
          onConfirm();
        } else {
          setArmed({ scopeKey, action, element: event.currentTarget });
        }
      },
    }),
  };
}

export interface PullRequestMenuAccess {
  /** `git.pr.detail` of the row's pull request. */
  detail(link: ThreadPullRequest): Promise<PullRequestDetail>;
  /** `git.pr.action`, with its toasts. */
  act(
    link: ThreadPullRequest,
    action: PullRequestAction,
    mergeMethod?: PullRequestMergeMethod,
  ): Promise<void>;
}

/**
 * The menu items of T3's pull request menu for a row: those before the row's own items
 * (`leading`), those after them (`trailing`) and the "Delete branch" confirmation (`dialog`).
 * The detail is read each time the menu opens.
 */
export function usePullRequestMenuActions(
  link: ThreadPullRequest,
  menuOpen: boolean,
  access: PullRequestMenuAccess | undefined,
): { leading: ReactNode; trailing: ReactNode; dialog: ReactNode } {
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [chosen, setChosen] = useState<PullRequestMergeMethod | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirm = useInlineActionConfirm(link.key);
  useEffect(() => {
    if (!menuOpen || access === undefined) return;
    // An earlier read may no longer apply: the menu offers nothing until this one answers.
    setDetail(null);
    let live = true;
    void access.detail(link).then(
      (read) => {
        if (live) setDetail(read);
      },
      () => {
        // Unread, the menu keeps the row's own items alone.
        if (live) setDetail(null);
      },
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- read again on each opening
  }, [menuOpen, link.url, access]);
  if (access === undefined || detail === null || detail.pullRequest.url !== link.url) {
    return { leading: null, trailing: null, dialog: null };
  }
  const pr = detail.pullRequest;
  const can = (action: PullRequestAction) => detail.actions.includes(action);
  const allowed = detail.mergeMethods;
  const method =
    chosen !== null && allowed.includes(chosen)
      ? chosen
      : resolvePullRequestMergeMethod(
          allowed,
          detail.defaultMergeMethod,
          lastSelectedMergeMethod(),
        );
  const conflicting = isPullRequestConflicting(detail);
  const open = pr.state === "open";
  const mergeable = open && can("merge") && !pr.isDraft && !conflicting && allowed.length > 0;
  const armed = pr.autoMerge === true;
  const perform = async (action: PullRequestAction, mergeMethod?: PullRequestMergeMethod) => {
    if (pending) return;
    setPending(true);
    try {
      await access.act(link, action, mergeMethod);
    } finally {
      setPending(false);
    }
  };
  const showsDraftToggle = open && can(pr.isDraft ? "ready" : "draft");
  const showsDisable = open && armed && can("disable-auto-merge");
  const showsEnable = mergeable && !armed && can("enable-auto-merge");
  const showsMethods = mergeable && allowed.length > 1;
  const leading = open ? (
    <>
      {showsDraftToggle ? (
        <MenuItem disabled={pending} onClick={() => void perform(pr.isDraft ? "ready" : "draft")}>
          {pr.isDraft ? (
            <GitPullRequestArrowIcon className="size-3.5" />
          ) : (
            <GitPullRequestDraftIcon className="size-3.5" />
          )}
          {pr.isDraft ? "Ready for review" : "Convert to draft"}
        </MenuItem>
      ) : null}
      {mergeable ? (
        <MenuItem
          aria-label={confirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
          closeOnClick={confirm.isArmed("merge")}
          disabled={pending}
          {...confirm.props("merge", () => void perform("merge", method))}
        >
          <GitMergeIcon className="size-3.5" />
          {confirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
        </MenuItem>
      ) : null}
      {showsDisable ? (
        <MenuItem disabled={pending} onClick={() => void perform("disable-auto-merge")}>
          <GitMergeIcon className="size-3.5" />
          Disable auto-merge
        </MenuItem>
      ) : showsEnable ? (
        <MenuItem
          aria-label={
            confirm.isArmed("enable-auto-merge") ? "Confirm auto-merge?" : "Enable auto-merge"
          }
          closeOnClick={confirm.isArmed("enable-auto-merge")}
          disabled={pending}
          {...confirm.props("enable-auto-merge", () => void perform("enable-auto-merge", method))}
        >
          <GitMergeIcon className="size-3.5" />
          {confirm.isArmed("enable-auto-merge") ? "Confirm auto-merge?" : "Enable auto-merge"}
        </MenuItem>
      ) : null}
      {showsMethods ? (
        <>
          {showsDraftToggle || mergeable ? <MenuSeparator /> : null}
          <MenuRadioGroup
            onValueChange={(value) => {
              const next = value as PullRequestMergeMethod;
              setChosen(next);
              rememberMergeMethod(next);
            }}
            value={method}
          >
            {allowed.map((item) => (
              <MenuRadioItem closeOnClick disabled={pending} key={item} value={item}>
                <span className="flex min-w-0 items-center gap-2">
                  <GitMergeIcon className="size-3.5" />
                  <span>{MERGE_METHOD_LABELS[item]}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      ) : null}
      {showsDraftToggle || mergeable || showsDisable || showsMethods ? <MenuSeparator /> : null}
    </>
  ) : null;
  const showsDelete = !open && can("delete-branch");
  const trailing = (
    <>
      {open && can("close") ? (
        <>
          <MenuSeparator />
          <MenuItem
            aria-label={confirm.isArmed("close") ? "Confirm close?" : "Close pull request"}
            closeOnClick={confirm.isArmed("close")}
            disabled={pending}
            variant="destructive"
            {...confirm.props("close", () => void perform("close"))}
          >
            <GitPullRequestClosedIcon className="size-3.5" />
            {confirm.isArmed("close") ? "Confirm close?" : "Close pull request"}
          </MenuItem>
        </>
      ) : pr.state === "closed" && can("reopen") ? (
        <>
          <MenuSeparator />
          <MenuItem disabled={pending} onClick={() => void perform("reopen")}>
            <GitPullRequestCreateArrowIcon className="size-3.5" />
            Reopen pull request
          </MenuItem>
        </>
      ) : pr.state === "merged" && can("revert") ? (
        <>
          <MenuSeparator />
          <MenuItem
            aria-label={confirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
            closeOnClick={confirm.isArmed("revert")}
            disabled={pending}
            variant={confirm.isArmed("revert") ? "destructive" : "default"}
            {...confirm.props("revert", () => void perform("revert"))}
          >
            <RotateCcwIcon className="size-3.5" />
            {confirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
          </MenuItem>
        </>
      ) : null}
      {showsDelete ? (
        <>
          <MenuSeparator />
          <MenuItem
            disabled={pending}
            onClick={() => setConfirmingDelete(true)}
            variant="destructive"
          >
            <Trash2Icon className="mt-1 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>{pending ? "Deleting branch..." : "Delete branch"}</span>
              <span className="truncate text-xs text-muted-foreground">{pr.headBranch}</span>
            </span>
          </MenuItem>
        </>
      ) : null}
    </>
  );
  const repository = parsePullRequestUrl(link.url)?.repository ?? link.url;
  const dialog = showsDelete ? (
    <AlertDialog onOpenChange={setConfirmingDelete} open={confirmingDelete}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete branch {pr.headBranch}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes {pr.headBranch} from {repository}. Local branches and worktrees are not
            changed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" variant="outline" />}>
            Cancel
          </AlertDialogClose>
          <Button
            onClick={() => {
              setConfirmingDelete(false);
              void perform("delete-branch");
            }}
            size="sm"
            variant="destructive"
          >
            Delete branch
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  ) : null;
  return { leading, trailing, dialog };
}
