// Where a mentioned file's preview shows (t3-parity.md D1342): the route's panel `file`, its
// section the file's path. Apart from the panel itself so the entry chunk does not load it.
import type { Navigation, NodeTarget, Route } from "@jhin/client-api";

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
): void {
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
