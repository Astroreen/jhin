// What the sidebar lists and in which order follows T3 Code's sidebar (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/Sidebar.tsx (partitionSidebarThreads),
// Sidebar.logic.ts (statuses, search, project scope), packages/client-runtime/src/state/threadSort.ts
// (active and settled order) and apps/server/src/orchestration-v2/ThreadSettlementService.ts
// (when a thread settles by itself).
import {
  targetKey,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
} from "@jhin/client-api";

/** T3's default for settling a thread by itself: this many days without activity. */
const AUTO_SETTLE_AFTER_DAYS = 3;
/** Settled threads shown at first, and how many more each "Show more" adds. */
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a thread last moved: its latest turn, else its record. */
export const threadActivityAt = (thread: ThreadRecord): string =>
  thread.lastTurn?.at ?? thread.updatedAt ?? thread.createdAt;

/** The key of a project in the sidebar: unique across nodes. */
export const projectKey = (target: NodeTarget, projectId: string): string =>
  `${targetKey(target)}|${projectId}`;

/** The key of a thread in the sidebar: unique across nodes. */
export const threadKey = (target: NodeTarget, threadId: string): string =>
  `${targetKey(target)}|${threadId}`;

/** Where a thread's latest turn is, as T3's sidebar names it. */
export type SidebarThreadStatus = "approval" | "input" | "working" | "failed" | "ready";

export function sidebarThreadStatus(thread: ThreadRecord): SidebarThreadStatus {
  const turn = thread.lastTurn;
  if (turn?.status === "waiting") return turn.waitingFor === "user-input" ? "input" : "approval";
  if (turn?.status === "running") return "working";
  if (turn?.status === "failed") return "failed";
  return "ready";
}

/**
 * A turn that completed after the user last looked at the thread. A thread
 * never opened on this device counts as seen, so nothing old shows as new.
 */
export function isUnread(thread: ThreadRecord, lastVisitedAt: string | undefined): boolean {
  const turn = thread.lastTurn;
  return turn?.status === "completed" && lastVisitedAt !== undefined && lastVisitedAt < turn.at;
}

export type SidebarTopStatus = "working" | "approval" | "input" | "failed" | "done";

/** What the top line of a thread's card says instead of its time (T3's resolveSidebarV2TopStatus). */
export function sidebarTopStatus(
  status: SidebarThreadStatus,
  unread: boolean,
): SidebarTopStatus | null {
  if (status !== "ready") return status;
  return unread ? "done" : null;
}

/** A thread the user need not look at fades back (T3's shouldRecedeSidebarThread). */
export function shouldRecede(input: {
  status: SidebarThreadStatus;
  unread: boolean;
  active: boolean;
}): boolean {
  if (input.active || input.status === "input") return false;
  if (input.status === "working") return true;
  if (input.status === "ready" || input.status === "approval") return !input.unread;
  return false;
}

/**
 * When the thread settled, if it has: T3 settles a thread by itself once it saw
 * no activity for `AUTO_SETTLE_AFTER_DAYS`, unless a turn runs or waits for
 * the user; it settles as of its last activity.
 */
export function settledAt(thread: ThreadRecord, nowMs: number): string | undefined {
  if (thread.archivedAt !== undefined) return undefined;
  const turn = thread.lastTurn;
  if (turn?.status === "running" || turn?.status === "waiting") return undefined;
  const at = turn?.at ?? thread.createdAt;
  const atMs = Date.parse(at);
  return Number.isNaN(atMs) || atMs >= nowMs - AUTO_SETTLE_AFTER_DAYS * DAY_MS ? undefined : at;
}

/** A thread as the sidebar lists it, with its node and its project. */
export interface SidebarThread<Node extends { readonly target: NodeTarget }> {
  readonly key: string;
  readonly node: Node;
  readonly thread: ThreadRecord;
  readonly project: ProjectRecord | undefined;
  /** For a settled thread: when it settled. */
  readonly settledAt?: string;
}

