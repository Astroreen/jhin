// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/diffs/DiffFileTree.tsx
// and apps/web/src/pierre-tree-theme.ts. Pierre's own file icons stand in for T3's.
import { useStableCallback } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { Button, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  areAllDirectoriesExpanded,
  buildDiffFileTreeUpdates,
  collectDirectoryPaths,
  compareDiffFileTreeEntries,
  diffFileTreePositions,
  setAllDirectoriesExpanded,
  type DiffFileTreeEntry,
} from "./file-tree-logic.ts";
import { useResolvedTheme } from "./theme.ts";

const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
`;

function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
  };
}

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function DiffFileTree({
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  className,
}: DiffFileTreeProps) {
  const resolvedTheme = useResolvedTheme();
  const paths = entries.map((entry) => entry.path);
  const directoryPaths = collectDirectoryPaths(paths);
  const positions = diffFileTreePositions(paths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus: ReadonlyArray<GitStatusEntry> = entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
  }));
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealRequestId: number } | null>(null);
  const mountedPathsRef = useRef<ReadonlyArray<string> | null>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const path = selectedPaths.at(-1)?.replace(/\/$/, "");
    if (path && paths.includes(path)) onSelectFile(path);
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    ordering.update(positions);
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === paths) return;
    mountedPathsRef.current = paths;
    if (mountedPaths === null) {
      model.resetPaths(paths);
    } else if (mountedPaths.every((path, index) => paths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mountedPaths, paths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A refreshed diff can change the rank of existing siblings. Mutations do not reorder
      // those rows, so rebuild while carrying the reader's folder expansion forward.
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      model.resetPaths(paths);
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, ordering, paths, positions]);

  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    const item = model.getItem(selectedPath);
    if (item === null || item.isDirectory()) {
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) return;
    handledRevealRef.current = { path: selectedPath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of selectedPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(selectedPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    // A file that arrives after it was asked for is still revealed.
  }, [model, paths, revealRequestId, selectedPath]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground">
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <FileTree
        aria-label={ariaLabel}
        className="min-h-0 flex-1 overflow-hidden"
        model={model}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre does not emit a selection change for its sole selected row.
          // Read selection before the row handles the click so new selections reveal only once.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !paths.includes(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFile(path);
        }}
        style={pierreTreeStyle(resolvedTheme)}
      />
    </div>
  );
}
