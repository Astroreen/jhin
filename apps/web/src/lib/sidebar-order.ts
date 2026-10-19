import type { ThreadRecord } from "@jhin/client-api";

/** When a thread last changed: its latest turn, else its record. */
export const threadActivityAt = (thread: ThreadRecord) =>
  thread.lastTurn?.at ?? thread.updatedAt ?? thread.createdAt;

/** Threads as the sidebar lists them: not archived, most recent first. */
export function listedThreads(threads: readonly ThreadRecord[], projectId: string): ThreadRecord[] {
  return threads
    .filter((thread) => thread.projectId === projectId && thread.archivedAt === undefined)
    .toSorted((a, b) => threadActivityAt(b).localeCompare(threadActivityAt(a)));
}

/** Folds case, accents and spaces, for searching titles. */
const normalizeTitle = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * What a project shows of its listed threads: those matching the search, and
 * without a search the first `limit` unless all are shown — plus the open
 * thread wherever it is. The sidebar renders exactly these, and its "jump to
 * thread N" shortcuts count them, so the two never disagree.
 */
export function shownThreads(
  listed: readonly ThreadRecord[],
  options: {
    readonly query: string;
    readonly limit: number;
    readonly showAll: boolean;
    /** The open thread's id, when it is in this project. */
    readonly current?: string | undefined;
  },
): { matching: readonly ThreadRecord[]; shown: readonly ThreadRecord[] } {
  const query = normalizeTitle(options.query);
  const matching =
    query === "" ? listed : listed.filter((thread) => normalizeTitle(thread.title).includes(query));
  const shown =
    options.showAll || query !== "" || matching.length <= options.limit
      ? matching
      : matching.filter((thread, index) => index < options.limit || thread.id === options.current);
  return { matching, shown };
}
