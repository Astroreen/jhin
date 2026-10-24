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
}

/**
 * The files git lists (tracked, and untracked but not ignored), without tracked files
 * deleted from the working tree; undefined outside git.
 */
async function gitFiles(root: string): Promise<string[] | undefined> {
  const [listed, deleted] = await Promise.all([
    gitList(root, ["--cached", "--others", "--exclude-standard"]),
    gitList(root, ["--deleted"]),
  ]);
  if (listed === undefined) return undefined;
  const gone = new Set(deleted ?? []);
  return [...new Set(listed)].filter((path) => !gone.has(path));
}

function gitList(root: string, flags: readonly string[]): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    ChildProcess.execFile(
      "git",
      ["ls-files", ...flags, "-z"],
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
  /**
   * Per project folder: the index (built or being built), when it was asked for
   * last, and when its build started. One build at a time per folder.
   */
  const indexes = new Map<string, { index: Promise<Index>; usedAt: number; startedAt: number }>();
  const build = async (root: string): Promise<Index> => {
    const files = (await gitFiles(root)) ?? (await walkFiles(root, MAX_INDEXED_ENTRIES));
    const { entries, truncated } = entriesOf(files);
    return { entries, truncated };
  };
  return {
    async search(
      root: string,
      query: string,
      options: { limit: number; kind?: "file" | "directory" },
    ): Promise<{ entries: ProjectEntry[]; truncated: boolean }> {
      const at = now();
      // Unused indexes go, without waiting for any build.
      for (const [key, entry] of indexes) {
        if (at - entry.usedAt > INDEX_IDLE_MS) indexes.delete(key);
      }
      let entry = indexes.get(root);
      if (entry === undefined || at - entry.startedAt > INDEX_FRESH_MS) {
        const index = build(root);
        entry = { index, usedAt: at, startedAt: at };
        indexes.set(root, entry);
        const started = entry;
        index.catch(() => {
          if (indexes.get(root) === started) indexes.delete(root);
        });
      }
      entry.usedAt = at;
      const index = await entry.index;
      const ranked = rankEntries(index.entries, query, options.limit + 1, options.kind);
      return {
        entries: ranked.slice(0, options.limit),
        truncated: index.truncated || ranked.length > options.limit,
      };
    },
  };
}

/** Paths sent to one `git check-ignore` call when labelling a folder's children (T3's). */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

/** One folder's child, for the file explorer (t3-parity.md D1428). */
export interface ListedEntry extends ProjectEntry {
  /** Git ignores it (T3 shows it dimmed). */
  readonly ignored?: true;
}

/** T3's `git check-ignore --stdin`: the paths git ignores; undefined without git. */
function checkIgnore(root: string, paths: readonly string[]): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    const child = ChildProcess.execFile(
      "git",
      ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => {
        // 1: none of them is ignored; anything else but 0 is no answer.
        const code = error === null ? 0 : (error as { code?: unknown }).code;
        if (code !== 0 && code !== 1) resolve(undefined);
        else resolve(new Set(stdout.split("\0").filter((path) => path !== "")));
      },
    );
    child.stdin?.end(`${paths.join("\0")}\0`);
  });
}

/**
 * The files and folders directly in `folder` of `root` (T3's `WorkspaceEntries.list` of a
 * directory): never through `.git`, never out of the root through a link, ignored ones marked.
 */
export async function listFolder(root: string, folder: string): Promise<ListedEntry[]> {
  const parts = folder.split("/").filter((part) => part !== "");
  const relative = parts.join("/");
  if (parts.includes(".git") || parts.includes("..")) throw new Error("FOLDER_OUTSIDE");
  const realRoot = await Fs.promises.realpath(root);
  const directory = await Fs.promises.realpath(Path.join(root, ...parts));
  const inside = Path.relative(realRoot, directory);
  if (
    inside === ".." ||
    inside.startsWith(`..${Path.sep}`) ||
    Path.isAbsolute(inside) ||
    inside.split(Path.sep).includes(".git")
  ) {
    throw new Error("FOLDER_OUTSIDE");
  }
  const children = await Fs.promises.readdir(directory, { withFileTypes: true });
  const entries: ProjectEntry[] = children.flatMap((child): ProjectEntry[] => {
    if (child.name === ".git" || (!child.isDirectory() && !child.isFile())) return [];
    return [
      {
        path: relative === "" ? child.name : `${relative}/${child.name}`,
        kind: child.isDirectory() ? "directory" : "file",
      },
    ];
  });
  // Git cannot classify paths beyond a link: a folder reached through one asks about each.
  const throughLink = inside !== parts.join(Path.sep);
  // Asking about the folder itself answers for all its children when git ignores it whole.
  if (
    entries.length > IGNORE_CHECK_CHUNK_SIZE &&
    relative !== "" &&
    !throughLink &&
    !/^:|[*?[\\]/.test(relative)
  ) {
    const folderIgnored = await checkIgnore(root, [relative]);
    if (folderIgnored?.has(relative)) {
      return entries.map((entry) => ({ ...entry, ignored: true as const }));
    }
  }
  const ignored = new Set<string>();
  for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
    const answer = await checkIgnore(
      root,
      entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
    );
    if (answer === undefined) break;
    for (const path of answer) ignored.add(path);
  }
  return entries.map((entry) =>
    ignored.has(entry.path) ? { ...entry, ignored: true as const } : entry,
  );
}
