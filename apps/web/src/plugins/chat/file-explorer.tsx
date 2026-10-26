// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/FileBrowserPanel.tsx (the tree, its search, refresh and
// expand-all, revealing the open file), useDirectoryEntries.ts (a folder at a time, four at
// once), fileTreePathReconciliation.ts and loadFileAncestors.ts.
//
// T3's file explorer of a project, or a thread's worktree (t3-parity.md D1428): a chunk of its
// own, loaded with the file panel.
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import { useStableCallback } from "@pierre/diffs/react";
import type { FileTreeBatchOperation } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import {
  Button,
  InputGroup,
  InputGroupInput,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { T3_PIERRE_ICONS } from "../../lib/pierre-icons.ts";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";

export interface ExplorerEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly ignored?: true;
}

/** Where the explorer reads: a project's folder, or its thread's worktree. */
export interface ExplorerSource {
  readonly threads: ThreadsCatalog;
  readonly target: NodeTarget;
  readonly projectId: string;
  readonly threadId?: string;
}

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

const treePath = (entry: ExplorerEntry) =>
  entry.kind === "directory" ? `${entry.path}/` : entry.path;

const depth = (path: string) => path.split("/").filter(Boolean).length;

/** T3's buildFileTreePathUpdates: the tree's removals and additions, parents first. */
function treePathUpdates(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
): FileTreeBatchOperation[] {
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const removedRoots: string[] = [];
  const updates: FileTreeBatchOperation[] = [];
  for (const path of previousPaths
    .filter((entry) => !next.has(entry))
    .toSorted((a, b) => depth(a) - depth(b))) {
    if (removedRoots.some((root) => path.startsWith(root))) continue;
    const recursive = path.endsWith("/");
    updates.push({ type: "remove", path, ...(recursive ? { recursive: true } : {}) });
    if (recursive) removedRoots.push(path);
  }
  for (const path of nextPaths
    .filter((entry) => !previous.has(entry))
    .toSorted((a, b) => depth(a) - depth(b))) {
    updates.push({ type: "add", path });
  }
  return updates;
}

