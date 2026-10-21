// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/DiffPanel.tsx
// (the "head → base" label and the comparison target combobox of the "Changes" scope).
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import type { Branch } from "@jhin/source-control-api";
import {
  Button,
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  Switch,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { buildBaseRefChoices, filterBaseRefChoices, type BaseRefChoice } from "./base-refs.ts";

const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

export function BaseRefPicker(props: {
  readonly threads: ThreadsCatalog;
  readonly target: NodeTarget;
  readonly projectId: string;
  readonly headRef: string | null;
  readonly baseRef: string;
  /** The base chosen; none is automatic. */
  readonly selected: string | undefined;
  onSelect(base: string | undefined): void;
}) {
  const { headRef, baseRef, selected } = props;
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<readonly Branch[] | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  /** The latest read: an answer to an earlier one is dropped. */
  const reads = useRef(0);
  const load = () => {
    const read = ++reads.current;
    // A new read starts clean: an earlier failure is not shown while it runs.
    setFailed(undefined);
    void props.threads
      .call<{ branches: Branch[] }>(props.target, "git.branches", { projectId: props.projectId })
      .then(
        (answer) => {
          if (read !== reads.current) return;
          setFailed(undefined);
          setBranches(answer.branches);
        },
        // Said as it is, not as "No matching refs.": the next opening reads them again.
        (error: unknown) => {
          if (read !== reads.current) return;
          setFailed(error instanceof Error ? error.message : String(error));
          setBranches([]);
        },
      );
  };
  const refs = branches ?? [];
  const choices = buildBaseRefChoices(
    refs.filter((ref) => !ref.isRemote && ref.name !== headRef),
    refs.filter((ref) => ref.isRemote),
  );
  const matching = filterBaseRefChoices(choices, query);
  const valueFor = (choice: BaseRefChoice) =>
    selected !== undefined && selected === choice.remote?.name
      ? selected
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const items = [AUTOMATIC_BASE_REF, ...choices.map(valueFor)];
  const filteredItems = [
    ...(query.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matching.map(valueFor),
  ];

  return (
    <div
      aria-label={`Comparing ${headRef ?? "HEAD"} against ${baseRef}`}
      className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
    >
      {/* The head ref keeps 3rem while the row has room; below that the
          base-ref button keeps 2.25rem so its menu stays reachable. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex min-w-[min(3rem,calc(100%-2.75rem))] items-center gap-2 overflow-hidden" />
          }
        >
          <span className="min-w-0 max-w-48 truncate">{headRef ?? "HEAD"}</span>
          <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
        </TooltipTrigger>
        <TooltipPopup side="top">{`${headRef ?? "HEAD"} → ${baseRef}`}</TooltipPopup>
      </Tooltip>
      <Combobox
        filteredItems={filteredItems}
        items={items}
        onOpenChange={(open) => {
          if (open) load();
          else setQuery("");
        }}
        onValueChange={(value) => {
          if (!value) return;
          props.onSelect(value === AUTOMATIC_BASE_REF ? undefined : value);
        }}
        value={selected ?? AUTOMATIC_BASE_REF}
      >
        <ComboboxTrigger
          aria-label={`Change comparison target. Currently ${baseRef}`}
          className="min-w-9 max-w-48 shrink"
          render={<Button size="xs" variant="ghost-muted" />}
        >
          <span className="min-w-0 truncate">{baseRef}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
        >
          <ComboboxSearchInput
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search refs..."
            value={query}
          />
          <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
            <span aria-hidden="true" />
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
              <span>Branch</span>
              <span className="text-right">Remote</span>
            </div>
          </div>
          {failed === undefined ? null : (
            <p className="px-3 py-2 text-2xs text-error/80" role="alert">
              {`Could not read refs: ${failed}`}
            </p>
          )}
          {failed === undefined ? <ComboboxEmpty>No matching refs.</ComboboxEmpty> : null}
          <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
            <ComboboxItem
              className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
              value={AUTOMATIC_BASE_REF}
            >
              <span className="block min-w-0 truncate">Automatic</span>
            </ComboboxItem>
            {choices.map((choice) => {
              const item = valueFor(choice);
              const hasBoth = choice.local !== null && choice.remote !== null;
              const useRemote = choice.remote?.name === item;
              return (
                <ComboboxItem
                  className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                  key={choice.id}
                  value={item}
                >
                  <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                    <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                    {hasBoth ? (
                      <div
                        className="flex justify-end"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <Switch
                          aria-label={`Use remote version of ${choice.label}`}
                          checked={useRemote}
                          className="[--thumb-size:--spacing(3)]"
                          onCheckedChange={(checked) => {
                            const next = checked ? choice.remote?.name : choice.local?.name;
                            if (next) props.onSelect(next);
                          }}
                        />
                      </div>
                    ) : choice.remote ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="flex justify-end text-muted-foreground">
                              <CheckIcon aria-label="Remote only" className="size-3" role="img" />
                            </span>
                          }
                        />
                        <TooltipPopup side="top">Remote only</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                </ComboboxItem>
              );
            })}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
