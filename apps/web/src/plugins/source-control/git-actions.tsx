// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/GitActionsControl.tsx
// in its toolbar presentation (the quick action and its menu, the progress button with its
// elapsed time and the hook's last line, the commit dialog, the default branch dialog and the
// result toasts with their call to action).
import { targetKey, type ChatHeaderActionProps, type NodeTarget } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";
import {
  GIT_ACTION_PROGRESS,
  SOURCE_CONTROL_ACTIONS_STREAM,
  type GitActionProgress,
  type GitActionResult,
  type GitStackedAction,
  type ProjectStatus,
  type PullResult,
} from "@jhin/source-control-api";
import {
  Button,
  Checkbox,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Group,
  GroupSeparator,
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  ScrollArea,
  Spinner,
  Textarea,
  cn,
} from "@jhin/ui";
import {
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  InfoIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { formatDiffCount } from "../../lib/pull-request.ts";
import {
  GIT_ACTION_SUCCESS_VISIBLE_MS,
  buildMenuItems,
  formatGitActionElapsed,
  gitActionStatus,
  menuItemDisabledReason,
  progressStatus,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveFeatureBranchUnavailableReason,
  resolveQuickAction,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
} from "./git-actions-logic.ts";
import type { RunningAction } from "./running.ts";
import { useSourceControl, type SourceControlServices } from "./services.ts";

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

interface PendingDefaultBranchAction {
  readonly action: DefaultBranchConfirmableAction;
  readonly branchName: string;
  readonly includesCommit: boolean;
  readonly commitMessage?: string;
  readonly filePaths?: string[];
}

interface RunInput {
  readonly action: GitStackedAction;
  readonly commitMessage?: string;
  readonly skipDefaultBranchPrompt?: boolean;
  readonly featureBranch?: boolean;
  readonly filePaths?: string[];
}

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitPullRequestIcon />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const className = "size-3.5";
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={className} />;
    }
    return <GitPullRequestIcon className={className} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={className} />;
  if (quickAction.label === "Push") return <CloudUploadIcon className={className} />;
  return <InfoIcon className={className} />;
}

function GitActionElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  return (
    <p className="row-start-1 text-2xs font-normal tabular-nums text-muted-foreground">
      {formatGitActionElapsed(startedAt, now)}
    </p>
  );
}

