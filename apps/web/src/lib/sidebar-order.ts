// What the sidebar lists and in which order follows T3 Code's sidebar (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/Sidebar.tsx (partitionSidebarThreads),
// Sidebar.logic.ts (statuses, sections, search, project scope),
// packages/client-runtime/src/state/threadSort.ts (pinned, active and settled order),
// threadSettled.ts (snoozing and waking) and
// apps/server/src/orchestration-v2/ThreadSettlementService.ts (when a thread settles by itself).
import {
  targetKey,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
  type ThreadSection,
} from "@jhin/client-api";

import { sortActive, sortPinned } from "./thread-order.ts";

/** Settled threads shown at first, and how many more each "Show more" adds. */
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;

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
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "limited"
  | "failed"
  | "ready";

/**
 * `waiting`: between its turns the thread waits on background work, such as a
 * watched pull request (T3's `backgroundWorkHoldsCompletion`, D1131).
 */
export function sidebarThreadStatus(thread: ThreadRecord, waiting = false): SidebarThreadStatus {
  const turn = thread.lastTurn;
  if (turn?.status === "waiting") return turn.waitingFor === "user-input" ? "input" : "approval";
  if (turn?.status === "running") return "working";
  if (waiting) return "waiting";
  // A turn that hit a usage limit is "limited", not "failed" (t3-parity.md D1307).
  if (turn?.status === "failed")
    return turn.failure?.class === "usage_limit" ? "limited" : "failed";
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

export type SidebarTopStatus =
  | "working"
  | "waiting"
  | "approval"
  | "input"
  | "goal"
  | "limited"
  | "failed"
  | "woke"
  | "done";

/** What the top line of a thread's card says instead of its time (T3's resolveSidebarV2TopStatus). */
export function sidebarTopStatus(
  status: SidebarThreadStatus,
  unread: boolean,
  woke = false,
  /** The thread pursues a goal: "Goal" instead of "Working" (D1307). */
  goal = false,
): SidebarTopStatus | null {
  if (status === "working" && goal) return "goal";
  if (status !== "ready") return status;
  if (woke) return "woke";
  return unread ? "done" : null;
}

/** A thread the user need not look at fades back (T3's shouldRecedeSidebarThread). */
export function shouldRecede(input: {
  status: SidebarThreadStatus;
  unread: boolean;
  active: boolean;
  woke?: boolean;
}): boolean {
  if (input.active || input.status === "input") return false;
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.unread && input.woke !== true;
  }
  return false;
}

/**
 * Whether a thread's card says it woke: it woke after the last visit (or was
 * never visited on this device), and is not settled by hand (T3's isWoke).
 */
export function isWoke(
  thread: ThreadRecord,
  lastVisitedAt: string | undefined,
  nowMs: number,
): boolean {
  const at = wokeAt(thread, nowMs);
  if (at === undefined || thread.settledOverride === "settled") return false;
  const visited = lastVisitedAt === undefined ? Number.NaN : Date.parse(lastVisitedAt);
  return Number.isNaN(visited) || visited < Date.parse(at);
}

const parse = (at: string | undefined) => (at === undefined ? Number.NaN : Date.parse(at));

/**
 * A snoozed thread that asked for something, failed or completed since it was
 * snoozed is awake before its time (T3's threadRaisedHandWhileSnoozed).
 */
function raisedHand(thread: ThreadRecord): boolean {
  const turn = thread.lastTurn;
  if (turn === undefined) return false;
  if (turn.status === "waiting") return true;
  if (turn.status !== "failed" && turn.status !== "completed") return false;
  const snoozedAt = parse(thread.snoozedAt);
  return Number.isNaN(snoozedAt) ? turn.status === "failed" : parse(turn.at) > snoozedAt;
}

