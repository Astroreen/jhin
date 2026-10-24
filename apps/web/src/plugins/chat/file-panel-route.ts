// Where a mentioned file's preview shows (t3-parity.md D1342): the route's panel `file`, its
// section the file's path. Apart from the panel itself so the entry chunk does not load it.
import { targetKey, type Navigation, type NodeTarget, type Route } from "@jhin/client-api";

/** The route's `panel` while the file panel shows. */
export const FILE_PANEL = "file";

/** The route's `panel` while the right panel shows T3's file explorer (D1428). */
export const FILES_PANEL = "files";

/**
 * Opens `path` in the file panel beside `place`: the thread (or, without one, the draft of the
 * project) whose chip was pressed, on its node, in place of the panel it had.
 */
export function openFilePanel(
  navigation: Navigation,
  place: { readonly target: NodeTarget; readonly threadId?: string; readonly projectId?: string },
  path: string,
  /** A line to show (an agent's `a.ts:12`, D1430), asked of the panel through `reveals`. */
  reveal?: { readonly reveals: FileReveals; readonly line: number },
): void {
  if (reveal !== undefined) reveal.reveals.request(revealKey(place, path), reveal.line);
  const route: Route = {
    node: place.target.node,
    ...(place.target.remote === undefined ? {} : { remote: place.target.remote }),
    ...(place.threadId !== undefined
      ? { thread: place.threadId }
      : place.projectId !== undefined
        ? { project: place.projectId }
        : {}),
    panel: FILE_PANEL,
    section: path,
  };
  const current = navigation.current();
  if (
    current.node === route.node &&
    current.remote === route.remote &&
    current.thread === route.thread &&
    current.project === route.project &&
    current.panel === FILE_PANEL &&
    current.section === path
  ) {
    return;
  }
  // In Threads mode, where the file panel shows beside the thread (another mode's shell shows
  // only its own panels).
  navigation.navigate(route);
}

/** A line of a file the file panel is asked to show (T3's `revealLine`, D1430). */
export interface FileReveal {
  readonly line: number;
  /** Bumped by each request, so the same line is shown again. */
  readonly id: number;
}

/** The lines asked of each place's files, for this page (T3 keeps them on its surface). */
export interface FileReveals {
  get(key: string): FileReveal | undefined;
  request(key: string, line: number): void;
  subscribe(listener: () => void): () => void;
}

/** The key of a file of a place (a thread, or a draft's project), for `FileReveals`. */
export const revealKey = (
  place: { readonly target: NodeTarget; readonly threadId?: string; readonly projectId?: string },
  path: string,
): string =>
  `${targetKey(place.target)}|${place.threadId ?? `p:${place.projectId ?? ""}`}|${path}`;

export function createFileReveals(): FileReveals {
  const reveals = new Map<string, FileReveal>();
  const listeners = new Set<() => void>();
  let requests = 0;
  return {
    get: (key) => reveals.get(key),
    request(key, line) {
      requests += 1;
      reveals.set(key, { line, id: requests });
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
