// `@` mentions search a project's files and folders, as T3 Code's projects.searchEntries
// does (MIT, see THIRD_PARTY_NOTICES.md: apps/server/src/workspace/WorkspaceEntries.ts and
// WorkspaceSearchIndex.ts at eb7b35ac). T3 indexes with a native finder (@ff-labs/fff-node);
// here the files git lists, else a walk of the folder, ranked with T3's own scorer (D302).
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "./search-ranking.ts";

/** T3's index limits: entries kept per project, and how long an unused index lives. */
const MAX_INDEXED_ENTRIES = 25_000;
const INDEX_IDLE_MS = 15 * 60 * 1000;
/** An index older than this is built again on the next search: files come and go. */
const INDEX_FRESH_MS = 10_000;
/** Folders a walk never enters (git ignores them where there is git). */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

export interface ProjectEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

interface Index {
  readonly entries: readonly ProjectEntry[];
  readonly truncated: boolean;
  readonly builtAt: number;
  usedAt: number;
}

/** The files git lists (tracked, and untracked but not ignored); undefined outside git. */
function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    ChildProcess.execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) resolve(undefined);
        else resolve(stdout.split("\0").filter((path) => path !== ""));
      },
    );
  });
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length < limit) {
    const folder = queue.shift()!;
    const entries = await Fs.promises
      .readdir(Path.join(root, folder), { withFileTypes: true })
      .catch(() => [] as Fs.Dirent[]);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

/** Files and the folders they are in, at most `limit` entries. */
export function entriesOf(files: readonly string[], limit = MAX_INDEXED_ENTRIES) {
  const entries: ProjectEntry[] = [];
  const folders = new Set<string>();
  let truncated = false;
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join("/");
      if (folders.has(folder)) continue;
      folders.add(folder);
      entries.push({ path: folder, kind: "directory" });
    }
    entries.push({ path: file, kind: "file" });
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
  }
  return { entries: entries.slice(0, limit), truncated };
}

/**
 * Ranks entries for `query` with T3's scorer: the name first (exact, prefix, a word
 * boundary, anywhere, then fuzzy), then the whole path.
 */
export function rankEntries(
  entries: readonly ProjectEntry[],
  query: string,
  limit: number,
  kind?: "file" | "directory",
): ProjectEntry[] {
  const normalized = normalizeSearchQuery(query, { trimLeadingPattern: /^(?:@|\.\/)+/ });
  const ranked: RankedSearchResult<ProjectEntry>[] = [];
  for (const entry of entries) {
    if (kind !== undefined && entry.kind !== kind) continue;
    if (normalized === "") {
      insertRankedSearchResult(ranked, { item: entry, score: 0, tieBreaker: entry.path }, limit);
      continue;
    }
    const path = entry.path.toLowerCase();
    const name = path.slice(path.lastIndexOf("/") + 1);
    const score =
      scoreQueryMatch({
        value: name,
        query: normalized,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: [".", "-", "_", " "],
      }) ??
      scoreQueryMatch({
        value: path,
        query: normalized,
        exactBase: 10,
        prefixBase: 12,
        boundaryBase: 20,
        includesBase: 26,
        fuzzyBase: 200,
      });
    if (score === null) continue;
    insertRankedSearchResult(ranked, { item: entry, score, tieBreaker: entry.path }, limit);
  }
  return ranked.map((result) => result.item);
}

/** An index per project folder, built when searched and dropped after 15 minutes unused. */
export function createProjectEntries(now: () => number = Date.now) {
  const indexes = new Map<string, Promise<Index>>();
  const build = async (root: string): Promise<Index> => {
    const files = (await gitFiles(root)) ?? (await walkFiles(root, MAX_INDEXED_ENTRIES));
    const { entries, truncated } = entriesOf(files);
    return { entries, truncated, builtAt: now(), usedAt: now() };
  };
  return {
    async search(
      root: string,
      query: string,
      options: { limit: number; kind?: "file" | "directory" },
    ): Promise<{ entries: ProjectEntry[]; truncated: boolean }> {
      for (const [key, pending] of indexes) {
        const index = await pending.catch(() => undefined);
        if (index === undefined || now() - index.usedAt > INDEX_IDLE_MS) indexes.delete(key);
      }
      let pending = indexes.get(root);
      const current = pending === undefined ? undefined : await pending.catch(() => undefined);
      if (current === undefined || now() - current.builtAt > INDEX_FRESH_MS) {
        pending = build(root);
        indexes.set(root, pending);
        pending.catch(() => indexes.delete(root));
      }
      const index = await pending!;
      index.usedAt = now();
      const ranked = rankEntries(index.entries, query, options.limit + 1, options.kind);
      return {
        entries: ranked.slice(0, options.limit),
        truncated: index.truncated || ranked.length > options.limit,
      };
    },
  };
}
