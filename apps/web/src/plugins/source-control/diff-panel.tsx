// The diff panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/DiffPanel.tsx
// (the scope menu, the "head → base" label, the header's controls and its empty states),
// DiffPanelShell.tsx (the inline panel and its loading skeleton) and chat/DiffStatLabel.tsx;
// the turn scopes ("Latest turn", "Turn N") follow DiffPanel.tsx at the same commit.
// T3 renders files with @pierre/diffs; here a stacked view of the unified diff stands in.
import type { NodeTarget } from "@jhin/client-api";
import type { Diff, ProjectStatus } from "@jhin/source-control-api";
import {
  Button,
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Skeleton,
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  PilcrowIcon,
  RefreshCwIcon,
  TextWrapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parsePatch, type DiffFile } from "../../lib/diff.ts";
import { formatShortTimestamp } from "../../lib/format.ts";
import { useCatalog, useExternal } from "../../lib/hooks.ts";
import {
  DiffStatLabel,
  selectionKey,
  useDiffSelection,
  useThreadCheckpoints,
  type DiffSelection,
} from "./checkpoints.tsx";
import { useSourceControl, type SourceControlServices } from "./services.ts";

export const DIFF_PANEL = "diff";

function DiffFileHeaderSkeleton({ width }: { width: string }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2 pr-3">
      <Skeleton className="size-2.5" />
      <Skeleton className={cn("h-3", width)} shape="pill" />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Skeleton className="h-3 w-5" shape="pill" />
        <Skeleton className="h-3 w-5" shape="pill" />
      </div>
    </div>
  );
}

function DiffPanelLoadingState({ label }: { label: string }) {
  return (
    <div
      aria-label={label}
      aria-live="polite"
      className="min-h-0 flex-1 overflow-hidden bg-background"
      role="status"
    >
      <DiffFileHeaderSkeleton width="w-1/2 max-w-64" />
      <div className="space-y-2 px-3 py-2">
        <Skeleton className="h-2.5 w-2/3" shape="pill" />
        <Skeleton className="h-2.5 w-4/5" shape="pill" />
        <Skeleton className="h-2.5 w-3/5" shape="pill" />
      </div>
      <DiffFileHeaderSkeleton width="w-2/5 max-w-52" />
      <DiffFileHeaderSkeleton width="w-3/5 max-w-72" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
      {children}
    </div>
  );
}

const LINE_CLASS = {
  context: "",
  add: "bg-diff-addition/10",
  delete: "bg-diff-deletion/10",
  note: "text-muted-foreground/70 italic",
} as const;

