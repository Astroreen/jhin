// The branch toolbar follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/BranchToolbar.tsx (the strip under the composer),
// BranchToolbarBranchSelector.tsx (the pull request badge and the branch trigger, switching
// and creating refs) and BranchPicker.tsx (the searchable list of refs and its badges);
// a new worktree's base and "Start from origin" follow WorktreeBaseBranchPicker.tsx; the
// "Checkout pull request" item follows BranchToolbarBranchSelector.tsx (D903).
import type { ChatComposerContextProps } from "@jhin/client-api";
import type { Branch, ProjectStatus } from "@jhin/source-control-api";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
  Switch,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { ChevronDownIcon, GitBranchIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { useId, useState } from "react";

import { ComposerControl } from "../../lib/composer-control.tsx";
import { useCatalog } from "../../lib/hooks.ts";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import { PullRequestBadge } from "./indicators.tsx";
import { PullRequestCheckoutDialog, parsePullRequestReference } from "./pull-request-checkout.tsx";
import {
  branchOf,
  statusOfThread,
  useSourceControl,
  type SourceControlServices,
} from "./services.ts";
import { draftKey, useDraftWorkspace, type DraftWorkspaces } from "./workspace.tsx";
import { WorkspaceSelector } from "./workspace-selector.tsx";

interface RefItem {
  readonly value: string;
  readonly label: string;
  /** A new ref named after the search. */
  readonly create?: true;
  /** T3's "Checkout pull request" of the reference searched for. */
  readonly checkout?: true;
  readonly branch?: Branch;
}

/** The ref's badge in the list, as T3's BranchPickerRefItem picks it. */
const badgeOf = (branch: Branch) =>
  branch.current ? "current" : branch.isRemote ? "remote" : branch.isDefault ? "default" : null;

/** What the trigger's tooltip says: where the branch stands against its upstream. */
export function describeBranch(status: ProjectStatus, branch: string): string {
  if (branch !== status.branch)
    return `${branch} · checked out: ${status.branch ?? "detached HEAD"}`;
  if (status.upstream === null) return `${branch} · no upstream`;
  const parts = [
    status.ahead > 0 ? `${status.ahead} ahead` : null,
    status.behind > 0 ? `${status.behind} behind` : null,
  ].filter((part) => part !== null);
  return `${branch} · ${parts.length === 0 ? "up to date with" : `${parts.join(", ")}`} ${status.upstream}`;
}

export function createBranchToolbar(services: SourceControlServices, drafts: DraftWorkspaces) {
  const { store, threads, toasts } = services;

  function BranchToolbar({ target, thread, project }: ChatComposerContextProps) {
    const view = useSourceControl(store, target);
    const catalog = useCatalog(threads, target);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [branches, setBranches] = useState<readonly Branch[] | undefined>();
    const [pending, setPending] = useState<string | undefined>();
    // The open dialog's reference; `key` gives each opening a fresh dialog, as T3 does.
    const [checkout, setCheckout] = useState<{ reference: string; key: number }>();
    const originSwitch = useId();
    const key = draftKey(target, project?.id ?? "");
    const draft = useDraftWorkspace(drafts, key);
    if (project === undefined || project.scratch) return null;
    const projectStatus = view.projects.get(project.id);
    const status = statusOfThread(view, project.id, thread) ?? projectStatus;
    if (projectStatus === undefined || !projectStatus.isRepo || status === undefined) return null;
    // A draft for a new worktree picks the worktree's base, not a checkout (D253).
    const choosingBase = thread === undefined && draft.mode === "worktree";
    const branch = choosingBase
      ? (draft.baseRef ?? status.branch)
      : (pending ?? branchOf(view, status, thread?.id));
    const pr = branch === null || choosingBase ? undefined : projectStatus.pullRequests[branch];

    const load = () =>
      void threads
        .call<{ branches: Branch[] }>(target, "git.branches", {
          projectId: project.id,
          ...(thread?.worktreePath === undefined ? {} : { threadId: thread.id }),
        })
        .then((answer) => setBranches(answer.branches))
        .catch(() => setBranches([]));

    const select = (item: RefItem) => {
      setOpen(false);
      setQuery("");
      if (item.checkout === true) {
        setCheckout({ reference: item.value, key: Date.now() });
        return;
      }
      if (choosingBase) {
        drafts.set(key, { ...draft, baseRef: item.value });
        return;
      }
      setPending(item.value);
      void threads
        .call(target, "git.checkout", {
          projectId: project.id,
          branch: item.value,
          ...(item.create === true ? { create: true } : {}),
          ...(thread === undefined ? {} : { threadId: thread.id }),
        })
        .catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title:
              item.create === true ? "Failed to create and switch ref." : "Failed to switch ref.",
            description: (error as Error).message,
          }),
        )
        .finally(() => setPending(undefined));
    };

    const trimmed = query.trim();
    // A draft on GitHub can check a pull request out into its thread (D902, D903); not while
    // the picker chooses a new worktree's base.
    const pullRequestReference =
      thread === undefined && !choosingBase && projectStatus.provider?.kind === "github"
        ? parsePullRequestReference(trimmed)
        : null;
    const items: RefItem[] = (branches ?? []).map((ref) => ({
      value: ref.name,
      label: ref.name,
      branch: ref,
    }));
    if (!choosingBase && trimmed !== "" && !items.some((item) => item.value === trimmed)) {
      items.push({ value: trimmed, label: `Create new ref "${trimmed}"`, create: true });
    }
    if (pullRequestReference !== null) {
      items.unshift({
        value: pullRequestReference,
        label: "Checkout pull request",
        checkout: true,
      });
    }
    // T3's resolveBranchTriggerLabel: a new worktree says where it starts from.
    const remoteBase =
      branch !== null && (branches ?? []).some((ref) => ref.name === branch && ref.isRemote);
    const label = choosingBase
      ? branch === null
        ? "Select ref"
        : `From ${draft.startFromOrigin && !remoteBase ? `origin/${branch}` : branch}`
      : (branch ?? "Detached HEAD");

    return (
      <div className="flex w-full min-w-0 items-center gap-1" data-branch-toolbar>
        <WorkspaceSelector
          drafts={drafts}
          project={project}
          services={services}
          status={status}
          target={target}
          thread={thread}
          threads={catalog?.threads ?? []}
        />
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {pr ? <PullRequestBadge pr={pr} variant="toolbar" /> : null}
          <Combobox
            autoHighlight
            filter={(item: RefItem, search: string) =>
              item.create === true ||
              item.checkout === true ||
              item.label.toLowerCase().includes(search.trim().toLowerCase())
            }
            inputValue={query}
            isItemEqualToValue={(a: RefItem, b: RefItem) => a.value === b.value}
            itemToStringLabel={(item: RefItem) => item.label}
            items={items}
            onInputValueChange={(value: string) => setQuery(value)}
            onOpenChange={(next: boolean) => {
              setOpen(next);
              if (next) load();
              else setQuery("");
            }}
            onValueChange={(item: RefItem | null) => {
              if (item !== null && item.value !== branch) select(item);
            }}
            open={open}
            value={items.find((item) => item.value === branch) ?? null}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <ComboboxTrigger
                    aria-label={`Branch ${label}`}
                    className="min-w-0 max-w-full active:scale-100"
                    data-composer-context-item
                    disabled={pending !== undefined}
                    render={<ComposerControl size="xs" />}
                  />
                }
              >
                <GitBranchIcon className="size-3 shrink-0 opacity-70" />
                <span className="min-w-0" data-composer-control-label>
                  <MiddleTruncate className="w-full" showTitle={false} value={label} />
                </span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {branch === null || choosingBase ? label : describeBranch(status, branch)}
              </TooltipPopup>
            </Tooltip>
            <ComboboxPopup align="end" className="flex w-80 flex-col" side="top">
              <ComboboxSearchInput aria-label="Search refs" placeholder="Search refs..." />
              <ComboboxEmpty>No refs found.</ComboboxEmpty>
              <ComboboxList className="max-h-56">
                {(item: RefItem) => {
                  const badge = item.branch === undefined ? null : badgeOf(item.branch);
                  return (
                    <ComboboxItem
                      hideIndicator
                      key={`${item.checkout ? "#" : item.create ? "+" : ""}${item.value}`}
                      value={item}
                    >
                      {item.checkout === true ? (
                        <div className="flex min-w-0 items-center gap-2">
                          <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{item.label}</div>
                            <div className="truncate text-muted-foreground text-xs">
                              {item.value}
                            </div>
                          </div>
                        </div>
                      ) : item.create === true ? (
                        <span className="truncate">{item.label}</span>
                      ) : (
                        <div className="flex w-full min-w-0 items-center justify-between gap-2">
                          <MiddleTruncate className="flex-1" value={item.value} />
                          {badge === null ? null : (
                            <span className="shrink-0 text-3xs text-muted-foreground/45">
                              {badge}
                            </span>
                          )}
                        </div>
                      )}
                    </ComboboxItem>
                  );
                }}
              </ComboboxList>
              {branches === undefined ? <ComboboxStatus>Loading refs...</ComboboxStatus> : null}
              {choosingBase ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <label
                        className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
                        htmlFor={originSwitch}
                      />
                    }
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
                      <RefreshCwIcon aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate">Start from origin</span>
                    </span>
                    <Switch
                      aria-label="Start worktree from origin"
                      checked={draft.startFromOrigin}
                      id={originSwitch}
                      onCheckedChange={(checked) =>
                        drafts.set(key, { ...draft, startFromOrigin: Boolean(checked) })
                      }
                      size="sm"
                    />
                  </TooltipTrigger>
                  <TooltipPopup className="max-w-72 whitespace-normal" side="top">
                    Creates the worktree from the latest matching branch on origin instead of your
                    local branch.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </ComboboxPopup>
          </Combobox>
        </div>
        {checkout === undefined ? null : (
          <PullRequestCheckoutDialog
            initialReference={checkout.reference}
            key={checkout.key}
            onOpenChange={(next) => {
              if (!next) setCheckout(undefined);
            }}
            onPrepared={(prepared) =>
              // The draft's thread starts where the pull request was checked out (T3's draft).
              drafts.set(
                key,
                prepared.worktreePath === null
                  ? { mode: "local", startFromOrigin: false }
                  : {
                      mode: "previous",
                      startFromOrigin: false,
                      previous: { path: prepared.worktreePath, branch: prepared.branch },
                    },
              )
            }
            open
            projectId={project.id}
            target={target}
            threads={threads}
          />
        )}
      </div>
    );
  }

  return BranchToolbar;
}