/** On the Snoozed shelf now: snoozed until later, and nothing woke it (T3's effectiveSnoozed). */
export function isSnoozed(thread: ThreadRecord, nowMs: number): boolean {
  const until = parse(thread.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs && !raisedHand(thread);
}

/** A thread waiting for an answer cannot be snoozed (T3's canSnooze). */
export const canSnooze = (thread: ThreadRecord) => thread.lastTurn?.status !== "waiting";

/**
 * When a snoozed thread woke, if it did: when it raised its hand, else when
 * its time came (T3's threadWokeAt). Its card says "Woke" until a visit after that.
 */
export function wokeAt(thread: ThreadRecord, nowMs: number): string | undefined {
  const until = parse(thread.snoozedUntil);
  if (Number.isNaN(until)) return undefined;
  if (raisedHand(thread)) return thread.lastTurn?.at;
  return until <= nowMs ? thread.snoozedUntil : undefined;
}

/**
 * When the thread settled, if it has: as its node recorded it, by hand (D75)
 * or by the node's own rule (D446, its sweep after the configured days
 * without activity, or a merged pull request, D447). As in T3, the client
 * settles nothing by itself: only the node knows its rule.
 */
export function settledAt(thread: ThreadRecord, _nowMs?: number): string | undefined {
  if (thread.archivedAt !== undefined || thread.settledOverride !== "settled") return undefined;
  return Number.isNaN(parse(thread.settledAt)) ? threadActivityAt(thread) : thread.settledAt;
}

/** Where the sidebar lists a thread now (T3's resolveSidebarThreadSection). */
export function threadSection(thread: ThreadRecord, nowMs: number): ThreadSection {
  if (isSnoozed(thread, nowMs)) return "snoozed";
  if (settledAt(thread, nowMs) !== undefined) return "settled";
  if (thread.pinnedAt !== undefined) return "pinned";
  return "active";
}

/** A thread as the sidebar lists it, with its node and its project. */
export interface SidebarThread<Node extends { readonly target: NodeTarget }> {
  readonly key: string;
  readonly node: Node;
  readonly thread: ThreadRecord;
  readonly project: ProjectRecord | undefined;
  readonly section: ThreadSection;
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

const byKey = <T extends { readonly key: string }>(a: T, b: T) => a.key.localeCompare(b.key);
const sortable = (value: string | undefined) => {
  const ms = parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * A thread at work (T3's isThreadWorking): its turn runs and asks nothing of
 * the user. One waiting for an answer needs the user, so it stays active.
 */
const isWorking = (thread: ThreadRecord): boolean => thread.lastTurn?.status === "running";

/**
 * When a thread came back to the inbox from the Working section: its turn
 * ended or asks for something (T3's createInboxReturnTracker, read from the
 * record instead of remembered).
 */
const returnedAt = (thread: ThreadRecord): string | undefined =>
  thread.lastTurn !== undefined && thread.lastTurn.status !== "running"
    ? thread.lastTurn.at
    : undefined;

const later = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined ? a : sortable(a) >= sortable(b) ? a : b;

/**
 * The threads of every shown node in one list, without a section per node or
 * project, split as T3 splits them: the pinned ones on top in their order,
 * then the active ones (newest first by when they were created or came back
 * from the shelf, then those dragged into place), the snoozed ones by when
 * they wake and the settled ones by when they settled. Archived threads are
 * not listed; `scope` (a `projectKey`) keeps one project's threads.
 */
export function sidebarThreads<Node extends CatalogNode>(
  nodes: readonly Node[],
  options: {
    readonly nowMs: number;
    readonly scope?: string | undefined;
    /** T3's Working section (beta, a device setting): threads at work leave the inbox for it. */
    readonly working?: boolean | undefined;
    /** A thread that waits on background work (D1131): it is at work too. */
    readonly waiting?: ((node: Node, thread: ThreadRecord) => boolean) | undefined;
  },
): Record<ThreadSection, SidebarThread<Node>[]> {
  const lists: Record<ThreadSection, SidebarThread<Node>[]> = {
    pinned: [],
    active: [],
    working: [],
    snoozed: [],
    settled: [],
  };
  for (const node of nodes) {
    const projects = new Map(node.catalog.projects.map((project) => [project.id, project]));
    for (const thread of node.catalog.threads) {
      if (thread.archivedAt !== undefined) continue;
      // A delegated task's thread opens from its parent's chat, as in T3 (D865).
      if (thread.relationshipToParent === "subagent") continue;
      if (
        options.scope !== undefined &&
        projectKey(node.target, thread.projectId) !== options.scope
      ) {
        continue;
      }
      let section = threadSection(thread, options.nowMs);
      if (
        section === "active" &&
        options.working === true &&
        (isWorking(thread) ||
          // One that asks the user something stays in the inbox, watched or not.
          (thread.lastTurn?.status !== "waiting" && options.waiting?.(node, thread) === true))
      )
        section = "working";
      const at = section === "settled" ? settledAt(thread, options.nowMs) : undefined;
      lists[section].push({
        key: threadKey(node.target, thread.id),
        node,
        thread,
        project: projects.get(thread.projectId),
        section,
        ...(at === undefined ? {} : { settledAt: at }),
      });
    }
  }
  return {
    pinned: sortPinned(lists.pinned, (entry) => ({
      key: entry.key,
      createdAt: entry.thread.createdAt,
      orderKey: entry.thread.pinOrderKey,
    })),
    active: sortActive(lists.active, (entry) => ({
      key: entry.key,
      createdAt: entry.thread.createdAt,
      // With the Working section, a thread back from it is on top (T3's sortInboxThreadsByReturn).
      unsettledAt:
        options.working === true
          ? later(entry.thread.unsettledAt, returnedAt(entry.thread))
          : entry.thread.unsettledAt,
      // With the Working section the inbox is ordered by time, not by hand (T3's activeTimeOrdered).
      orderKey: options.working === true ? undefined : entry.thread.activeOrderKey,
    })),
    // Newest sent first (T3's sortWorkingThreadsBySend).
    working: lists.working.toSorted(
      (a, b) =>
        sortable(later(b.thread.createdAt, b.thread.lastMessageAt)) -
          sortable(later(a.thread.createdAt, a.thread.lastMessageAt)) || byKey(a, b),
    ),
    snoozed: lists.snoozed.toSorted(
      (a, b) => sortable(a.thread.snoozedUntil) - sortable(b.thread.snoozedUntil) || byKey(a, b),
    ),
    settled: lists.settled.toSorted(
      (a, b) => sortable(b.settledAt) - sortable(a.settledAt) || byKey(a, b),
    ),
  };
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

/**
 * A row's accessible name, T3's "title, status, project", and while several
 * nodes are shown the node too: two projects of one name on two nodes, or
 * their threads, must not read the same.
 */
export function rowLabel(parts: readonly (string | null | undefined)[], node: string | undefined) {
  const label = parts.filter(Boolean).join(", ");
  return node === undefined ? label : `${label} on ${node}`;
}
