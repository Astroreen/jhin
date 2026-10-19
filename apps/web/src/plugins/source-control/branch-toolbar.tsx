// The branch toolbar follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/BranchToolbar.tsx (the strip under the composer),
// BranchToolbarBranchSelector.tsx (the pull request badge and the branch trigger, switching
// and creating refs) and BranchPicker.tsx (the searchable list of refs and its badges).
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
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";

import { ComposerControl } from "../../lib/composer-control.tsx";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import { PullRequestBadge } from "./indicators.tsx";
import { branchOf, useSourceControl, type SourceControlServices } from "./services.ts";

interface RefItem {
  readonly value: string;
  readonly label: string;
  /** A new ref named after the search. */
  readonly create?: true;
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

export function createBranchToolbar(services: SourceControlServices) {
  const { store, threads, toasts } = services;

  function BranchToolbar({ target, thread, project }: ChatComposerContextProps) {
    const view = useSourceControl(store, target);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [branches, setBranches] = useState<readonly Branch[] | undefined>();
    const [pending, setPending] = useState<string | undefined>();
    if (project === undefined || project.scratch) return null;
    const status = view.projects.get(project.id);
    if (status === undefined || !status.isRepo) return null;
    const branch = pending ?? branchOf(view, status, thread?.id);
    const pr = branch === null ? undefined : status.pullRequests[branch];

    const load = () =>
      void threads
        .call<{ branches: Branch[] }>(target, "git.branches", { projectId: project.id })
        .then((answer) => setBranches(answer.branches))
        .catch(() => setBranches([]));

    const select = (item: RefItem) => {
      setOpen(false);
      setQuery("");
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
    const items: RefItem[] = (branches ?? []).map((ref) => ({
      value: ref.name,
      label: ref.name,
      branch: ref,
    }));
    if (trimmed !== "" && !items.some((item) => item.value === trimmed)) {
      items.push({ value: trimmed, label: `Create new ref "${trimmed}"`, create: true });
    }
    const label = branch ?? "Detached HEAD";

    return (
      <div className="ml-auto flex min-w-0 items-center gap-1" data-branch-toolbar>
        {pr ? <PullRequestBadge pr={pr} variant="toolbar" /> : null}
        <Combobox
          autoHighlight
          filter={(item: RefItem, search: string) =>
            item.create === true || item.label.toLowerCase().includes(search.trim().toLowerCase())
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
              {branch === null ? label : describeBranch(status, branch)}
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
                    key={`${item.create ? "+" : ""}${item.value}`}
                    value={item}
                  >
                    {item.create === true ? (
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
          </ComboboxPopup>
        </Combobox>
      </div>
    );
  }

  return BranchToolbar;
}