type CatalogNode = {
  readonly target: NodeTarget;
  readonly catalog: {
    readonly projects: readonly ProjectRecord[];
    readonly threads: readonly ThreadRecord[];
  };
};

const byId = (a: ThreadRecord, b: ThreadRecord) => a.id.localeCompare(b.id);

/**
 * The threads of every shown node in one list, without a section per node or
 * project, split as T3 splits them: the active ones first, newest first (T3
 * orders them by when they were created, not by activity), then the settled
 * ones by when they settled. Archived threads are not listed; `scope` (a
 * `projectKey`) keeps one project's threads.
 */
export function sidebarThreads<Node extends CatalogNode>(
  nodes: readonly Node[],
  options: { readonly nowMs: number; readonly scope?: string | undefined },
): { active: SidebarThread<Node>[]; settled: SidebarThread<Node>[] } {
  const active: SidebarThread<Node>[] = [];
  const settled: SidebarThread<Node>[] = [];
  for (const node of nodes) {
    const projects = new Map(node.catalog.projects.map((project) => [project.id, project]));
    for (const thread of node.catalog.threads) {
      if (thread.archivedAt !== undefined) continue;
      if (
        options.scope !== undefined &&
        projectKey(node.target, thread.projectId) !== options.scope
      ) {
        continue;
      }
      const entry = {
        key: threadKey(node.target, thread.id),
        node,
        thread,
        project: projects.get(thread.projectId),
      };
      const at = settledAt(thread, options.nowMs);
      if (at === undefined) active.push(entry);
      else settled.push({ ...entry, settledAt: at });
    }
  }
  active.sort(
    (a, b) =>
      b.thread.createdAt.localeCompare(a.thread.createdAt) ||
      byId(a.thread, b.thread) ||
      a.key.localeCompare(b.key),
  );
  settled.sort(
    (a, b) =>
      b.settledAt!.localeCompare(a.settledAt!) ||
      byId(a.thread, b.thread) ||
      a.key.localeCompare(b.key),
  );
  return { active, settled };
}

/**
 * The settled threads shown: the first `count`, plus the open thread wherever
 * it is; with the shelf collapsed, only the open thread.
 */
export function shownSettled<T extends { readonly key: string }>(
  settled: readonly T[],
  options: { readonly count: number; readonly expanded: boolean; readonly current?: string },
): { shown: T[]; hidden: number } {
  const visible = settled.slice(0, options.count);
  const current = settled.slice(options.count).find((entry) => entry.key === options.current);
  if (current !== undefined) visible.push(current);
  return {
    shown: options.expanded ? visible : visible.filter((entry) => entry.key === options.current),
    hidden: settled.length - visible.length,
  };
}

/** Folds case, accents and spaces, for searching titles. */
const normalizeTitle = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The threads whose title holds the query, in the order given (T3's searchSidebarThreads). */
export function searchSidebarThreads<T extends { readonly thread: ThreadRecord }>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalized = normalizeTitle(query);
  if (normalized === "") return [];
  return threads.filter((entry) => normalizeTitle(entry.thread.title).includes(normalized));
}

/** A project the sidebar can be scoped to. */
export interface ProjectScope<Node> {
  readonly key: string;
  readonly node: Node;
  readonly project: ProjectRecord;
}

/** Every project of every shown node, by name, then by node: the choices of the project filter. */
export function projectScopes<Node extends CatalogNode>(
  nodes: readonly Node[],
): ProjectScope<Node>[] {
  return nodes
    .flatMap((node) =>
      node.catalog.projects.map((project) => ({
        key: projectKey(node.target, project.id),
        node,
        project,
      })),
    )
    .toSorted((a, b) => a.project.name.localeCompare(b.project.name) || a.key.localeCompare(b.key));
}

/** A working duration as T3 shows it next to "Working": "45s", "12m", "1h 5m". */
export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