/** T3's useDirectoryEntries: folders as they are asked for, at most four reads at once. */
function useDirectoryEntries(source: ExplorerSource) {
  const [folders, setFolders] = useState(new Map<string, readonly ExplorerEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(1);
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set([""]));
  const requests = useRef(new Map<string, Promise<void>>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const active = useRef(true);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  const start = (folder: string, refresh: boolean): Promise<void> => {
    loaded.current.add(folder);
    requested.current.add(folder);
    const request = (async () => {
      if (running.current >= 4) await new Promise<void>((resolve) => waiting.current.push(resolve));
      else running.current += 1;
      try {
        return await source.threads.call<{ entries: ExplorerEntry[] }>(
          source.target,
          "projects.list-entries",
          {
            projectId: source.projectId,
            ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
            path: folder,
          },
        );
      } finally {
        const next = waiting.current.shift();
        if (next !== undefined) next();
        else running.current -= 1;
      }
    })()
      .then(
        (result) => {
          if (!active.current) return;
          setFolders((current) => new Map(current).set(folder, result.entries));
          setErrors((current) => {
            const next = new Map(current);
            next.delete(folder);
            return next;
          });
        },
        (error: unknown) => {
          loaded.current.delete(folder);
          if (!active.current) return;
          setErrors((current) =>
            new Map(current).set(
              folder,
              error instanceof Error ? error.message : "Unable to load folder.",
            ),
          );
        },
      )
      .finally(() => {
        requests.current.delete(folder);
        if (!active.current) return;
        setPending((count) => count - 1);
        if (!refresh) {
          setLoading((current) => {
            const next = new Set(current);
            next.delete(folder);
            return next;
          });
        }
      });
    requests.current.set(folder, request);
    return request;
  };

  const load = useStableCallback((folder: string, refresh = false): Promise<void> => {
    const existing = requests.current.get(folder);
    if (existing !== undefined) return refresh ? existing.then(() => load(folder, true)) : existing;
    if (!refresh && loaded.current.has(folder)) return Promise.resolve();
    setPending((count) => count + 1);
    if (!refresh) setLoading((current) => new Set(current).add(folder));
    return start(folder, refresh);
  });

  useEffect(() => {
    active.current = true;
    if (!requests.current.has("") && !loaded.current.has("")) void start("", false);
    return () => {
      active.current = false;
    };
  }, []);

  const entries: ExplorerEntry[] = [];
  const visit = (folder: string) => {
    for (const entry of folders.get(folder) ?? []) {
      entries.push(entry);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  visit("");
  const reachable = new Set([
    "",
    ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  ]);
  const refresh = () => {
    const paths = [...requested.current].filter((path) => reachable.has(path));
    const worker = async () => {
      while (active.current) {
        const path = paths.shift();
        if (path === undefined) return;
        await load(path, true);
      }
    };
    for (let index = 0; index < Math.min(4, paths.length); index += 1) void worker();
  };
  return {
    entries,
    load,
    refresh,
    pending: pending > 0,
    loading,
    ready: folders.has(""),
    error: [...errors].find(([path]) => reachable.has(path))?.[1] ?? null,
  };
}

/** The project's files matching a typed query, as T3's useProjectPathSearch. */
function usePathSearch(source: ExplorerSource, query: string) {
  const [result, setResult] = useState<{
    query: string;
    entries: readonly ExplorerEntry[];
    truncated: boolean;
    error: string | null;
  }>({ query: "", entries: [], truncated: false, error: null });
  const [revision, setRevision] = useState(0);
  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed === "") return;
    let current = true;
    // T3 waits 200 ms after the last keystroke before it asks.
    const timer = setTimeout(() => {
      source.threads
        .call<{ entries: ExplorerEntry[]; truncated: boolean }>(
          source.target,
          "projects.search-entries",
          { projectId: source.projectId, query: trimmed.slice(0, 256), limit: 200 },
        )
        .then(
          (found) =>
            current &&
            setResult({
              query: trimmed,
              entries: found.entries,
              truncated: found.truncated,
              error: null,
            }),
          (error: unknown) =>
            current &&
            setResult({
              query: trimmed,
              entries: [],
              truncated: false,
              error: error instanceof Error ? error.message : "Unable to search files.",
            }),
        );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed, revision]);
  const fresh = result.query === trimmed;
  return {
    entries: fresh ? result.entries : [],
    pending: trimmed !== "" && !fresh,
    truncated: fresh && result.truncated,
    error: fresh ? result.error : null,
    refresh: () => setRevision((value) => value + 1),
  };
}

/** T3's FileBrowserPanel. */
export function FileExplorer(props: {
  readonly source: ExplorerSource;
  readonly projectName: string;
  /** The file the panel shows beside it, revealed in the tree. */
  readonly selectedPath: string | null;
  onOpenFile(path: string): void;
}) {
  const theme = useResolvedTheme();
  const {
    entries: folderEntries,
    load,
    refresh,
    pending,
    loading,
    ready,
    error,
  } = useDirectoryEntries(props.source);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const search = usePathSearch(props.source, query);
  // T3's buildTreeEntries: what the folders hold, and while searching what the search found.
  const byPath = new Map(folderEntries.map((entry) => [entry.path, entry]));
  if (query.trim() !== "" && !search.pending) {
    for (const entry of search.entries) {
      if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const folder = segments.slice(0, index).join("/");
        if (!byPath.has(folder)) byPath.set(folder, { path: folder, kind: "directory" });
      }
    }
  }
  const entries = [...byPath.values()];
  const kinds = new Map(entries.map((entry) => [entry.path, entry.kind]));
  const treePaths = entries.map(treePath);
  const treePathsKey = treePaths.join("\n");
  const directoryPaths = entries.filter((entry) => entry.kind === "directory").map(treePath);
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  const loadingRef = useRef(loading);
  const mountedPaths = useRef<readonly string[] | null>(null);
  const syncing = useRef(false);
  const selectedInTree = useRef<string | null>(null);
  const revealed = useRef<string | null>(null);

  const onSelectionChange = useStableCallback((selectedPaths: readonly string[]) => {
    if (syncing.current) return;
    const path = selectedPaths.at(-1)?.replace(/\/$/, "");
    if (path !== undefined && kindsRef.current.get(path) === "file") {
      selectedInTree.current = path;
      props.onOpenFile(path);
    }
  });
  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange,
    paths: [],
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      loadingRef.current.has(item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  useEffect(() => {
    if (loadingRef.current === loading) return;
    loadingRef.current = loading;
    model.setComposition(model.getComposition());
  }, [loading, model]);
  const treeSearch = useFileTreeSearch(model);
  const noMatches = treeSearch.value.trim().length > 0 && treeSearch.matchingPaths.length === 0;
  const allExpanded = useFileTreeSelector(
    model,
    (current) =>
      directoryPaths.length > 0 &&
      directoryPaths.every((path) => {
        const item = current.getItem(path);
        return item !== null && "isExpanded" in item && item.isExpanded();
      }),
  );
  const setAllExpanded = (expanded: boolean) => {
    for (const path of directoryPaths) {
      const item = model.getItem(path);
      if (item === null || !("isExpanded" in item) || item.isExpanded() === expanded) continue;
      if (expanded) item.expand();
      else item.collapse();
    }
  };

  // An expanded folder is read when it opens (T3's loadExpanded).
  const expanded = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(directoryPaths);
    for (const path of expanded.current) if (!current.has(path)) expanded.current.delete(path);
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() === true && "isExpanded" in item && item.isExpanded()) {
          if (!expanded.current.has(path)) {
            expanded.current.add(path);
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() === true && expanded.current.has(path)) setExpandAll(false);
          expanded.current.delete(path);
        }
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [treePathsKey, model]);
  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored === true)
        .map((entry) => ({ path: treePath(entry), status: "ignored" as const })),
    );
  }, [treePathsKey, model]);
  // The open file's folders are read, so it can be revealed (T3's loadFileAncestors).
  useEffect(() => {
    if (props.selectedPath === null) return;
    let cancelled = false;
    const segments = props.selectedPath.split("/");
    void (async () => {
      for (let index = 0; index < segments.length && !cancelled; index += 1) {
        await load(segments.slice(0, index).join("/"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.selectedPath]);
  useEffect(() => {
    if (!ready) return;
    const previous = mountedPaths.current;
    if (previous !== null && previous.join("\n") === treePathsKey) return;
    mountedPaths.current = treePaths;
    if (previous === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = treePathUpdates(previous, treePaths);
    if (updates.length > 0) model.batch(updates);
  }, [ready, treePathsKey, model]);
  useEffect(() => {
    if (expandAll && query.trim() === "") setAllExpanded(true);
  }, [treePathsKey, expandAll, query]);
  // T3 reveals a file opened from elsewhere (a chip, a link), not one picked in the tree.
  useEffect(() => {
    const path = props.selectedPath;
    if (path === null || kinds.get(path) === undefined) return;
    if (revealed.current === path) return;
    const item = model.getItem(kinds.get(path) === "directory" ? `${path}/` : path);
    if (item === null) return;
    revealed.current = path;
    if (selectedInTree.current === path) {
      selectedInTree.current = null;
      return;
    }
    syncing.current = true;
    for (const selected of model.getSelectedPaths()) model.getItem(selected)?.deselect();
    let ancestor = "";
    for (const segment of path.split("/").slice(0, -1)) {
      ancestor = ancestor === "" ? segment : `${ancestor}/${segment}`;
      const folder = model.getItem(`${ancestor}/`) ?? model.getItem(ancestor);
      if (folder !== null && "expand" in folder) folder.expand();
    }
    item.select();
    model.scrollToPath(item.getPath(), { offset: "center" });
    queueMicrotask(() => {
      syncing.current = false;
    });
  }, [treePathsKey, props.selectedPath, model]);

  const onRefresh = () => {
    refresh();
    if (query.trim() !== "") search.refresh();
  };
  const onQuery = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      treeSearch.close();
      return;
    }
    treeSearch.setValue(value);
  };
  const expandLabel = expandAll || allExpanded ? "Collapse all folders" : "Expand all folders";
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-file-browser-panel="">
      <div
        className="mb-1 flex h-9 min-h-9 shrink-0 items-center gap-1 bg-background px-2"
        data-surface-subheader=""
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Refresh workspace files"
                onClick={onRefresh}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <RefreshCwIcon className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
          </TooltipTrigger>
          <TooltipPopup>{pending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
        </Tooltip>
        <InputGroup className="h-7 min-w-0 flex-1">
          <InputGroupInput
            aria-label={`Search ${props.projectName} files`}
            name="project-files-search"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              treeSearch.close();
              event.currentTarget.blur();
            }}
            placeholder="Search files"
            spellCheck={false}
            type="search"
            value={treeSearch.value}
          />
        </InputGroup>
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={expandLabel}
                  onClick={() => {
                    const next = !(expandAll || allExpanded);
                    setExpandAll(next);
                    setAllExpanded(next);
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              {allExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {error !== null || search.error !== null ? (
        <button
          className="p-4 text-left text-xs leading-relaxed text-destructive"
          onClick={onRefresh}
          type="button"
        >
          {error ?? search.error} Click to retry.
        </button>
      ) : null}
      {query.trim() !== "" && search.truncated && !search.pending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {!ready || search.pending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground" role="status">
          Loading files…
        </div>
      ) : null}
      {noMatches ? (
        ready && !pending && !search.pending && error === null && search.error === null ? (
          <div className="px-3 py-4 text-xs text-muted-foreground" role="status">
            No matching files.
          </div>
        ) : null
      ) : (
        <FileTree
          aria-label={`${props.projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          model={model}
          style={
            {
              colorScheme: theme,
              ["--trees-fg-override" as string]: "var(--contrast-foreground)",
            } as CSSProperties
          }
        />
      )}
    </div>
  );
}
