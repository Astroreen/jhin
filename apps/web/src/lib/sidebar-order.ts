// The project order follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/Sidebar.logic.ts (sortProjectsForSidebar, "updated_at").
import {
  targetKey,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
} from "@jhin/client-api";

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

/** A project as the sidebar lists it, with its node and its listed threads. */
export interface SidebarProject<Node extends { readonly target: NodeTarget }> {
  /** Unique across nodes: the node's target key and the project id. */
  readonly key: string;
  readonly node: Node;
  readonly project: ProjectRecord;
  /** Its threads as `listedThreads` lists them. */
  readonly threads: readonly ThreadRecord[];
}

/** The key of a project in the sidebar: unique across nodes. */
export const projectKey = (target: NodeTarget, projectId: string): string =>
  `${targetKey(target)}|${projectId}`;

/**
 * The projects of every shown node in one list, without a section per node,
 * ordered as T3 Code orders its sidebar by default ("updated_at", from
 * apps/web/src/components/Sidebar.logic.ts, MIT, see THIRD_PARTY_NOTICES.md):
 * the latest activity of a project's threads first, a project without threads
 * by when it was created; ties by name, then by node. A scratch project shows
 * only with threads, or while a new thread is drafted in it (`drafting`, a
 * `projectKey`).
 */
export function sidebarProjects<
  Node extends {
    readonly target: NodeTarget;
    readonly catalog: {
      readonly projects: readonly ProjectRecord[];
      readonly threads: readonly ThreadRecord[];
    };
  },
>(nodes: readonly Node[], drafting?: string): SidebarProject<Node>[] {
  return nodes
    .flatMap((node) =>
      node.catalog.projects.map((project) => ({
        key: projectKey(node.target, project.id),
        node,
        project,
        threads: listedThreads(node.catalog.threads, project.id),
      })),
    )
    .filter((item) => !item.project.scratch || item.threads.length > 0 || item.key === drafting)
    .map((item) => ({
      item,
      at:
        item.threads[0] === undefined ? item.project.createdAt : threadActivityAt(item.threads[0]),
    }))
    .toSorted(
      (a, b) =>
        b.at.localeCompare(a.at) ||
        a.item.project.name.localeCompare(b.item.project.name) ||
        a.item.key.localeCompare(b.item.key),
    )
    .map(({ item }) => item);
}
