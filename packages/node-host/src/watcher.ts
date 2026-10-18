import * as Fs from "node:fs";
import * as Path from "node:path";

import type { Disposable, Logger } from "@jhin/sdk";

export interface WatchTarget {
  /** Absolute directory or file to watch. */
  readonly path: string;
  /** Called once per burst of changes; `files` are absolute paths. */
  readonly onChange: (files: readonly string[]) => void;
}

const IGNORED = /(^|[/\\])(node_modules|\.git|dist)([/\\]|$)/;

/**
 * Watches directories and files and reports bursts of changes. Editors write
 * files in several steps, so changes are debounced per target.
 */
export function watch(targets: readonly WatchTarget[], log: Logger, debounceMs = 75): Disposable {
  const closers: (() => void)[] = [];
  for (const target of targets) {
    if (!Fs.existsSync(target.path)) continue;
    const isDirectory = Fs.statSync(target.path).isDirectory();
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
    const watcher = Fs.watch(target.path, { recursive: isDirectory }, (_event, name) => {
      const file =
        isDirectory && name !== null ? Path.join(target.path, name.toString()) : target.path;
      if (IGNORED.test(Path.relative(target.path, file))) return;
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
