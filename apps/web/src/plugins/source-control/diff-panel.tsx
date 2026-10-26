// The diff panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/DiffPanel.tsx
// (the scope menu, the header's controls, the file view and its empty states), DiffPanelShell.tsx
// (the inline panel and its loading skeleton), DiffFilePathCopyButton.tsx, lib/diffCollapse.ts,
// diffs/useCodeViewFileReveal.ts and chat/DiffStatLabel.tsx.
import type { MessageContextRecord, ReviewCommentContextRecord } from "@jhin/agent-api";
import type { ChatDrafts, NodeTarget, RightPanelSurfaceProps } from "@jhin/client-api";
import type { DiffScopeContext, DiffScopeResult, ProjectStatus } from "@jhin/source-control-api";
import type {
  CodeViewDiffItem,
  CodeViewLineSelection,
  CodeViewScrollTarget,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  Button,
  ContextMenu,
  ContextMenuTrigger,
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
import { z } from "@jhin/sdk";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useCatalog, useCommands, useExternal } from "../../lib/hooks.ts";
import { DIFF_SECTION, DiffSettings, useSection } from "../../lib/settings.ts";
import { DiffStatLabel } from "./checkpoints.tsx";
import { BaseRefPicker } from "./diff/base-ref-picker.tsx";
import { DiffComment, DiffCommentAnnotation } from "../../lib/comment-annotation.tsx";
import {
  annotationAnchor,
  restoreReviewCommentRange,
  reviewCommentRecord,
  buildDiffReviewComment,
  rangeInDiff,
  serializeReviewComment,
} from "./diff/review-comment.ts";
import {
  FileContextMenuPopup,
  preferredEditor,
  resolveDiffPathForWorkspace,
} from "./diff/editors.tsx";
import { StyledDiffCodeView } from "./diff/code-view.tsx";
import { diffFileContentsLoader } from "./diff/file-contents.ts";
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
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import {
  DIFF_PANEL,
  statusOfThread,
  useSourceControl,
  type SourceControlServices,
} from "./services.ts";

const DIFF_FILE_TREE_STORAGE_KEY = "jhin.diffFileTreeOpen";

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

/**
 * T3's DiffPanelShell: inline right of the chat, or `embedded` as a surface of the right panel
 * (t3-parity.md D1424), its header a subheader below the panel's strip.
 */
function DiffPanelShell(props: {
  header?: React.ReactNode;
  children: React.ReactNode;
  embedded: boolean;
}) {
  if (props.embedded) {
    return (
      <section
        aria-label="Diff panel"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-diff-panel
      >
        <div
          className="mb-3 flex h-7 min-h-7 shrink-0 items-center justify-between gap-2 px-2"
          data-surface-subheader=""
        >
          {props.header}
        </div>
        {props.children}
      </section>
    );
  }
  return (
    <aside
      aria-label="Diff panel"
      className="flex h-full w-[42vw] min-w-[360px] max-w-[560px] shrink-0 flex-col border-l border-border bg-background"
      data-diff-panel
    >
      <div className="drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 wco:pr-(--workspace-native-controls-inset)">
        {props.header}
      </div>
      {props.children}
    </aside>
  );
}

