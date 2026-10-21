// The changed files card follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ChangedFilesTree.tsx (ChangedFilesCard, ChangedFilesTree)
// and MessagesTimeline.tsx (AssistantChangedFilesSection, under a turn's answer);
// the diff panel's selection follows apps/web/src/diffPanelStore.ts.
import { targetKey, type ChatTurnFooterProps, type NodeTarget } from "@jhin/client-api";
import type { TurnCheckpoint } from "@jhin/source-control-api";
import { Button, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import {
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FileDiffIcon,
  FileIcon,
  FolderClosedIcon,
  FolderIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import { formatCompactDiffCount } from "../../lib/pull-request.ts";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turn-diff-tree.ts";
import { useSourceControl, type SourceControlServices } from "./services.ts";

/**
 * What the diff panel shows for a thread (or a draft's project), as T3's
 * diffPanelStore keeps it: a git scope, or a turn (the latest when `turn` is
 * absent), with the file to reveal.
 */
export type DiffSelection =
  | { readonly kind: "branch" | "uncommitted" }
  | {
      readonly kind: "turn";
      readonly turn?: number;
      readonly filePath?: string;
      /** Bumped by every request to reveal `filePath` again. */
      readonly reveal: number;
    };

const DEFAULT_SELECTION: DiffSelection = { kind: "uncommitted" };

export interface DiffSelections {
  get(key: string): DiffSelection;
  set(key: string, selection: DiffSelection): void;
  subscribe(listener: () => void): () => void;
}

export function createDiffSelections(): DiffSelections {
  const selections = new Map<string, DiffSelection>();
  const listeners = new Set<() => void>();
  return {
    get: (key) => selections.get(key) ?? DEFAULT_SELECTION,
    set(key, selection) {
      selections.set(key, selection);
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The key of a thread's (or a draft's project's) selection. */
export const selectionKey = (
  target: NodeTarget,
  owner: { thread?: string | undefined; project?: string | undefined },
) =>
  `${targetKey(target)}|${owner.thread === undefined ? `project:${owner.project}` : `thread:${owner.thread}`}`;

export function useDiffSelection(selections: DiffSelections, key: string): DiffSelection {
  return useSyncExternalStore(selections.subscribe, () => selections.get(key));
}

interface CheckpointList {
  readonly version: string;
  readonly promise: Promise<readonly TurnCheckpoint[]>;
}
const lists = new WeakMap<SourceControlServices, Map<string, CheckpointList>>();

/**
 * A thread's checkpoints, oldest first (`git.checkpoints`), read again when its
 * latest one changes; one read per thread and change however many views ask.
 * Undefined while loading; empty for a thread without any.
 */
export function useThreadCheckpoints(
  services: SourceControlServices,
  target: NodeTarget,
  threadId: string,
): readonly TurnCheckpoint[] | undefined {
  const view = useSourceControl(services.store, target);
  const latest = view.checkpoints.get(threadId);
  const version =
    latest === undefined ? "none" : `${latest.turn}:${latest.status}:${latest.capturedAt}`;
  const key = `${targetKey(target)}|${threadId}`;
  const [state, setState] = useState<{ version: string; list: readonly TurnCheckpoint[] }>();
  useEffect(() => {
    if (latest === undefined) return;
    const cache = lists.get(services) ?? new Map<string, CheckpointList>();
    lists.set(services, cache);
    let entry = cache.get(key);
    if (entry?.version !== version) {
      entry = {
        version,
        promise: services.threads
          .call<{ checkpoints: TurnCheckpoint[] }>(target, "git.checkpoints", { threadId })
          .then((answer) => answer.checkpoints),
      };
      cache.set(key, entry);
      // A failed read is tried again by the next view that asks.
      entry.promise.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
      });
    }
    let current = true;
    void entry.promise.then(
      (list) => current && setState({ version, list }),
      () => current && setState({ version, list: [] }),
    );
    return () => {
      current = false;
    };
  }, [key, version]);
  if (latest === undefined) return view.status === "loading" ? undefined : [];
  return state?.version === version ? state.list : undefined;
}

/** T3's DiffStatLabel, inline layout. */
export function DiffStatLabel(props: { additions: number; deletions: number; className?: string }) {
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

const hasNonZeroStat = (stat: { additions: number; deletions: number } | null) =>
  stat !== null && (stat.additions > 0 || stat.deletions > 0);

function collectDirectoryPaths(nodes: readonly TurnDiffTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory" ? [node.path, ...collectDirectoryPaths(node.children)] : [],
  );
}

function ChangedFilesTree(props: {
  files: readonly { path: string; additions: number; deletions: number }[];
  allDirectoriesExpanded: boolean;
  onOpen(filePath: string): void;
}) {
  const { files, allDirectoriesExpanded, onOpen } = props;
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const nodes = buildTurnDiffTree(files);
  const hasDirectories = collectDirectoryPaths(nodes).length > 0;
  const toggle = (path: string) =>
    setOverrides((current) => ({
      ...current,
      [path]: !(current[path] ?? allDirectoriesExpanded),
    }));
  const row =
    "group flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

  const render = (node: TurnDiffTreeNode, depth: number) => {
    const paddingLeft = `${8 + depth * 14}px`;
    if (node.kind === "directory") {
      const expanded = overrides[node.path] ?? allDirectoriesExpanded;
      const Folder = expanded ? FolderIcon : FolderClosedIcon;
      return (
        <div key={`dir:${node.path}`}>
          <button
            aria-expanded={expanded}
            className={row}
            onClick={() => toggle(node.path)}
            style={{ paddingLeft }}
            type="button"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                expanded && "rotate-90",
              )}
            />
            <Folder className="size-3.5 shrink-0 text-muted-foreground/75" />
            <span className="truncate font-mono text-2xs text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) ? (
              <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            ) : null}
          </button>
          {expanded ? <div>{node.children.map((child) => render(child, depth + 1))}</div> : null}
        </div>
      );
    }
    return (
      <button
        className={row}
        key={`file:${node.path}`}
        onClick={() => onOpen(node.path)}
        style={{ paddingLeft }}
        type="button"
      >
        {hasDirectories || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="flex min-w-0 font-mono text-xs text-foreground/85 group-hover:text-foreground">
          <MiddleTruncate value={node.name} />
        </span>
        {node.stat ? (
          <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        ) : null}
      </button>
    );
  };

  return <div className="p-2">{nodes.map((node) => render(node, 0))}</div>;
}

