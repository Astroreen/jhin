// The diff panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/DiffPanel.tsx
<<<<<<< HEAD
// (the scope menu, the "head → base" label, the header's controls and its empty states),
// DiffPanelShell.tsx (the inline panel and its loading skeleton) and chat/DiffStatLabel.tsx;
// the turn scopes ("Latest turn", "Turn N") follow DiffPanel.tsx at the same commit.
// T3 renders files with @pierre/diffs; here a stacked view of the unified diff stands in.
import type { NodeTarget } from "@jhin/client-api";
import type { Diff, ProjectStatus } from "@jhin/source-control-api";
=======
// (the scope menu, the header's controls, the file view and its empty states), DiffPanelShell.tsx
// (the inline panel and its loading skeleton), DiffFilePathCopyButton.tsx, lib/diffCollapse.ts,
// diffs/useCodeViewFileReveal.ts and chat/DiffStatLabel.tsx.
import type { NodeTarget } from "@jhin/client-api";
import type { DiffScopeContext, DiffScopeResult, ProjectStatus } from "@jhin/source-control-api";
import type { CodeViewDiffItem, CodeViewScrollTarget, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)
import {
  Button,
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Skeleton,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
  copyText,
} from "@jhin/ui";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  CopyIcon,
  FolderTreeIcon,
  PilcrowIcon,
  RefreshCwIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

<<<<<<< HEAD
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
import { useSourceControl, type SourceControlServices, DIFF_PANEL } from "./services.ts";

=======
import { useCatalog, useExternal } from "../../lib/hooks.ts";
import { formatCompactDiffCount } from "../../lib/pull-request.ts";
import { DIFF_SECTION, DiffSettings, useSection } from "../../lib/settings.ts";
import { BaseRefPicker } from "./diff/base-ref-picker.tsx";
import { StyledDiffCodeView } from "./diff/code-view.tsx";
import { diffFileTreeEntries } from "./diff/file-tree-logic.ts";
import { DiffFileTree } from "./diff/file-tree.tsx";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  fnv1a32,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  PREFERRED_HIGHLIGHTER,
} from "./diff/rendering.ts";
import { selectionKey, useScopeEntries, type ScopeEntry } from "./diff/scopes.ts";
import { useResolvedTheme } from "./diff/theme.ts";
import { DIFF_PANEL, useSourceControl, type SourceControlServices } from "./services.ts";

const DIFF_FILE_TREE_STORAGE_KEY = "jhin.diffFileTreeOpen";

/** T3's DiffStatLabel, inline layout. */
function DiffStatLabel(props: { additions: number; deletions: number; className?: string }) {
  return (
    <span
      aria-label={`${props.additions} additions, ${props.deletions} deletions`}
      className={cn("inline-flex items-center gap-1 tabular-nums align-middle", props.className)}
      role="group"
    >
      <span aria-hidden="true" className="font-mono text-diff-addition">
        +{formatCompactDiffCount(props.additions)}
      </span>
      <span aria-hidden="true" className="font-mono text-diff-deletion">
        -{formatCompactDiffCount(props.deletions)}
      </span>
    </span>
  );
}

>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)
function DiffFileHeaderSkeleton({ width }: { width: string }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2 pr-3">
      <div className="flex size-5 shrink-0 items-center justify-center">
        <Skeleton className="size-2.5" />
      </div>
      <Skeleton className="size-5 shrink-0" />
      <Skeleton className={cn("h-3", width)} shape="pill" />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Skeleton className="h-3 w-5" shape="pill" />
        <Skeleton className="h-3 w-5" shape="pill" />
      </div>
    </div>
  );
}

