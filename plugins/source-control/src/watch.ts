import * as Fs from "node:fs";
import * as Path from "node:path";

/** Directories one repository watches at most; deeper trees are left to the turn-end refresh. */
const MAX_WATCHED_DIRECTORIES = 4000;

export interface TreeWatcherOptions {
  /** The working tree. */
  readonly root: string;
  /** `.git` (or a worktree's git dir) and the common dir holding `refs`. */
  readonly gitDirs: readonly string[];
  /** The directories among `paths` git ignores (absolute paths). */
  isIgnored(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** Something in the tree or the repository's metadata changed. */
  onChange(): void;
  readonly maxDirectories?: number;
  /** A directory is watched from now on. */
  readonly onWatch?: (dir: string) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TreeWatcher {
  /** Resolves once the initial tree is being watched. */
  readonly ready: Promise<void>;
  /** The directories watched now. */
  directories(): string[];
  dispose(): void;
}

/**
 * Watches a working tree without what git ignores: one non-recursive
 * `fs.watch` per directory (a recursive watch would also walk `node_modules`
 * and every other ignored tree), plus the git directory itself and its
 * `refs`, where checkouts, commits and fetches land. New directories are
 * watched as they appear.
 */
export function watchTree(options: TreeWatcherOptions): TreeWatcher {
  const max = options.maxDirectories ?? MAX_WATCHED_DIRECTORIES;
  const watchers = new Map<string, Fs.FSWatcher>();
  const gitDirs = new Set(options.gitDirs.map((dir) => Path.resolve(dir)));
  let disposed = false;
  let full = false;

  const isGitPath = (path: string) =>
    [...gitDirs].some((dir) => path === dir || path.startsWith(`${dir}${Path.sep}`));

  const unwatch = (dir: string) => {
    for (const [path, watcher] of watchers) {
      if (path === dir || path.startsWith(`${dir}${Path.sep}`)) {
        watcher.close();
        watchers.delete(path);
      }
    }
  };

  const watchOne = (dir: string, onEntry?: (name: string) => void): boolean => {
    if (disposed || watchers.has(dir)) return false;
    if (watchers.size >= max) {
      full = true;
      return false;
    }
    try {
      const watcher = Fs.watch(dir, { persistent: false }, (_event, name) => {
        // Lock files come and go with every git command, the node's own included.
        if (typeof name === "string" && name.endsWith(".lock")) return;
        options.onChange();
        if (typeof name === "string" && name !== "") onEntry?.(name);
      });
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(dir);
      });
      watchers.set(dir, watcher);
      options.onWatch?.(dir);
      return true;
    } catch (error) {
      // Gone already, or no permission: nothing to watch there.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.onError?.(error);
      return false;
    }
  };

  const subdirectories = (dir: string): string[] => {
    try {
      return Fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => Path.join(dir, entry.name));
    } catch {
      return [];
    }
  };

  /** Watches `dir` and every directory below it that git does not ignore. */
  const walk = async (dir: string): Promise<void> => {
    if (!watchOne(dir, (name) => void appeared(Path.join(dir, name)))) return;
    const children = subdirectories(dir).filter(
      (child) => Path.basename(child) !== ".git" && !isGitPath(child),
    );
    if (children.length === 0) return;
    const ignored = await options.isIgnored(children);
    for (const child of children) {
      if (disposed || full) return;
      if (!ignored.has(child)) await walk(child);
    }
  };

  /** Watches the git directory's own files and its `refs` tree. */
  const walkRefs = (dir: string): void => {
    if (!watchOne(dir, (name) => appearedRef(Path.join(dir, name)))) return;
    for (const child of subdirectories(dir)) walkRefs(child);
  };
  const appearedRef = (path: string) => {
    if (isDirectory(path)) walkRefs(path);
    else if (!Fs.existsSync(path)) unwatch(path);
  };

  const appeared = async (path: string) => {
    if (disposed) return;
    if (!isDirectory(path)) {
      // A directory that was watched went away.
      if (!Fs.existsSync(path)) unwatch(path);
      return;
    }
    if (watchers.has(path) || Path.basename(path) === ".git" || isGitPath(path)) return;
    try {
      const ignored = await options.isIgnored([path]);
      if (!ignored.has(path)) await walk(path);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const ready = (async () => {
    for (const dir of gitDirs) {
      watchOne(dir);
      walkRefs(Path.join(dir, "refs"));
    }
    await walk(Path.resolve(options.root));
  })().catch((error: unknown) => options.onError?.(error));

  return {
    ready,
    directories: () => [...watchers.keys()].toSorted(),
    dispose() {
      disposed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return Fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}