/** T3's ChangedFilesCard: the files a turn changed, opening the diff panel on them. */
function ChangedFilesCard(props: { checkpoint: TurnCheckpoint; onOpen(filePath?: string): void }) {
  const { checkpoint, onOpen } = props;
  const [allExpanded, setAllExpanded] = useState(true);
  const files = checkpoint.files.map((file) => ({
    path: file.path,
    additions: file.insertions,
    deletions: file.deletions,
  }));
  const stat = summarizeTurnDiffStats(files);
  const hasDirectories = files.some((file) => /[/\\]/.test(file.path));
  const count = checkpoint.fileCount;
  return (
    <section
      aria-label="Changed files"
      className="@container/changed-files rounded-lg bg-secondary dark:bg-input/20"
      data-changed-files-state="tree"
    >
      <div
        className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2 dark:bg-background dark:bg-linear-to-b dark:from-input/20 dark:to-input/20"
        data-changed-files-header=""
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground">
          <span>
            {count} changed file{count === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(stat) ? (
            <DiffStatLabel
              additions={checkpoint.insertions}
              className="text-xs leading-4"
              deletions={checkpoint.deletions}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasDirectories ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={allExpanded ? "Collapse all folders" : "Expand all folders"}
                    onClick={() => setAllExpanded(!allExpanded)}
                    size="icon-xs"
                    type="button"
                    variant="ghost-muted"
                  />
                }
              >
                {allExpanded ? (
                  <ChevronsDownUpIcon className="size-3" />
                ) : (
                  <ChevronsUpDownIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open diff"
                  onClick={() => onOpen(files[0]?.path)}
                  size="xs"
                  type="button"
                  variant="ghost-muted"
                />
              }
            >
              <FileDiffIcon className="size-3" />
              <span className="hidden @[24rem]/changed-files:inline">Open diff</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <ChangedFilesTree
        allDirectoriesExpanded={allExpanded}
        files={files}
        key={String(allExpanded)}
        onOpen={(path) => onOpen(path)}
      />
    </section>
  );
}

/**
 * `jhin.source-control.changed-files` in `chat.turn.footer` (D248): under a
 * turn that changed files, its card; "Open diff" and a file open the diff
 * panel on that turn.
 */
export function createChangedFilesFooter(
  services: SourceControlServices,
  selections: DiffSelections,
  open: (target: NodeTarget, threadId: string) => void,
) {
  return function ChangedFilesFooter({ target, thread, turnId, state }: ChatTurnFooterProps) {
    const checkpoints = useThreadCheckpoints(services, target, thread.id);
    if (state === "running") return null;
    const checkpoint = checkpoints?.find((item) => item.turnId === turnId);
    if (checkpoint === undefined || checkpoint.status !== "ready" || checkpoint.fileCount === 0) {
      return null;
    }
    return (
      <div className="pb-4">
        <ChangedFilesCard
          checkpoint={checkpoint}
          onOpen={(filePath) => {
            const key = selectionKey(target, { thread: thread.id });
            const previous = selections.get(key);
            selections.set(key, {
              kind: "turn",
              turn: checkpoint.turn,
              ...(filePath === undefined ? {} : { filePath }),
              reveal: (previous.kind === "turn" ? previous.reveal : 0) + 1,
            });
            open(target, thread.id);
          }}
        />
      </div>
    );
  };
}