function DiffCodeLineSkeleton({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="h-2.5 w-5 shrink-0" shape="pill" />
      <Skeleton className={cn("h-2.5", width)} shape="pill" />
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
      <div className="flex h-6 items-center gap-2 px-2 pr-3">
        <div className="h-px flex-1 bg-border/40" />
        <Skeleton className="h-2.5 w-24" shape="pill" />
        <div className="h-px flex-1 bg-border/40" />
      </div>
      <div className="space-y-2 px-3 py-2">
        <DiffCodeLineSkeleton width="w-2/3" />
        <DiffCodeLineSkeleton width="w-4/5" />
        <DiffCodeLineSkeleton width="w-3/5" />
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

/** T3's inline DiffPanelShell. */
function DiffPanelShell(props: { header?: React.ReactNode; children: React.ReactNode }) {
  return (
    <aside
      aria-label="Diff panel"
      className="flex h-full w-[42vw] min-w-[360px] max-w-[560px] shrink-0 flex-col border-l border-border bg-background"
      data-diff-panel
    >
      <div className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4">
        {props.header}
      </div>
      {props.children}
    </aside>
  );
}

function DiffFilePathCopyButton({ filePath }: { filePath: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy file path"
            onClick={() => void copyText(filePath).then(() => setCopied(true))}
            size="icon-micro"
            variant="ghost-muted"
          />
        }
      >
        {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{copied ? "Copied" : "Copy path"}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

function DiffFileCollapseToggle(props: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  iconClassName: string;
  onToggle(fileKey: string): void;
}) {
  const { filePath, collapsed } = props;
  const Icon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            className="-ms-0.5"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle(props.fileKey);
            }}
            size="icon-micro"
            variant="ghost"
          />
        }
      >
        <Icon className={cn("size-4", props.iconClassName)} />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}

function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/** Scrolls the viewer to a file once it holds it (T3's useCodeViewFileReveal). */
function useCodeViewFileReveal<TScope>(
  viewer: FileRevealHandle | null,
  scope: TScope,
  readyFileKeys: ReadonlyArray<string>,
) {
  const [request, setRequest] = useState<{ fileKey: string; scope: TScope } | null>(null);
  const handledRequest = useRef<typeof request>(null);
  useEffect(() => {
    if (request === null || handledRequest.current === request) return;
    if (request.scope !== scope) {
      handledRequest.current = request;
      return;
    }
    if (!viewer?.getInstance() || !readyFileKeys.includes(request.fileKey)) return;
    viewer.scrollTo({ type: "item", id: request.fileKey, align: "start" });
    handledRequest.current = request;
  }, [request, scope, viewer, readyFileKeys]);
  return (fileKey: string) => setRequest({ fileKey, scope });
}

const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();
function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