function FileDiff(props: { file: DiffFile; collapsed: boolean; wrap: boolean; onToggle(): void }) {
  const { file, collapsed, wrap } = props;
  const name = file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`;
  return (
    <section
      aria-label={file.path}
      className="border-b border-border/60"
      data-diff-file={file.path}
    >
      <button
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
        className="sticky top-0 z-10 flex h-8 w-full cursor-pointer items-center gap-2 border-b border-border/40 bg-background/95 px-2 pr-3 text-left text-xs backdrop-blur-sm hover:bg-accent/60"
        onClick={props.onToggle}
        type="button"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono" data-title>
          {name}
        </span>
        {file.change === "added" || file.change === "deleted" ? (
          <span className="shrink-0 text-3xs text-muted-foreground/60 uppercase">
            {file.change}
          </span>
        ) : null}
        <DiffStatLabel additions={file.insertions} deletions={file.deletions} />
      </button>
      {collapsed ? null : file.binary ? (
        <p className="px-3 py-2 text-2xs text-muted-foreground/75">Binary file not shown.</p>
      ) : (
        <div className={cn("font-mono text-2xs leading-5", wrap ? "" : "overflow-x-auto")}>
          <table className="w-full border-collapse">
            <tbody>
              {file.hunks.map((hunk, hunkIndex) => [
                <tr className="bg-muted/40 text-muted-foreground/80" key={`h${hunkIndex}`}>
                  <td className="w-10 select-none" />
                  <td className="w-10 select-none" />
                  <td className="px-2">{hunk.header}</td>
                </tr>,
                ...hunk.lines.map((line, lineIndex) => (
                  <tr
                    className={LINE_CLASS[line.kind]}
                    data-line={line.kind}
                    key={`${hunkIndex}:${lineIndex}`}
                  >
                    <td className="w-10 select-none pr-1 text-right align-top text-muted-foreground/50 tabular-nums">
                      {line.oldLine ?? ""}
                    </td>
                    <td className="w-10 select-none pr-1 text-right align-top text-muted-foreground/50 tabular-nums">
                      {line.newLine ?? ""}
                    </td>
                    <td
                      className={cn(
                        "px-2",
                        wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                        line.kind === "add" && "text-diff-addition-foreground",
                        line.kind === "delete" && "text-diff-deletion-foreground",
                      )}
                    >
                      <span aria-hidden className="select-none">
                        {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}
                      </span>
                      {line.text}
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The label of the scope menu's trigger, as T3's DiffPanel names the selection. */
function scopeLabel(
  selection: DiffSelection,
  turn: number | undefined,
  latest: number | undefined,
) {
  if (selection.kind === "branch") return "Changes";
  if (selection.kind === "uncommitted") return "Uncommitted";
  return turn === undefined || turn === latest ? "Latest turn" : `Turn ${turn}`;
}

export function createDiffPanel(services: SourceControlServices) {
  const { store, threads, navigation, selections } = services;

  function Panel(props: {
    target: NodeTarget;
    projectId: string;
    threadId: string | undefined;
    status: ProjectStatus | undefined;
  }) {
    const { target, projectId, threadId, status } = props;
    const key = selectionKey(target, { thread: threadId, project: projectId });
    const selection = useDiffSelection(selections, key);
    const timestampFormat = services.timestampFormat();
    const checkpoints = useThreadCheckpoints(services, target, threadId ?? "");
    // Newest first, as T3 lists them; only turns whose checkpoint can be diffed.
    const turns = (threadId === undefined ? [] : (checkpoints ?? []))
      .filter((checkpoint) => checkpoint.status === "ready")
      .toSorted((a, b) => b.turn - a.turn);
    const latest = turns[0];
    const selectedTurn =
      selection.kind !== "turn"
        ? undefined
        : (turns.find((checkpoint) => checkpoint.turn === selection.turn) ?? latest);
    const [wrap, setWrap] = useState(false);
    const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [state, setState] = useState<{
      key: string;
      /** The scope the answer is for: another scope's diff is never shown under this one. */
      scope?: DiffSelection["kind"];
      diff?: Diff;
      error?: string;
    }>({ key: "" });
    const [refreshing, setRefreshing] = useState(false);
    const [reloads, setReloads] = useState(0);
    const isRepo = status?.isRepo ?? true;
    const scope = selection.kind;
    // A git scope is read again whenever the project's status changes on its node, a turn
    // when its checkpoint does.
    const fetchKey = JSON.stringify([
      target,
      projectId,
      threadId,
      scope,
      ignoreWhitespace,
      scope === "turn"
        ? [selectedTurn?.turn, selectedTurn?.capturedAt, reloads]
        : status?.checkedAt,
    ]);
    const waitingForTurns = scope === "turn" && checkpoints === undefined && threadId !== undefined;
    useEffect(() => {
      if (!isRepo || waitingForTurns) return;
      if (scope === "turn" && selectedTurn === undefined) return;
      let current = true;
      const request =
        scope === "turn"
          ? { threadId, scope, turn: selectedTurn!.turn, ignoreWhitespace }
          : { projectId, scope, ignoreWhitespace };
      void threads.call<Diff>(target, "git.diff", request).then(
        (diff) => current && setState({ key: fetchKey, scope, diff }),
        (error: unknown) =>
          current && setState({ key: fetchKey, scope, error: (error as Error).message }),
      );
      return () => {
        current = false;
      };
    }, [fetchKey, isRepo, waitingForTurns]);

    // A git scope keeps showing its last diff while the status that changed is read
    // again; a turn, or another scope, waits for its own.
    const diff =
      state.key === fetchKey || (scope !== "turn" && state.scope === scope)
        ? state.diff
        : undefined;
    const files = diff === undefined ? [] : parsePatch(diff.patch);
    const loading = waitingForTurns || (state.key !== fetchKey && diff === undefined);
    const allCollapsed = files.length > 0 && files.every((file) => collapsed.has(file.path));
    const refresh = () => {
      if (scope === "turn") {
        setReloads((count) => count + 1);
        return;
      }
      setRefreshing(true);
      void store.refresh(target, projectId).finally(() => setRefreshing(false));
    };
    // A file opened from a turn's changed files card is shown, unfolded.
    const filesRef = useRef<HTMLDivElement>(null);
    const reveal = selection.kind === "turn" ? selection.filePath : undefined;
    const revealRequest = selection.kind === "turn" ? selection.reveal : 0;
    const revealed = reveal !== undefined && files.some((file) => file.path === reveal);
    useEffect(() => {
      if (reveal === undefined || !revealed) return;
      setCollapsed((previous) => {
        if (!previous.has(reveal)) return previous;
        const next = new Set(previous);
        next.delete(reveal);
        return next;
      });
      filesRef.current
        ?.querySelector(`[data-diff-file="${CSS.escape(reveal)}"]`)
        ?.scrollIntoView({ block: "start" });
    }, [reveal, revealRequest, revealed]);
    const select = (next: DiffSelection) => selections.set(key, next);
    const selectValue = (value: string) => {
      if (value === "branch" || value === "uncommitted") select({ kind: value });
      else if (value === "latest") select({ kind: "turn", reveal: 0 });
      else if (value.startsWith("turn:")) {
        select({ kind: "turn", turn: Number(value.slice(5)), reveal: 0 });
      }
    };
    const label = scopeLabel(selection, selectedTurn?.turn, latest?.turn);
    const scopeValue =
      selection.kind !== "turn"
        ? selection.kind
        : selectedTurn === undefined || selectedTurn.turn === latest?.turn
          ? "latest"
          : "";
    const turnValue = selectedTurn === undefined ? "" : `turn:${selectedTurn.turn}`;

    const header = (
      <>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Menu>
            <MenuTrigger
              aria-label={`Diff scope: ${label}`}
              className="max-w-full"
              render={<Button size="xs" variant="secondary" />}
            >
              <span className="truncate">{label}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuRadioGroup
                onValueChange={(value) => selectValue(String(value))}
                value={scopeValue}
              >
                <MenuRadioItem closeOnClick value="branch">
                  <span>Changes</span>
                </MenuRadioItem>
                <MenuRadioItem closeOnClick value="uncommitted">
                  <span>Uncommitted</span>
                </MenuRadioItem>
                {threadId === undefined ? null : (
                  <MenuRadioItem closeOnClick value="latest">
                    <span>Latest turn</span>
                  </MenuRadioItem>
                )}
              </MenuRadioGroup>
              {threadId === undefined ? null : (
                <MenuSub>
                  <MenuSubTrigger>Turn</MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup
                      onValueChange={(value) => selectValue(String(value))}
                      value={turnValue}
                    >
                      {turns.map((checkpoint) => (
                        <MenuRadioItem
                          closeOnClick
                          key={checkpoint.turnId}
                          value={`turn:${checkpoint.turn}`}
                        >
                          <span className="flex items-center gap-2">
                            <span>Turn {checkpoint.turn}</span>
                            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                              {formatShortTimestamp(checkpoint.capturedAt, timestampFormat)}
                            </span>
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
              )}
            </MenuPopup>
          </Menu>
          {scope === "branch" && diff?.baseRef ? (
            <div
              aria-label={`Comparing ${diff.headRef ?? "HEAD"} against ${diff.baseRef}`}
              className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            >
              <span className="min-w-0 max-w-48 truncate">{diff.headRef ?? "HEAD"}</span>
              <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 max-w-48 truncate">{diff.baseRef}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {diff !== undefined && diff.files.length > 0 ? (
            <DiffStatLabel
              additions={diff.insertions}
              className="mr-1 text-2xs"
              deletions={diff.deletions}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={refreshing ? "Refreshing diff" : "Refresh diff"}
                  onClick={refresh}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {refreshing ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
          {files.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
                    onClick={() =>
                      setCollapsed(
                        allCollapsed ? new Set() : new Set(files.map((file) => file.path)),
                      )
                    }
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                {allCollapsed ? (
                  <ChevronsUpDownIcon className="size-3.5" />
                ) : (
                  <ChevronsDownUpIcon className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allCollapsed ? "Expand all files" : "Collapse all files"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={wrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                  onPressedChange={(pressed) => setWrap(Boolean(pressed))}
                  pressed={wrap}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              <TextWrapIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {wrap ? "Disable line wrapping" : "Enable line wrapping"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={
                    ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                  }
                  onPressedChange={(pressed) => setIgnoreWhitespace(Boolean(pressed))}
                  pressed={ignoreWhitespace}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              <PilcrowIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </>
    );

    return (
      <aside
        aria-label="Diff panel"
        className="flex h-full w-[42vw] min-w-[360px] max-w-[560px] shrink-0 flex-col border-l border-border bg-background"
        data-diff-panel
      >
        <div className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4">
          {header}
        </div>
        {!isRepo ? (
          <EmptyState>
            Turn diffs are unavailable because this project is not a git repository.
          </EmptyState>
        ) : scope === "turn" && checkpoints !== undefined && selectedTurn === undefined ? (
          <EmptyState>No completed turns yet.</EmptyState>
        ) : loading ? (
          <DiffPanelLoadingState
            label={
              scope === "turn"
                ? "Loading checkpoint diff..."
                : scope === "uncommitted"
                  ? "Loading uncommitted changes..."
                  : "Loading changes..."
            }
          />
        ) : state.key === fetchKey && state.error !== undefined && diff === undefined ? (
          <div className="px-3 py-2">
            <p className="mb-2 text-2xs text-error/80">{state.error}</p>
          </div>
        ) : files.length === 0 ? (
          <EmptyState>No net changes in this selection.</EmptyState>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {diff?.truncated ? (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete. Totals include
                all changes.
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto" data-diff-files ref={filesRef}>
              {files.map((file) => (
                <FileDiff
                  collapsed={collapsed.has(file.path)}
                  file={file}
                  key={file.path}
                  onToggle={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(file.path)) next.add(file.path);
                      return next;
                    })
                  }
                  wrap={wrap}
                />
              ))}
            </div>
          </div>
        )}
      </aside>
    );
  }

  /** The panel docked right of the chat (`app.panel`), open while the route's panel is `diff`. */
  function DiffPanel() {
    const route = useExternal(navigation, navigation.current);
    if (route.panel !== DIFF_PANEL || route.node === undefined) return null;
    const target: NodeTarget = {
      node: route.node,
      ...(route.remote === undefined ? {} : { remote: route.remote }),
    };
    return <PanelFor target={target} thread={route.thread} project={route.project} />;
  }

  function PanelFor(props: {
    target: NodeTarget;
    thread?: string | undefined;
    project?: string | undefined;
  }) {
    const catalog = useCatalog(threads, props.target);
    const view = useSourceControl(store, props.target);
    const projectId =
      props.project ?? catalog?.threads.find((thread) => thread.id === props.thread)?.projectId;
    if (projectId === undefined) {
      return (
        <aside
          aria-label="Diff panel"
          className="flex h-full w-[42vw] min-w-[360px] max-w-[560px] shrink-0 flex-col border-l border-border bg-background"
          data-diff-panel
        >
          <EmptyState>Select a thread to inspect turn diffs.</EmptyState>
        </aside>
      );
    }
    return (
      <Panel
        key={`${JSON.stringify(props.target)}|${projectId}|${props.thread ?? ""}`}
        projectId={projectId}
        status={view.projects.get(projectId)}
        target={props.target}
        threadId={props.thread}
      />
    );
  }

  return DiffPanel;
}
