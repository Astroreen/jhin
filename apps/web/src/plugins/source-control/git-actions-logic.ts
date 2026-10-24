// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/GitActionsControl.logic.ts (the quick action, the menu, the progress
// stages, the default branch dialog's copy) and GitActionsControl.tsx
// (getMenuActionDisabledReason), on Jhin's `ProjectStatus` instead of T3's `VcsStatusResult`.
import type {
  ChangeRequestTerminology,
  GitStackedAction,
  ProjectStatus,
} from "@jhin/source-control-api";

import { forgeTerminology } from "../../lib/forges.ts";

export type GitActionIconName = "commit" | "push" | "pr";

export interface GitActionMenuItem {
  readonly id: "commit" | "push" | "pr";
  readonly label: string;
  readonly disabled: boolean;
  readonly icon: GitActionIconName;
  readonly dialogAction: "commit" | "push" | "create_pr";
}

export interface GitQuickAction {
  readonly label: string;
  readonly disabled: boolean;
  readonly kind: "run_action" | "run_pull" | "show_hint";
  readonly action?: GitStackedAction;
  readonly hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

/** How long a finished action's toast stays once seen. */
export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

/** The forge's word for a pull request: GitLab says merge request. */
function terminologyOf(status: ProjectStatus | undefined): ChangeRequestTerminology {
  return forgeTerminology(status?.provider?.kind);
}

/** What T3's `VcsStatusResult` says, read from a `ProjectStatus`. */
export interface GitActionStatus {
  readonly branch: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly hasOpenPr: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly aheadOfDefault: number;
  readonly hasUpstream: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly isDefaultRef: boolean;
  readonly terminology: ChangeRequestTerminology;
}

export function gitActionStatus(status: ProjectStatus): GitActionStatus {
  const pr = status.branch === null ? undefined : status.pullRequests[status.branch];
  return {
    branch: status.branch,
    hasWorkingTreeChanges: status.workingTree.fileCount > 0,
    hasOpenPr: pr?.state === "open",
    // Without an upstream, T3 counts what the branch has beyond its base.
    ahead: status.upstream === null ? (status.aheadOfDefault ?? 0) : status.ahead,
    behind: status.behind,
    aheadOfDefault: status.aheadOfDefault ?? status.ahead,
    hasUpstream: status.upstream !== null,
    hasPrimaryRemote: status.hasPrimaryRemote ?? status.remoteUrl !== null,
    isDefaultRef: status.branch !== null && status.branch === status.defaultBranch,
    terminology: terminologyOf(status),
  };
}

export function formatGitActionElapsed(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  return `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
}

export function buildMenuItems(
  status: GitActionStatus | null,
  isBusy: boolean,
): GitActionMenuItem[] {
  if (status === null) return [];
  const { terminology } = status;
  const hasBranch = status.branch !== null;
  const isBehind = status.behind > 0;
  const canPushWithoutUpstream = status.hasPrimaryRemote && !status.hasUpstream;
  const canCommit = !isBusy && status.hasWorkingTreeChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    status.ahead > 0 &&
    (status.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !status.hasOpenPr &&
    status.aheadOfDefault > 0 &&
    !isBehind &&
    (status.hasUpstream || canPushWithoutUpstream);

  const commit: GitActionMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    icon: "commit",
    dialogAction: "commit",
  };
  if (!status.hasPrimaryRemote) return [commit];
  const push: GitActionMenuItem = {
    id: "push",
    label: "Push",
    disabled: !canPush,
    icon: "push",
    dialogAction: "push",
  };
  if (status.hasOpenPr) return [commit, push];
  return [
    commit,
    push,
    {
      id: "pr",
      label: `Create ${terminology.shortLabel}`,
      disabled: !canCreatePr,
      icon: "pr",
      dialogAction: "create_pr",
    },
  ];
}

export function resolveQuickAction(
  status: GitActionStatus | null,
  isBusy: boolean,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }
  if (status === null) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }
  const { terminology, hasOpenPr, isDefaultRef } = status;
  const isAhead = status.ahead > 0;
  const isBehind = status.behind > 0;
  const upToDate: GitQuickAction = {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };

  if (status.branch === null) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (status.hasWorkingTreeChanges) {
    if (!status.hasUpstream && !status.hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    }
    return {
      label: `Commit, push & ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!status.hasUpstream) {
    if (!status.hasPrimaryRemote) {
      // T3 offers "Publish repository" here, which creates the repository on a forge (Deferred).
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: 'Add an "origin" remote before pushing.',
      };
    }
    if (!isAhead) {
      if (hasOpenPr) return upToDate;
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isAhead && isBehind) {
    return {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) return { label: "Pull", disabled: false, kind: "run_pull" };

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && status.hasUpstream) return upToDate;

  if (status.aheadOfDefault > 0 && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return upToDate;
}

/** Why a menu item is disabled, as T3's getMenuActionDisabledReason says it. */
export function menuItemDisabledReason(
  item: GitActionMenuItem,
  status: GitActionStatus | null,
  isBusy: boolean,
): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (status === null) return "Git status is unavailable.";
  const { terminology } = status;
  const hasBranch = status.branch !== null;
  const isBehind = status.behind > 0;

  if (item.id === "commit") {
    return status.hasWorkingTreeChanges
      ? "Commit is currently unavailable."
      : "Worktree is clean. Make changes before committing.";
  }
  if (item.id === "push") {
    if (!hasBranch) return "Detached HEAD: check out a branch before pushing.";
    if (status.hasWorkingTreeChanges) return "Commit or stash local changes before pushing.";
    if (isBehind) return "Branch is behind upstream. Pull/rebase before pushing.";
    if (!status.hasUpstream && !status.hasPrimaryRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (status.ahead <= 0) return "No local commits to push.";
    return "Push is currently unavailable.";
  }
  if (!hasBranch) {
    return `Detached HEAD: check out a branch before creating a ${terminology.singular}.`;
  }
  if (!status.hasUpstream && !status.hasPrimaryRemote) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if (status.aheadOfDefault <= 0) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (isBehind) {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.singular} is currently unavailable.`;
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): action is DefaultBranchConfirmableAction {
  return (
    isDefaultRef &&
    (action === "push" ||
      action === "create_pr" ||
      action === "commit_push" ||
      action === "commit_push_pr")
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology?: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branch = input.branchName;
  const suffix = ` on "${branch}". You can continue on this ref or create a feature ref and run the same action there.`;
  const terminology = input.terminology ?? forgeTerminology(undefined);
  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit & push to default ref?",
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branch}`,
      };
    }
    return {
      title: "Push to default ref?",
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branch}`,
    };
  }
  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ref?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ref?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}

/** Why the default branch dialog cannot check out a feature branch, or null when it can. */
export function resolveFeatureBranchUnavailableReason(input: {
  branchName: string;
  hasWorkingTreeChanges: boolean;
}): string | null {
  if (input.hasWorkingTreeChanges) return null;
  return `There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on ${input.branchName}.`;
}

/** What the running action's button says: its current phase, else that it starts. */
export function progressStatus(label: string | null, pulling: boolean): string {
  const current = label?.trim();
  if (current) return current;
  return pulling ? "Pulling latest changes..." : "Starting source control action...";
}