function GitActionProgressButtonContent({ running }: { running: RunningAction }) {
  const status = progressStatus(running.label, running.pulling);
  const output = running.pulling ? null : running.output;
  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[1.25rem] items-center gap-x-2.5 sm:grid-rows-[1rem]"
      role="status"
    >
      <Spinner aria-hidden="true" className="row-start-1 -mx-0.5 shrink-0" />
      <p className="row-start-1 min-w-0 truncate text-left">{status}</p>
      <GitActionElapsedTime startedAt={running.startedAt} />
      <div
        className={cn(
          "col-span-2 col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          output !== null ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground">
            {output}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Follows the progress of `actionId` on the node's live stream until `dispose`. */
function followProgress(
  services: SourceControlServices,
  target: NodeTarget,
  actionId: string,
  onProgress: (event: GitActionProgress) => void,
): Disposable | undefined {
  // A mesh member's live streams are not mirrored (W17): its actions show no phases.
  if (target.remote !== undefined) return undefined;
  const connection = services.connections.get(target.node);
  if (connection?.state !== "open") return undefined;
  return connection.client.subscribe(
    SOURCE_CONTROL_ACTIONS_STREAM,
    { onError: () => undefined },
    (event) => {
      if (event.type !== GIT_ACTION_PROGRESS) return;
      const progress = event.payload as GitActionProgress;
      if (progress.actionId === actionId) onProgress(progress);
    },
  );
}

/** T3's GitActionsControl in the chat header: the quick git action and its menu. */
export function createGitActionsControl(services: SourceControlServices) {
  const { store, threads, toasts } = services;
  const running = services.running;

  return function GitActionsControl({ target, thread, project }: ChatHeaderActionProps) {
    const view = useSourceControl(store, target);
    const projectId = project?.id ?? thread?.projectId;
    const key = `${targetKey(target)}\u0000${projectId ?? ""}`;
    const current = useSyncExternalStore(running.subscribe, () => running.get(key));
    const [commitOpen, setCommitOpen] = useState(false);
    const [message, setMessage] = useState("");
    const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
    const [editingFiles, setEditingFiles] = useState(false);
    const [pending, setPending] = useState<PendingDefaultBranchAction | null>(null);
    const [initializing, setInitializing] = useState(false);

    if (projectId === undefined || project?.scratch === true) return null;
    const projectStatus: ProjectStatus | undefined = view.projects.get(projectId);
    if (projectStatus === undefined) return null;

    const isBusy = current !== undefined;
    const status = projectStatus.isRepo ? gitActionStatus(projectStatus) : null;
    const quickAction = resolveQuickAction(status, isBusy);
    const menuItems = buildMenuItems(status, isBusy);
    const terminology = status?.terminology;
    const allFiles = projectStatus.workingTree.files;
    const selectedFiles = allFiles.filter((file) => !excluded.has(file.path));
    const allSelected = excluded.size === 0;
    const noneSelected = selectedFiles.length === 0;
    const pendingCopy =
      pending === null
        ? null
        : resolveDefaultBranchActionDialogCopy({
            action: pending.action,
            branchName: pending.branchName,
            includesCommit: pending.includesCommit,
            ...(terminology === undefined ? {} : { terminology }),
          });
    const featureBranchUnavailableReason =
      pending === null
        ? null
        : resolveFeatureBranchUnavailableReason({
            branchName: pending.branchName,
            hasWorkingTreeChanges: status?.hasWorkingTreeChanges ?? true,
          });

    const refreshStatus = () => void store.refresh(target, projectId).catch(() => undefined);

    const resetCommitDialog = () => {
      setCommitOpen(false);
      setMessage("");
      setExcluded(new Set());
      setEditingFiles(false);
    };

    const showResult = (result: GitActionResult) => {
      const cta = result.toast.cta;
      let toastId = "";
      toastId =
        toasts?.show({
          type: "success",
          title: result.toast.title,
          ...(result.toast.description === undefined
            ? {}
            : { description: result.toast.description }),
          timeout: 0,
          data: { dismissAfterVisibleMs: GIT_ACTION_SUCCESS_VISIBLE_MS },
          ...(cta.kind === "run_action"
            ? {
                action: {
                  label: cta.label,
                  onClick: () => {
                    toasts?.close(toastId);
                    void run({ action: cta.action });
                  },
                },
              }
            : cta.kind === "open_pr"
              ? {
                  action: {
                    label: cta.label,
                    onClick: () => {
                      toasts?.close(toastId);
                      // Only a web page: a forge's answer is no reason to run anything else.
                      if (/^https?:\/\//i.test(cta.url)) {
                        window.open(cta.url, "_blank", "noopener,noreferrer");
                      }
                    },
                  },
                }
              : {}),
        }) ?? "";
    };

    async function run(input: RunInput): Promise<void> {
      if (status === null || projectId === undefined) return;
      const featureBranch = input.featureBranch === true;
      const includesCommit =
        (input.action === "commit" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr") &&
        (input.action === "commit" || status.hasWorkingTreeChanges || featureBranch);
      if (
        input.skipDefaultBranchPrompt !== true &&
        status.branch !== null &&
        requiresDefaultBranchConfirmation(input.action, featureBranch ? false : status.isDefaultRef)
      ) {
        setPending({
          action: input.action as DefaultBranchConfirmableAction,
          branchName: status.branch,
          includesCommit,
          ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
          ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
        });
        return;
      }
      const actionId = crypto.randomUUID();
      let state: RunningAction = {
        actionId,
        pulling: false,
        label: null,
        output: null,
        startedAt: Date.now(),
      };
      running.set(key, state);
      const progress = followProgress(services, target, actionId, (event) => {
        if (event.kind === "phase_started") state = { ...state, label: event.label, output: null };
        else if (event.kind === "hook_output") state = { ...state, output: event.text };
        else return;
        if (running.get(key)?.actionId === actionId) running.set(key, state);
      });
      try {
        const result = await threads.call<GitActionResult>(target, "git.action.run", {
          projectId,
          action: input.action,
          actionId,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(featureBranch ? { featureBranch: true } : {}),
          ...(input.filePaths ? { filePaths: input.filePaths } : {}),
          ...(thread === undefined ? {} : { threadId: thread.id }),
        });
        showResult(result);
      } catch (error) {
        toasts?.show({
          type: "error",
          title: "Action failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          timeout: 0,
        });
      } finally {
        progress?.dispose();
        if (running.get(key)?.actionId === actionId) running.set(key, undefined);
        refreshStatus();
      }
    }

    const runPull = async () => {
      const actionId = crypto.randomUUID();
      running.set(key, {
        actionId,
        pulling: true,
        label: null,
        output: null,
        startedAt: Date.now(),
      });
      try {
        const result = await threads.call<PullResult>(target, "git.pull", { projectId });
        const pulled = result.status === "pulled";
        toasts?.show({
          type: "success",
          title: pulled ? "Pulled" : "Already up to date",
          description: pulled
            ? `Updated ${result.branch} from ${result.upstream ?? "upstream"}`
            : `${result.branch} is already synchronized.`,
          timeout: 0,
          data: { dismissAfterVisibleMs: GIT_ACTION_SUCCESS_VISIBLE_MS },
        });
      } catch (error) {
        toasts?.show({
          type: "error",
          title: "Pull failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          timeout: 0,
        });
      } finally {
        if (running.get(key)?.actionId === actionId) running.set(key, undefined);
        refreshStatus();
      }
    };

    const runQuickAction = () => {
      if (quickAction.kind === "run_pull") {
        void runPull();
        return;
      }
      if (quickAction.kind === "show_hint") {
        toasts?.show({
          type: "info",
          title: quickAction.label,
          ...(quickAction.hint === undefined ? {} : { description: quickAction.hint }),
        });
        return;
      }
      if (quickAction.action !== undefined) void run({ action: quickAction.action });
    };

    const openMenuItem = (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.dialogAction === "push" || item.dialogAction === "create_pr") {
        void run({ action: item.dialogAction });
        return;
      }
      setExcluded(new Set());
      setEditingFiles(false);
      setCommitOpen(true);
    };

    const commitFromDialog = (featureBranch: boolean) => {
      const commitMessage = message.trim();
      const filePaths = allSelected ? undefined : selectedFiles.map((file) => file.path);
      resetCommitDialog();
      void run({
        action: "commit",
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths === undefined ? {} : { filePaths }),
        ...(featureBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
      });
    };

    const continuePending = (featureBranch: boolean) => {
      if (pending === null) return;
      setPending(null);
      void run({
        action: pending.action,
        ...(pending.commitMessage === undefined ? {} : { commitMessage: pending.commitMessage }),
        ...(pending.filePaths === undefined ? {} : { filePaths: pending.filePaths }),
        ...(featureBranch ? { featureBranch: true } : {}),
        skipDefaultBranchPrompt: true,
      });
    };

    const initialize = () => {
      setInitializing(true);
      void threads
        .call(target, "git.init", { projectId })
        .catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Git initialization failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        )
        .finally(() => {
          setInitializing(false);
          refreshStatus();
        });
    };

    if (!projectStatus.isRepo) {
      // A project git cannot read at all (git missing) has nothing to initialize.
      if (projectStatus.reason !== "Not a git repository") return null;
      return (
        <Button disabled={initializing} onClick={initialize} size="xs" variant="outline">
          <GitBranchPlusIcon aria-hidden className="size-3.5" />
          <span className="ml-0.5">{initializing ? "Initializing..." : "Initialize Git"}</span>
        </Button>
      );
    }

    const quickActionLabel = (
      <span className="sr-only lg:not-sr-only lg:ml-0.5">{quickAction.label}</span>
    );

    return (
      <>
        <Group aria-label="Git actions" className="shrink-0">
          {current !== undefined ? (
            <Button
              aria-label={
                current.output
                  ? `${progressStatus(current.label, current.pulling)} ${current.output}`
                  : progressStatus(current.label, current.pulling)
              }
              className="h-auto max-w-72 py-1"
              disabled
              size="xs"
              variant="outline"
            >
              <GitActionProgressButtonContent running={current} />
            </Button>
          ) : quickAction.disabled ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={<Button aria-disabled="true" size="xs" variant="outline" />}
              >
                <GitQuickActionIcon quickAction={quickAction} />
                {quickActionLabel}
              </PopoverTrigger>
              <PopoverPopup align="start" side="bottom" tooltipStyle>
                {quickAction.hint ?? "This action is currently unavailable."}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button onClick={runQuickAction} size="xs" variant="outline">
              <GitQuickActionIcon quickAction={quickAction} />
              {quickActionLabel}
            </Button>
          )}
          {current === undefined ? (
            <>
              <GroupSeparator className="hidden lg:block" />
              <Menu
                onOpenChange={(open) => {
                  if (open) refreshStatus();
                }}
              >
                <MenuTrigger
                  render={
                    <Button aria-label="Git action options" size="icon-xs" variant="outline" />
                  }
                >
                  <ChevronDownIcon aria-hidden="true" className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {menuItems.map((item) => {
                    const reason = menuItemDisabledReason(item, status, isBusy);
                    if (item.disabled && reason) {
                      return (
                        <Popover key={item.id}>
                          <PopoverTrigger
                            nativeButton={false}
                            openOnHover
                            render={<span className="block w-full cursor-not-allowed" />}
                          >
                            <MenuItem className="w-full" disabled>
                              <GitActionItemIcon icon={item.icon} />
                              <MenuItemLabel>{item.label}</MenuItemLabel>
                            </MenuItem>
                          </PopoverTrigger>
                          <PopoverPopup align="center" side="left" tooltipStyle>
                            {reason}
                          </PopoverPopup>
                        </Popover>
                      );
                    }
                    return (
                      <MenuItem
                        disabled={item.disabled}
                        key={item.id}
                        onClick={() => openMenuItem(item)}
                      >
                        <GitActionItemIcon icon={item.icon} />
                        <MenuItemLabel>{item.label}</MenuItemLabel>
                      </MenuItem>
                    );
                  })}
                  {projectStatus.branch === null && (
                    <p className="px-2 py-1.5 text-xs text-warning">
                      Detached HEAD: create and check out a branch to enable push and pull request
                      actions.
                    </p>
                  )}
                  {projectStatus.branch !== null &&
                    projectStatus.workingTree.fileCount === 0 &&
                    projectStatus.behind > 0 &&
                    projectStatus.ahead === 0 && (
                      <p className="px-2 py-1.5 text-xs text-warning">
                        Behind upstream. Pull/rebase first.
                      </p>
                    )}
                </MenuPopup>
              </Menu>
            </>
          ) : null}
        </Group>

        <Dialog
          onOpenChange={(open) => {
            if (!open) resetCommitDialog();
          }}
          open={commitOpen}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
              <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">Branch</span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{projectStatus.branch ?? "(detached HEAD)"}</span>
                    {status?.isDefaultRef && (
                      <span className="text-right text-warning">Default branch</span>
                    )}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {editingFiles && allFiles.length > 0 && (
                        <Checkbox
                          aria-label="Include every file"
                          checked={allSelected}
                          indeterminate={!allSelected && !noneSelected}
                          onCheckedChange={() =>
                            setExcluded(
                              allSelected ? new Set(allFiles.map((file) => file.path)) : new Set(),
                            )
                          }
                        />
                      )}
                      <span className="text-muted-foreground">Files</span>
                      {!allSelected && !editingFiles && (
                        <span className="text-muted-foreground">
                          ({selectedFiles.length} of {allFiles.length})
                        </span>
                      )}
                    </div>
                    {allFiles.length > 0 && (
                      <Button
                        onClick={() => setEditingFiles((editing) => !editing)}
                        size="xs"
                        variant="ghost"
                      >
                        {editingFiles ? "Done" : "Edit"}
                      </Button>
                    )}
                  </div>
                  {allFiles.length === 0 ? (
                    <p className="font-medium">none</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                        <ScrollArea>
                          <div className="space-y-1 p-1">
                            {allFiles.map((file) => {
                              const isExcluded = excluded.has(file.path);
                              return (
                                <div
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
                                  key={file.path}
                                >
                                  {editingFiles && (
                                    <Checkbox
                                      aria-label={`Include ${file.path}`}
                                      checked={!isExcluded}
                                      onCheckedChange={() =>
                                        setExcluded((previous) => {
                                          const next = new Set(previous);
                                          if (next.has(file.path)) next.delete(file.path);
                                          else next.add(file.path);
                                          return next;
                                        })
                                      }
                                    />
                                  )}
                                  <span className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
                                    <span
                                      className={cn(
                                        "min-w-0 flex-1 truncate [direction:rtl] text-left",
                                        isExcluded && "text-muted-foreground",
                                      )}
                                      title={file.path}
                                    >
                                      <bdi>{file.path}</bdi>
                                    </span>
                                    <span className="shrink-0">
                                      {isExcluded ? (
                                        <span className="text-muted-foreground">Excluded</span>
                                      ) : (
                                        <>
                                          <span className="text-diff-addition">
                                            +{formatDiffCount(file.insertions)}
                                          </span>
                                          <span className="text-muted-foreground"> / </span>
                                          <span className="text-diff-deletion">
                                            -{formatDiffCount(file.deletions)}
                                          </span>
                                        </>
                                      )}
                                    </span>
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </ScrollArea>
                      </div>
                      <div className="flex justify-end font-mono">
                        <span className="text-diff-addition">
                          +
                          {formatDiffCount(
                            selectedFiles.reduce((sum, file) => sum + file.insertions, 0),
                          )}
                        </span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-diff-deletion">
                          -
                          {formatDiffCount(
                            selectedFiles.reduce((sum, file) => sum + file.deletions, 0),
                          )}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Commit message (optional)</p>
                <Textarea
                  aria-label="Commit message"
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Leave empty to auto-generate"
                  size="sm"
                  value={message}
                />
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button onClick={resetCommitDialog} size="sm" variant="outline">
                Cancel
              </Button>
              <Button
                disabled={noneSelected}
                onClick={() => commitFromDialog(true)}
                size="sm"
                variant="outline"
              >
                Commit on new branch
              </Button>
              <Button disabled={noneSelected} onClick={() => commitFromDialog(false)} size="sm">
                Commit
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>

        <Dialog
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          open={pending !== null}
        >
          <DialogPopup className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{pendingCopy?.title ?? "Run action on default branch?"}</DialogTitle>
              <DialogDescription>{pendingCopy?.description}</DialogDescription>
              {featureBranchUnavailableReason && (
                <p className="text-xs text-muted-foreground">{featureBranchUnavailableReason}</p>
              )}
            </DialogHeader>
            <DialogFooter className="sm:flex-wrap sm:items-center" variant="bare">
              <Button
                className="w-full sm:mr-auto sm:w-auto"
                onClick={() => setPending(null)}
                size="sm"
                variant="outline"
              >
                Abort
              </Button>
              <Button
                className="w-full max-w-full sm:w-auto"
                onClick={() => continuePending(false)}
                size="sm-multiline"
                variant="outline"
              >
                {pendingCopy?.continueLabel ?? "Continue"}
              </Button>
              <Button
                className="w-full max-w-full sm:w-auto"
                disabled={featureBranchUnavailableReason !== null}
                onClick={() => continuePending(true)}
                size="sm-multiline"
              >
                Check out feature branch & continue
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </>
    );
  };
}
