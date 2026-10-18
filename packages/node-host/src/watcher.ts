import * as Fs from "node:fs";
import * as Path from "node:path";

import type { Disposable, Logger } from "@jhin/sdk";

export interface WatchTarget {
  /** A directory (watched recursively) or a file (which may not exist yet). */
  readonly path: string;
  /** For a directory: which changes count, by path relative to it. Default: all. */
  readonly filter?: (relative: string) => boolean;
  /** Called once per burst of changes; `files` are absolute paths. */
  readonly onChange: (files: readonly string[]) => void;
}

const IGNORED = /(^|[/\\])(node_modules|\.git)([/\\]|$)/;

/**
 * For a plugin root: ignore its build output (`dist/`) unless the plugin runs
 * from it. A plugin run from source must not reload while `build` or `pack`
 * rewrites dist/; one whose entry is built JavaScript reloads on rebuilds.
 */
export function buildOutputFilter(entry: string): ((relative: string) => boolean) | undefined {
  if (/^(\.\/)?dist\//.test(entry)) return undefined;
  return (relative) => relative.split(/[/\\]/)[0] !== "dist";
}

/**
 * Watches directories and files and reports bursts of changes; editors write
 * a file in several steps, so changes are debounced per target.
 *
 * A file is watched through its parent directory: that survives editors that
 * save by renaming a temporary file over the original, and it notices a file
 * created after the watch started. A file whose parent directory does not
 * exist is not watched.
 */
export function watch(targets: readonly WatchTarget[], log: Logger, debounceMs = 75): Disposable {
  const closers: (() => void)[] = [];
  for (const target of targets) {
    const isDirectory = Fs.existsSync(target.path) && Fs.statSync(target.path).isDirectory();
    const directory = isDirectory ? target.path : Path.dirname(target.path);
    if (!Fs.existsSync(directory)) continue;

    const pending = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      const files = [...pending];
      pending.clear();
      try {
        target.onChange(files);
      } catch (error) {
        log.error("watch handler failed", { path: target.path, error: String(error) });
      }
    };
    const watcher = Fs.watch(directory, { recursive: isDirectory }, (_event, name) => {
      if (name === null) return;
      const file = Path.join(directory, name.toString());
      const relative = Path.relative(directory, file);
      if (isDirectory) {
        if (IGNORED.test(relative) || target.filter?.(relative) === false) return;
      } else if (file !== target.path) return;
      pending.add(file);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    });
    watcher.on("error", (error) =>
      log.warn("watcher error", { path: target.path, error: String(error) }),
    );
    closers.push(() => {
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    });
  }
  return { dispose: () => closers.splice(0).forEach((close) => close()) };
}