function DiffFilePathCopyButton({
  filePath,
  onFailed,
}: {
  filePath: string;
  /** The clipboard refused (an insecure page, a denied permission). */
  onFailed(): void;
}) {
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
            onClick={() =>
              void copyText(filePath).then(
                () => setCopied(true),
                () => onFailed(),
              )
            }
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

/**
 * What a comment's annotation carries: the draft being written, or a comment already in the
 * composer (D1285), with the range it is about as T3 labels it.
 */
type CommentDraft =
  | { readonly kind: "draft"; readonly rangeLabel: string }
  | {
      /** The comments that end on one line and side, as T3 groups them (D1459). */
      readonly kind: "comments";
      readonly entries: readonly CommentEntry[];
    };

interface CommentEntry {
  readonly rangeLabel: string;
  readonly contextId: string;
  readonly text: string;
}

/** The chat's command putting text into the open composer (W15, D473), the fallback. */
const COMPOSER_INSERT = "chat.composer.insert";
/** The chat's commands for a comment's record and its chip (D1284, D1286). */
const COMPOSER_INSERT_CONTEXT = "chat.composer.insert-context";
const COMPOSER_REMOVE_CONTEXT = "chat.composer.remove-context";
const InsertAnswer = z.object({
  inserted: z.boolean(),
  reason: z.enum(["no-composer", "not-now", "full"]).optional(),
});

/** A diff comment's record in a message: not a `#` pull request, nor a file's own lines. */
function isDiffComment(record: MessageContextRecord): record is ReviewCommentContextRecord {
  if (record.kind !== "review-comment" || !("sectionId" in record)) return false;
  const comment = record as ReviewCommentContextRecord;
  return comment.pullRequest === undefined && (comment.fenceLanguage ?? "diff") === "diff";
}

/** One subscription function per drafts service, so a render does not subscribe again. */
const draftSubscriptions = new WeakMap<ChatDrafts, (listener: () => void) => () => void>();
const subscribeTo = (drafts: ChatDrafts | undefined) => {
  if (drafts === undefined) return noSubscription;
  let subscribe = draftSubscriptions.get(drafts);
  if (subscribe === undefined) {
    subscribe = (listener) => {
      const subscription = drafts.subscribe(listener);
      return () => subscription.dispose();
    };
    draftSubscriptions.set(drafts, subscribe);
  }
  return subscribe;
};
const noSubscription = () => () => undefined;

/** The review comments the thread's unsent message names, kept current (D1285). */
function useDraftComments(
  drafts: ChatDrafts | undefined,
  target: NodeTarget,
  threadId: string | undefined,
): readonly ReviewCommentContextRecord[] {
  const records = useSyncExternalStore(subscribeTo(drafts), () =>
    drafts === undefined || threadId === undefined
      ? EMPTY_RECORDS
      : drafts.contexts(target, threadId),
  );
  return records.filter(isDiffComment);
}
const EMPTY_RECORDS: readonly MessageContextRecord[] = [];

export function createDiffPanel(services: SourceControlServices) {
  const { store, threads, navigation, scopes, selections } = services;

  function Panel(props: {
    embedded: boolean;
    target: NodeTarget;
    projectId: string;
    threadId: string | undefined;
    /** The project's folder on its node. */
    projectPath: string | undefined;
    status: ProjectStatus | undefined;
  }) {
    const { target, projectId, threadId, status } = props;
    const editors = services.editors.useEditors(target);
    const revealKind = services.editors.useRevealKind(target);
    const [menuPath, setMenuPath] = useState<string | null>(null);
    /** A diff's path within the project's folder; none outside it (D287). */
    const workspacePath = (filePath: string) =>
      resolveDiffPathForWorkspace({
        filePath,
        workspaceRoot: props.projectPath,
        repositoryRoot: status?.root,
      });
    /**
     * T3's primary action on a file's name: the preferred editor opens it.
     * False when nothing can (no editor, a file outside the project, D287).
     */
    const openDiffFile = (filePath: string) => {
      const path = workspacePath(filePath);
      if (path === null) return false;
      // In the right panel the file opens beside the diff, in T3's file panel (D1433).
      const panel = services.rightPanel;
      if (props.embedded && panel !== undefined) {
        panel.open(
          {
            target,
            ...(threadId === undefined ? { projectId } : { threadId }),
          },
          { kind: "file", resource: path },
        );
        return true;
      }
      const editor = preferredEditor(editors);
      if (editor === undefined) return false;
      void services.editors.open(target, projectId, path, editor);
      return true;
    };
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
    const [codeView, setCodeView] = useState<CodeViewHandle<CommentDraft, undefined> | null>(null);
    // T3's comment on lines (D285): one draft at a time, sent into the composer.
    const [draft, setDraft] = useState<{
      /** The selection the draft was opened under; another closes it. */
      what: string;
      /** Tells this draft from a later one, so an answer reaches only its own. */
      id: number;
      sectionId: string;
      sectionTitle: string;
      fileKey: string;
      filePath: string;
      fileDiff: FileDiffMetadata;
      range: SelectedLineRange;
      rangeLabel: string;
    } | null>(null);
    const [draftText, setDraftText] = useState("");
    /** The draft whose comment is on its way to the composer, if one is. */
    const [sending, setSending] = useState<number | null>(null);
    const drafts = useRef(0);
    const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
    // Without a composer to put a comment in (no chat plugin), lines take none.
    const commandsNow = useCommands(services.context);
    const asRecord = commandsNow.some((command) => command.name === COMPOSER_INSERT_CONTEXT);
    const canComment = asRecord || commandsNow.some((command) => command.name === COMPOSER_INSERT);
    const draftComments = useDraftComments(services.drafts, target, threadId);
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
      // A provider's `load` that throws at once takes the same path as one that rejects.
      void Promise.resolve()
        .then(() =>
          selected.provider.load(scopeContext, selected.option.value, {
            ignoreWhitespace,
            ...(base === undefined ? {} : { base }),
          }),
        )
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
    }, [loadKey, isRepo, selected?.provider]);

    const scopeTitle = selected?.option.label ?? "Changes";
    const reviewSectionId = `${provider?.id ?? ""}:${selected?.option.value ?? ""}`;
    const collapseScopeKey = `${key}:${reviewSectionId}`;
    const codeViewMountKey = `${collapseScopeKey}:${codeViewRevision}`;
    const result = state.what === what ? state.result : undefined;
    // Pierre asks for a file's two sides to expand its unchanged lines (D921). The view
    // keeps one loader for its lifetime, so this one reads the diff shown when it is asked.
    const shownFiles = useRef<{ loadFile: DiffScopeResult["loadFile"]; key: string }>(undefined);
    useLayoutEffect(() => {
      shownFiles.current = { loadFile: result?.loadFile, key: state.key };
    });
    const [loadDiffFiles] = useState(() => (fileDiff: FileDiffMetadata) => {
      const shown = shownFiles.current;
      if (shown?.loadFile === undefined) {
        return Promise.reject(new Error("Diff file contents are unavailable for this selection."));
      }
      return diffFileContentsLoader(shown.loadFile, shown.key)(fileDiff);
    });
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
    const items: CodeViewDiffItem<CommentDraft>[] = renderableFileEntries.map(
      ({ fileDiff, fileKey, fileVersion }) => {
        const collapsed = collapsedKeys.has(fileKey);
        // The comments already in the message, under their lines while the diff still has them.
        const filePath = resolveFileDiffPath(fileDiff);
        // T3's appendAnnotationEntry: comments ending on the same line and side share one.
        const persisted: DiffLineAnnotation<CommentDraft>[] = [];
        for (const comment of draftComments) {
          if (comment.sectionId !== reviewSectionId || comment.filePath !== filePath) continue;
          const range = restoreReviewCommentRange(fileDiff, comment);
          if (range === null) continue;
          const anchor = annotationAnchor(fileDiff, range);
          const entry: CommentEntry = {
            rangeLabel: comment.rangeLabel,
            contextId: comment.contextId,
            text: comment.text,
          };
          const at = persisted.findIndex(
            (annotation) =>
              annotation.side === anchor.side && annotation.lineNumber === anchor.lineNumber,
          );
          const shared = at < 0 ? undefined : persisted[at]!.metadata;
          if (shared?.kind === "comments") {
            persisted[at] = {
              ...persisted[at]!,
              metadata: { kind: "comments", entries: [...shared.entries, entry] },
            };
          } else {
            persisted.push({ ...anchor, metadata: { kind: "comments", entries: [entry] } });
          }
        }
        const annotations: DiffLineAnnotation<CommentDraft>[] =
          draft?.fileKey === fileKey
            ? [
                ...persisted,
                {
                  // Under the selection's last line, whichever way it was dragged.
                  ...annotationAnchor(fileDiff, draft.range),
                  metadata: { kind: "draft", rangeLabel: draft.rangeLabel },
                },
              ]
            : persisted;
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          collapsed,
          annotations,
          version: fnv1a32(
            `${fileVersion}:${collapsed ? "1" : "0"}:${
              draft?.fileKey === fileKey ? `${draft.range.start}-${draft.range.end}` : ""
            }:${persisted.map((annotation) => (annotation.metadata.kind === "comments" ? annotation.metadata.entries.map((entry) => entry.contextId).join("+") : "")).join(",")}`,
          ),
        };
      },
    );
    /** Text of a draft closed by the diff (not by the user): the next draft starts with it. */
    const keptText = useRef("");
    const closeDraft = () => {
      // An answer still on its way belongs to the draft closed here, not to the next one.
      drafts.current += 1;
      setDraft(null);
      setDraftText("");
      setSelectedLines(null);
    };
    // A draft goes with what it was opened on: another scope, base or whitespace setting, or
    // a refresh that drops its file, closes it (its annotation would be gone, and with it Cancel).
    // A panel closed while a comment is on its way drops the answer.
    useEffect(
      () => () => {
        drafts.current += 1;
      },
      [],
    );
    const draftStale =
      draft !== null && (draft.what !== what || !diffFileKeys.includes(draft.fileKey));
    // A refresh that keeps the file but drops the lines: the draft has nowhere to show.
    const draftFile =
      draft === null || draftStale
        ? undefined
        : renderableFileEntries.find((file) => file.fileKey === draft.fileKey)?.fileDiff;
    const draftLost =
      draft !== null && draftFile !== undefined && !rangeInDiff(draftFile, draft.range);
    useEffect(() => {
      if (!draftStale) return;
      keptText.current = draftText;
      closeDraft();
    }, [draftStale]);
    /** The commented lines left the diff: say so, and let a new comment start. */
    const dropLostDraft = () => {
      keptText.current = draftText;
      services.toasts?.show({
        type: "info",
        title: "These lines are no longer in the diff",
        description: "Comment on them again where they are now; your text is kept.",
      });
      closeDraft();
    };
    useEffect(() => {
      if (draftLost) dropLostDraft();
    }, [draftLost]);
    /** Opens a comment under the lines chosen in the gutter. */
    const beginComment = (
      range: SelectedLineRange | null,
      item: CodeViewDiffItem<CommentDraft>,
    ) => {
      if (range === null) return;
      const filePath = resolveFileDiffPath(item.fileDiff);
      const comment = buildDiffReviewComment({
        sectionId: reviewSectionId,
        sectionTitle: scopeTitle,
        filePath,
        fileDiff: item.fileDiff,
        range,
        text: "",
      });
      if (comment === null) return;
      setDraftText(keptText.current);
      keptText.current = "";
      setDraft({
        what,
        id: ++drafts.current,
        sectionId: reviewSectionId,
        sectionTitle: scopeTitle,
        fileKey: item.id,
        filePath,
        fileDiff: item.fileDiff,
        range,
        rangeLabel: comment.rangeLabel,
      });
    };
    /** T3's "Delete comment": its chip and record leave the message (D1286). */
    const deleteComment = (metadata: CommentEntry) => {
      setSelectedLines(null);
      void services.context.commands
        .execute(COMPOSER_REMOVE_CONTEXT, { contextId: metadata.contextId })
        .catch((failure: unknown) =>
          services.toasts?.show({
            type: "error",
            title: "Could not delete the comment",
            description: failure instanceof Error ? failure.message : String(failure),
          }),
        );
    };
    /** Puts the comment into the composer as T3's review comment (D1284), or its text (D285). */
    const sendComment = (text: string) => {
      if (draft === null) return;
      if (draftStale) {
        // Its scope or file went a moment ago: the draft closes rather than sending nowhere.
        closeDraft();
        return;
      }
      // The file's diff as it is now: a refresh may have changed its lines since the draft opened.
      const fileDiff =
        renderableFileEntries.find((file) => file.fileKey === draft.fileKey)?.fileDiff ??
        draft.fileDiff;
      const comment = buildDiffReviewComment({
        sectionId: draft.sectionId,
        sectionTitle: draft.sectionTitle,
        filePath: draft.filePath,
        fileDiff,
        range: draft.range,
        text,
      });
      if (comment === null) {
        dropLostDraft();
        return;
      }
      const sent = draft.id;
      setSending(sent);
      // The answer belongs to this draft: a draft closed meanwhile (another scope) hears nothing.
      const current = () => drafts.current === sent;
      // A record and its chip where the chat takes them (D1284), else T3's text for a provider.
      void (
        asRecord
          ? services.context.commands.execute(COMPOSER_INSERT_CONTEXT, {
              record: reviewCommentRecord(comment, crypto.randomUUID()),
            })
          : services.context.commands.execute(COMPOSER_INSERT, {
              text: serializeReviewComment(comment),
            })
      )
        .then(
          (answer) => {
            if (!current()) return;
            const parsed = InsertAnswer.safeParse(answer);
            if (!parsed.success) {
              services.toasts?.show({
                type: "error",
                title: "Could not add the comment to the chat",
                description: "The composer gave an answer the panel does not understand.",
              });
              return;
            }
            if (parsed.data.inserted) {
              closeDraft();
              return;
            }
            if (parsed.data.reason === "full") {
              services.toasts?.show({
                type: "error",
                title: "Could not add the comment to the chat",
                description: "The message already holds as much context as it can take.",
              });
              return;
            }
            services.toasts?.show({
              type: "info",
              title: "No message box to add the comment to",
            });
          },
          (failure: unknown) => {
            if (!current()) return;
            services.toasts?.show({
              type: "error",
              title: "Could not add the comment to the chat",
              description: failure instanceof Error ? failure.message : String(failure),
            });
          },
        )
        .finally(() => setSending((now) => (now === sent ? null : now)));
    };

    const toggleFile = (fileKey: string) =>
      setCollapsedFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsed,
        );
        if (!next.delete(fileKey)) next.add(fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    // Find in the diff (D924) unfolds the file of the match it moves to; it can ask again
    // before the unfolded file reaches the view, so this never folds.
    const unfoldFile = (fileKey: string) =>
      setCollapsedFiles((current) => {
        const fileKeys =
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsed;
        if (!fileKeys.has(fileKey)) return current;
        const next = new Set(fileKeys);
        next.delete(fileKey);
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
    const refresh = () => {
      setRefreshing(true);
      void store.refresh(target, projectId).finally(() => {
        setRefreshing(false);
        setVersion((v) => v + 1);
      });
    };
    // A file asked for from outside (a turn's changed files card) is revealed once its diff holds it.
    const handledReveal = useRef<string | null>(null);
    const askedPath = selection.filePath;
    const askedReveal = `${selection.reveal ?? 0}:${askedPath ?? ""}`;
    const askedReady =
      askedPath !== undefined &&
      renderableFileEntries.some((file) => resolveFileDiffPath(file.fileDiff) === askedPath);
    useEffect(() => {
      if (!askedReady || askedPath === undefined || handledReveal.current === askedReveal) return;
      handledReveal.current = askedReveal;
      revealFile(askedPath);
    }, [askedReady, askedReveal]);
    const selectScope = (value: string) =>
      selections.update(key, { value, filePath: undefined, reveal: undefined });

    const header = (
      <>
        <div className="flex min-w-0 flex-1 items-center gap-3">
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
                const title = composedPath.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-title"),
                );
                // A name that opens nowhere folds its file, as the rest of the header does.
                const filePath = title?.textContent?.trim();
                if (filePath && openDiffFile(filePath)) return;
                const fileHeader = composedPath.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                );
                const headerFilePath = fileHeader
                  ?.querySelector("[data-title]")
                  ?.textContent?.trim();
                if (!headerFilePath) return;
                const file = renderableFileEntries.find(
                  (candidate) => resolveFileDiffPath(candidate.fileDiff) === headerFilePath,
                );
                if (file) toggleFile(file.fileKey);
              }}
              onContextMenuCapture={(event) => {
                const title = (event.nativeEvent.composedPath?.() ?? []).find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-title"),
                );
                const filePath = title?.textContent?.trim();
                const path = filePath ? workspacePath(filePath) : null;
                // Only a file's name has a menu, and only when there is something to open it with.
                if (path === null || editors.length === 0) {
                  event.stopPropagation();
                  return;
                }
                setMenuPath(path);
              }}
            >
              <ContextMenu>
                <ContextMenuTrigger className="h-full min-h-0" render={<div />}>
                  <StyledDiffCodeView<CommentDraft>
                    className="h-full min-h-0 overflow-auto"
                    items={items}
                    key={codeViewMountKey}
                    onSelectedLinesChange={setSelectedLines}
                    onRevealSearchMatch={(item) => unfoldFile(item.id)}
                    options={{
                      diffStyle: settings.layout === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme,
                      stickyHeaders: true,
                      ...(result?.loadFile === undefined ? {} : { loadDiffFiles }),
                      // The gutter's "+" (or a dragged range) opens a comment, one at a time.
                      enableGutterUtility: canComment && draft === null,
                      enableLineSelection: canComment && draft === null,
                      onGutterUtilityClick: (range, context) =>
                        beginComment(range, context.item as CodeViewDiffItem<CommentDraft>),
                    }}
                    renderAnnotation={(annotation) =>
                      annotation.metadata.kind === "comments" ? (
                        // T3's group: the comments stacked, with dividers between them.
                        <div className="divide-y divide-border/30 border-y border-border/30">
                          {annotation.metadata.entries.map((entry) => (
                            <DiffComment
                              key={entry.contextId}
                              onDelete={() => deleteComment(entry)}
                              text={entry.text}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="py-1">
                          <DiffCommentAnnotation
                            onCancel={closeDraft}
                            onComment={sendComment}
                            onTextChange={setDraftText}
                            pending={sending !== null && sending === draft?.id}
                            rangeLabel={annotation.metadata.rangeLabel}
                            text={draftText}
                          />
                        </div>
                      )
                    }
                    selectedLines={selectedLines}
                    renderHeaderFilenameSuffix={(item) =>
                      item.type === "diff" ? (
                        <DiffFilePathCopyButton
                          filePath={resolveFileDiffPath(item.fileDiff)}
                          onFailed={() =>
                            services.toasts?.show({
                              type: "error",
                              title: "Could not copy the path",
                            })
                          }
                        />
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
                </ContextMenuTrigger>
                <FileContextMenuPopup
                  editors={editors}
                  revealKind={revealKind}
                  onOpen={(editor) => {
                    if (menuPath !== null) {
                      void services.editors.open(target, projectId, menuPath, editor);
                    }
                  }}
                  onReveal={(fileManager) => {
                    if (menuPath !== null) {
                      void services.editors.open(target, projectId, menuPath, fileManager, {
                        reveal: true,
                      });
                    }
                  }}
                />
              </ContextMenu>
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

    return (
      <DiffPanelShell embedded={props.embedded} header={header}>
        {body}
      </DiffPanelShell>
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
    return (
      <PanelFor embedded={false} project={route.project} target={target} thread={route.thread} />
    );
  }

  /** The right panel's `diff` surface (t3-parity.md D1424). */
  function DiffSurface({ place }: RightPanelSurfaceProps) {
    return (
      <PanelFor embedded project={place.projectId} target={place.target} thread={place.threadId} />
    );
  }

  function PanelFor(props: {
    embedded: boolean;
    target: NodeTarget;
    thread?: string | undefined;
    project?: string | undefined;
  }) {
    const catalog = useCatalog(threads, props.target);
    const view = useSourceControl(store, props.target);
    const record = catalog?.threads.find((thread) => thread.id === props.thread);
    const projectId = props.project ?? record?.projectId;
    if (projectId === undefined) {
      return (
        <DiffPanelShell embedded={props.embedded}>
          <EmptyState>Select a thread to inspect turn diffs.</EmptyState>
        </DiffPanelShell>
      );
    }
    return (
      <Panel
        embedded={props.embedded}
        key={`${JSON.stringify(props.target)}|${projectId}|${props.thread ?? ""}`}
        projectId={projectId}
        // A worktree thread's files are its worktree's (D251).
        projectPath={
          (props.project === undefined ? record?.worktreePath : undefined) ??
          catalog?.projects.find((project) => project.id === projectId)?.path
        }
        status={statusOfThread(view, projectId, props.project === undefined ? record : undefined)}
        target={props.target}
        threadId={props.project === undefined ? props.thread : undefined}
      />
    );
  }

  return { DiffPanel, DiffSurface };
}