function readFileTreeOpen(): boolean {
  try {
    return localStorage.getItem(DIFF_FILE_TREE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** The scope menu: every provider's options, grouped ones in a submenu (T3's "Turn"). */
function ScopeMenu(props: {
  entries: readonly ScopeEntry[];
  selected: ScopeEntry | undefined;
  onSelect(value: string): void;
}) {
  const { entries, selected } = props;
  const label = selected?.option.label ?? "Changes";
  const value = selected?.option.value ?? "";
  const groups: string[] = [];
  for (const { option } of entries) {
    if (option.group !== undefined && !groups.includes(option.group)) groups.push(option.group);
  }
  return (
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
        <MenuRadioGroup onValueChange={(next) => props.onSelect(String(next))} value={value}>
          {entries
            .filter(({ option }) => option.group === undefined)
            .map(({ option }) => (
              <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                <span>{option.label}</span>
              </MenuRadioItem>
            ))}
        </MenuRadioGroup>
        {groups.map((group) => (
          <MenuSub key={group}>
            <MenuSubTrigger>{group}</MenuSubTrigger>
            <MenuSubPopup>
              <MenuGroup>
                <MenuRadioGroup
                  onValueChange={(next) => props.onSelect(String(next))}
                  value={value}
                >
                  {entries
                    .filter(({ option }) => option.group === group)
                    .map(({ option }) => (
                      <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                          <span>{option.label}</span>
                          {option.detail === undefined ? null : (
                            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                              {option.detail}
                            </span>
                          )}
                        </span>
                      </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
              </MenuGroup>
            </MenuSubPopup>
          </MenuSub>
        ))}
      </MenuPopup>
    </Menu>
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
<<<<<<< HEAD
  const { store, threads, navigation, selections } = services;
=======
  const { store, threads, navigation, scopes, selections } = services;
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)

  function Panel(props: {
    target: NodeTarget;
    projectId: string;
    threadId: string | undefined;
    status: ProjectStatus | undefined;
  }) {
    const { target, projectId, threadId, status } = props;
<<<<<<< HEAD
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
=======
    const resolvedTheme = useResolvedTheme();
    const settings = useSection(services.context, DIFF_SECTION, DiffSettings);
    const [wordWrap, setWordWrap] = useState(settings.wordWrap);
    const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.ignoreWhitespace);
    const [fileTreeOpen, setFileTreeOpenState] = useState(readFileTreeOpen);
    const setFileTreeOpen = (open: boolean) => {
      setFileTreeOpenState(open);
      try {
        localStorage.setItem(DIFF_FILE_TREE_STORAGE_KEY, String(open));
      } catch {
        // Blocked storage: the choice lasts for this page only.
      }
    };
    const [collapsedFiles, setCollapsedFiles] = useState<{
      scopeKey: string | null;
      fileKeys: ReadonlySet<string>;
    }>({ scopeKey: null, fileKeys: EMPTY_KEYS });
    const [codeViewRevision, setCodeViewRevision] = useState(0);
    const [codeView, setCodeView] = useState<CodeViewHandle<undefined, undefined> | null>(null);
    const [reveal, setReveal] = useState<{ path: string; id: number } | null>(null);
    const [version, setVersion] = useState(0);
    const [refreshing, setRefreshing] = useState(false);

    const scopeContext: DiffScopeContext = {
      target,
      projectId,
      ...(threadId === undefined ? {} : { threadId }),
    };
    const key = selectionKey(scopeContext);
    const entries = useScopeEntries(scopes, scopeContext, key);
    const selection = useExternal(selections, () => selections.get(key));
    const selected = entries.find((entry) => entry.option.value === selection.value) ?? entries[0];
    const base = selected?.option.baseRefs === true ? selection.base : undefined;
    const isRepo = status?.isRepo ?? true;

    // A provider says when its diffs change; the window regaining focus reads again (T3).
    const provider = selected?.provider;
    useEffect(() => {
      const subscription = provider?.subscribe?.(scopeContext, () => setVersion((v) => v + 1));
      return () => subscription?.dispose();
      // The context is the key.
    }, [provider, key]);
    useEffect(() => {
      const refreshOnFocus = () => setVersion((v) => v + 1);
      window.addEventListener("focus", refreshOnFocus);
      return () => window.removeEventListener("focus", refreshOnFocus);
    }, []);

    const [state, setState] = useState<{
      key: string;
      what: string;
      result?: DiffScopeResult;
      error?: string;
    }>({ key: "", what: "" });
    // What is shown; a diff read again for the same selection keeps the last one until it arrives.
    const what = JSON.stringify([
      key,
      provider?.id,
      selected?.option.value,
      base,
      ignoreWhitespace,
    ]);
    // Read again whenever the project's status changes on its node, as before.
    const loadKey = JSON.stringify([what, status?.checkedAt, version]);
    useEffect(() => {
      if (!isRepo || selected === undefined) return;
      let current = true;
      void selected.provider
        .load(scopeContext, selected.option.value, {
          ignoreWhitespace,
          ...(base === undefined ? {} : { base }),
        })
        .then(
          (result) => current && setState({ key: loadKey, what, result }),
          (error: unknown) =>
            current &&
            // A failed refresh keeps the diff it had (a transient error at window focus).
            setState((previous) => ({
              key: loadKey,
              what,
              error: (error as Error).message,
              ...(previous.what === what && previous.result !== undefined
                ? { result: previous.result }
                : {}),
            })),
        );
      return () => {
        current = false;
      };
    }, [loadKey, isRepo]);

    const scopeTitle = selected?.option.label ?? "Changes";
    const reviewSectionId = `${provider?.id ?? ""}:${selected?.option.value ?? ""}`;
    const collapseScopeKey = `${key}:${reviewSectionId}`;
    const codeViewMountKey = `${collapseScopeKey}:${codeViewRevision}`;
    const result = state.what === what ? state.result : undefined;
    const error = state.what === what ? state.error : undefined;
    const loading = state.key !== loadKey && result === undefined && error === undefined;
    const renderablePatch = getRenderablePatch(result?.patch, `diff-panel:${resolvedTheme}`, {
      compactPartialHunkOffsets: true,
    });
    const hasNoNetChanges = result !== undefined && result.patch.trim().length === 0;
    const renderableFiles = renderablePatch?.kind === "files" ? renderablePatch.files : [];
    const renderableFileEntries = renderableFiles.map(getCachedFileEntry);
    const diffFileKeys = renderableFileEntries.map((file) => file.fileKey);
    const defaultCollapsed = settings.filesCollapsed ? new Set(diffFileKeys) : EMPTY_KEYS;
    const collapsedKeys =
      collapsedFiles.scopeKey === collapseScopeKey ? collapsedFiles.fileKeys : defaultCollapsed;
    const allCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedKeys);
    const fileTreeEntries = diffFileTreeEntries(renderableFiles);
    const items: CodeViewDiffItem<undefined>[] = renderableFileEntries.map(
      ({ fileDiff, fileKey, fileVersion }) => {
        const collapsed = collapsedKeys.has(fileKey);
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          collapsed,
          version: fnv1a32(`${fileVersion}:${collapsed ? "1" : "0"}`),
        };
      },
    );

    const toggleFile = (fileKey: string) =>
      setCollapsedFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsed,
        );
        if (!next.delete(fileKey)) next.add(fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    const toggleAll = () => {
      setCodeViewRevision((current) => current + 1);
      setCollapsedFiles({
        scopeKey: collapseScopeKey,
        fileKeys: allCollapsed ? new Set() : new Set(diffFileKeys),
      });
    };
    const requestTreeReveal = useCodeViewFileReveal(codeView, collapseScopeKey, diffFileKeys);
    const revealFile = (filePath: string) => {
      const file = renderableFileEntries.find(
        (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
      );
      if (!file) return;
      setReveal((current) => ({ path: filePath, id: (current?.id ?? 0) + 1 }));
      setCollapsedFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsed,
        );
        next.delete(file.fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
      requestTreeReveal(file.fileKey);
    };
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)
    const refresh = () => {
      if (scope === "turn") {
        setReloads((count) => count + 1);
        return;
      }
      setRefreshing(true);
      void store.refresh(target, projectId).finally(() => {
        setRefreshing(false);
        setVersion((v) => v + 1);
      });
    };
<<<<<<< HEAD
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
=======
    const selectScope = (value: string) => selections.update(key, { value });
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)

    const header = (
      <>
        <div className="flex min-w-0 flex-1 items-center gap-3">
<<<<<<< HEAD
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
=======
          <ScopeMenu entries={entries} onSelect={selectScope} selected={selected} />
          {selected?.option.baseRefs === true && result?.baseRef ? (
            <BaseRefPicker
              baseRef={result.baseRef}
              headRef={result.headRef}
              onSelect={(next) => selections.update(key, { base: next })}
              projectId={projectId}
              selected={selection.base}
              target={target}
              threads={threads}
            />
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {result !== undefined && renderableFiles.length > 0 ? (
            <DiffStatLabel
              additions={result.insertions}
              className="mr-1 text-2xs"
              deletions={result.deletions}
            />
          ) : null}
          {isRepo ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={refreshing ? "Refreshing diff" : "Refresh diff"}
                    onClick={refresh}
                    size="icon-sm"
                    type="button"
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
          ) : null}
          {diffFileKeys.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
                    onClick={toggleAll}
                    size="icon-sm"
                    type="button"
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
          <ToggleGroup
            aria-label="Diff layout"
            className="shrink-0"
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                services.settings?.patch(DIFF_SECTION, { layout: next });
              }
            }}
            value={[settings.layout]}
            variant="segmented"
          >
            <ToggleGroupItem aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Split diff view" value="split">
              <Columns2Icon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                  onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
                  pressed={wordWrap}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              <TextWrapIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
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
          {diffFileKeys.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                    onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                    pressed={fileTreeOpen}
                    size="sm"
                    variant="ghost"
                  />
                }
              >
                <FolderTreeIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {fileTreeOpen ? "Hide file tree" : "Show file tree"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </>
    );

<<<<<<< HEAD
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
=======
    let body: React.ReactNode;
    if (!isRepo) {
      body = (
        <EmptyState>
          Turn diffs are unavailable because this project is not a git repository.
        </EmptyState>
      );
    } else if (renderablePatch === null) {
      body = (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {error === undefined ? null : (
            <div className="px-3">
              <p className="mb-2 text-2xs text-error/80">{error}</p>
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)
            </div>
          )}
          {loading ? (
            <DiffPanelLoadingState
              label={
                selected?.option.value === "uncommitted"
                  ? "Loading uncommitted changes..."
                  : "Loading changes..."
              }
            />
          ) : error === undefined ? (
            <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
              <p>
                {hasNoNetChanges
                  ? "No net changes in this selection."
                  : "No patch available for this selection."}
              </p>
            </div>
          ) : null}
        </div>
      );
    } else if (renderablePatch.kind === "raw") {
      body = (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="space-y-2">
            <p className="text-2xs text-muted-foreground/75">{renderablePatch.reason}</p>
            <pre
              className={cn(
                "max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90",
                wordWrap && "whitespace-pre-wrap wrap-break-word",
              )}
            >
              {renderablePatch.text}
            </pre>
          </div>
        </div>
      );
    } else {
      body = (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {error === undefined ? null : (
            <p className="shrink-0 border-b border-border/70 px-3 py-1.5 text-2xs text-error/80">
              {error}
            </p>
          )}
          {result?.truncated ? (
            <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
              This preview exceeds the size limit. Changes shown are incomplete. Totals include all
              changes.
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div
              className="min-h-0 min-w-0 flex-1"
              data-diff-files
              onClickCapture={(event) => {
                const composedPath = event.nativeEvent.composedPath?.() ?? [];
                for (const node of composedPath) {
                  // Header controls keep their own actions. In particular, the chevron must
                  // not also trigger the row handler or the two toggles cancel each other.
                  if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                    return;
                  }
                }
                const fileHeader = composedPath.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                );
                const headerFilePath = fileHeader?.querySelector("[data-title]")?.textContent;
                if (!headerFilePath) return;
                const file = renderableFileEntries.find(
                  (candidate) => resolveFileDiffPath(candidate.fileDiff) === headerFilePath,
                );
                if (file) toggleFile(file.fileKey);
              }}
            >
              <StyledDiffCodeView<undefined>
                className="h-full min-h-0 overflow-auto"
                items={items}
                key={codeViewMountKey}
                options={{
                  diffStyle: settings.layout === "split" ? "split" : "unified",
                  lineDiffType: "none",
                  overflow: wordWrap ? "wrap" : "scroll",
                  theme: resolveDiffThemeName(resolvedTheme),
                  preferredHighlighter: PREFERRED_HIGHLIGHTER,
                  themeType: resolvedTheme,
                  stickyHeaders: true,
                }}
                renderHeaderFilenameSuffix={(item) =>
                  item.type === "diff" ? (
                    <DiffFilePathCopyButton filePath={resolveFileDiffPath(item.fileDiff)} />
                  ) : null
                }
                renderHeaderPrefix={(item) =>
                  item.type === "diff" ? (
                    <DiffFileCollapseToggle
                      collapsed={item.collapsed === true}
                      fileKey={item.id}
                      filePath={resolveFileDiffPath(item.fileDiff)}
                      iconClassName={getDiffCollapseIconClassName(item.fileDiff)}
                      onToggle={toggleFile}
                    />
                  ) : null
                }
                viewerRef={setCodeView}
              />
            </div>
            {fileTreeOpen ? (
              <aside className="flex w-[min(16rem,40%)] min-w-40 shrink-0 border-l border-border/60">
                <DiffFileTree
                  ariaLabel={`${scopeTitle} files`}
                  entries={fileTreeEntries}
                  onSelectFile={revealFile}
                  revealRequestId={reveal?.id ?? 0}
                  selectedPath={reveal?.path ?? null}
                />
              </aside>
            ) : null}
          </div>
        </div>
      );
    }

    return <DiffPanelShell header={header}>{body}</DiffPanelShell>;
  }

  /** The panel docked right of the chat (`app.panel`), open while the route's panel is `diff`. */
  function DiffPanel() {
    const route = useExternal(navigation, navigation.current);
    if (route.panel !== DIFF_PANEL || route.node === undefined) return null;
    const target: NodeTarget = {
      node: route.node,
      ...(route.remote === undefined ? {} : { remote: route.remote }),
    };
    return <PanelFor project={route.project} target={target} thread={route.thread} />;
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
        <DiffPanelShell>
          <EmptyState>Select a thread to inspect turn diffs.</EmptyState>
        </DiffPanelShell>
      );
    }
    return (
      <Panel
        key={`${JSON.stringify(props.target)}|${projectId}|${props.thread ?? ""}`}
        projectId={projectId}
        status={view.projects.get(projectId)}
        target={props.target}
<<<<<<< HEAD
        threadId={props.thread}
=======
        threadId={props.project === undefined ? props.thread : undefined}
>>>>>>> be892adb (feat(web): render the diff panel with @pierre/diffs, as T3 Code does)
      />
    );
  }

  return DiffPanel;
}
