// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/WorktreeBaseBranchPicker.tsx, BranchPicker.tsx (the searchable
// refs and their badges) and BranchToolbar.logic.ts (resolveBranchTriggerLabel).
// Decisions: docs/plans/orchestration.md (D1179).
import type { Branch } from "@jhin/source-control-api";
import {
  Button,
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
  Input,
  Label,
  Switch,
} from "@jhin/ui";
import { ChevronDownIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { MiddleTruncate } from "../../lib/middle-truncate.tsx";

/** T3's resolveBranchTriggerLabel for a new worktree's base. */
export function baseBranchLabel(
  value: string,
  startFromOrigin: boolean,
  isRemote: boolean | undefined,
): string {
  if (value === "") return "Select ref";
  return `From ${startFromOrigin && isRemote === false ? `origin/${value}` : value}`;
}

/** The ref's badge in the list, as T3's BranchPickerRefItem picks it. */
const badgeOf = (branch: Branch) =>
  branch.current ? "current" : branch.isRemote ? "remote" : branch.isDefault ? "default" : null;

/**
 * The branch a task's new worktree starts from, picked from the project's refs, with
 * "Start from origin" at the list's foot. A project whose refs cannot be read keeps the
 * text field.
 */
export function BaseBranchPicker(props: {
  readonly id: string;
  /** Reads the project's refs (`git.branches`). */
  readonly loadBranches: () => Promise<readonly Branch[]>;
  readonly value: string;
  onValueChange(value: string): void;
  readonly startFromOrigin: boolean;
  onStartFromOriginChange(value: boolean): void;
  readonly disabled: boolean;
}) {
  const [branches, setBranches] = useState<readonly Branch[] | "unavailable" | undefined>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const originSwitch = useId();
  const latest = useRef(0);
  const { loadBranches } = props;
  /**
   * Reads the refs; only the latest read counts. Only the first read can fall back to
   * the text field: a later one that fails keeps the refs already shown.
   */
  const load = (first: boolean) => {
    const read = (latest.current += 1);
    void loadBranches().then(
      (list) => {
        if (read === latest.current) setBranches(list);
      },
      () => {
        // Never read yet (the first read was superseded): the text field, not a spinner.
        if (read === latest.current) {
          setBranches((known) => (first || known === undefined ? "unavailable" : known));
        }
      },
    );
  };
  // Read once for the project, so a project without refs shows the text field at once.
  useEffect(() => load(true), [loadBranches]);
  if (branches === "unavailable") {
    return (
      <div className="flex items-center gap-3">
        <Input
          className="min-w-0 flex-1"
          id={props.id}
          onChange={(event) => props.onValueChange(event.target.value)}
          placeholder="main"
          value={props.value}
        />
        <Label className="flex shrink-0 items-center gap-2 font-normal">
          <Switch
            aria-label="Start from origin"
            checked={props.startFromOrigin}
            onCheckedChange={props.onStartFromOriginChange}
          />
          Start from origin
        </Label>
      </div>
    );
  }
  const names = (branches ?? []).map((branch) => branch.name);
  const items = props.value === "" || names.includes(props.value) ? names : [props.value, ...names];
  const selected = (branches ?? []).find((branch) => branch.name === props.value);
  return (
    <Combobox
      autoHighlight
      filter={(item: string, search: string) =>
        item.toLowerCase().includes(search.trim().toLowerCase())
      }
      inputValue={query}
      items={items}
      onInputValueChange={(value: string) => setQuery(value)}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) load(false);
        else setQuery("");
      }}
      onValueChange={(item: string | null) => {
        if (item === null) return;
        props.onValueChange(item);
        setOpen(false);
      }}
      open={open && !props.disabled}
      value={props.value === "" ? null : props.value}
    >
      <ComboboxTrigger
        className="w-full justify-between"
        disabled={props.disabled}
        id={props.id}
        render={<Button size="sm" variant="outline" />}
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <MiddleTruncate
          className="flex-1 text-left"
          value={baseBranchLabel(props.value, props.startFromOrigin, selected?.isRemote)}
        />
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="flex w-80 flex-col" side="bottom">
        <ComboboxSearchInput aria-label="Search refs" placeholder="Search refs..." />
        <ComboboxEmpty>No refs found.</ComboboxEmpty>
        <ComboboxList className="max-h-56">
          {(name: string) => {
            const branch = (branches ?? []).find((candidate) => candidate.name === name);
            const badge = branch === undefined ? null : badgeOf(branch);
            return (
              <ComboboxItem hideIndicator key={name} value={name}>
                <div className="flex w-full min-w-0 items-center justify-between gap-2">
                  <MiddleTruncate className="flex-1" value={name} />
                  {badge === null ? null : (
                    <span className="shrink-0 text-3xs text-muted-foreground/45">{badge}</span>
                  )}
                </div>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
        {branches === undefined ? <ComboboxStatus>Loading refs...</ComboboxStatus> : null}
        <label
          className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
          htmlFor={originSwitch}
        >
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
            <RefreshCwIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">Start from origin</span>
          </span>
          <Switch
            aria-label="Start from origin"
            checked={props.startFromOrigin}
            id={originSwitch}
            onCheckedChange={(checked) => props.onStartFromOriginChange(Boolean(checked))}
            size="sm"
          />
        </label>
      </ComboboxPopup>
    </Combobox>
  );
}
