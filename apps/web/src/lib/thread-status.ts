// Status pills follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/Sidebar.logic.ts
// (legacy sidebar pills).
import type { ThreadRecord } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

export interface ThreadStatusPill {
  readonly label: string;
  readonly colorClass: string;
  readonly dotClass: string;
  readonly pulse: boolean;
  /** Higher wins when one pill stands for several threads (a collapsed project). */
  readonly priority: number;
}

const PILLS = {
  approval: {
    label: "Pending Approval",
    colorClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
    pulse: false,
    priority: 5,
  },
  input: {
    label: "Awaiting Input",
    colorClass: "text-indigo-600 dark:text-indigo-300/90",
    dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
    pulse: false,
    priority: 4,
  },
  working: {
    label: "Working",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    pulse: true,
    priority: 3,
  },
  failed: {
    label: "Failed",
    colorClass: "text-red-600 dark:text-red-300/90",
    dotClass: "bg-red-500 dark:bg-red-300/90",
    pulse: false,
    priority: 2,
  },
  completed: {
    label: "Completed",
    colorClass: "text-emerald-600 dark:text-emerald-300/90",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
    pulse: false,
    priority: 1,
  },
} as const satisfies Record<string, ThreadStatusPill>;

/**
 * The pill of a thread: what it waits for, that it works, failed, or finished
 * since the user last looked at it. A thread never opened counts as seen.
 */
export function threadStatusPill(
  thread: ThreadRecord,
  lastVisitedAt: string | undefined,
): ThreadStatusPill | null {
  const turn = thread.lastTurn;
  if (turn === undefined) return null;
  switch (turn.status) {
    case "waiting":
      return turn.waitingFor === "user-input" ? PILLS.input : PILLS.approval;
    case "running":
      return PILLS.working;
    case "failed":
      return lastVisitedAt !== undefined && lastVisitedAt >= turn.at ? null : PILLS.failed;
    case "completed":
      return lastVisitedAt !== undefined && lastVisitedAt < turn.at ? PILLS.completed : null;
    case "interrupted":
      return null;
  }
}

export function strongestPill(
  pills: readonly (ThreadStatusPill | null)[],
): ThreadStatusPill | null {
  let strongest: ThreadStatusPill | null = null;
  for (const pill of pills) {
    if (pill !== null && (strongest === null || pill.priority > strongest.priority))
      strongest = pill;
  }
  return strongest;
}

const STORAGE_KEY = "jhin.visits";

/**
 * When the user last looked at each thread (on this device), so finished
 * turns can show as unread. Keys are `<target>|<thread>`.
 */
export interface Visits {
  get(key: string): string | undefined;
  /** Records that the thread was seen as of `at` (a time of the thread's node). */
  visit(key: string, at: string): void;
  /** Marks the thread unread: its latest turn shows as new again. */
  markUnread(key: string): void;
  subscribe(listener: () => void): Disposable;
  /**
   * Every visit by key; a new object whenever one changes, so renders that
   * read it (memoized or not) see the change.
   */
  snapshot(): Readonly<Record<string, string>>;
}

export function createVisits(storage: Storage = localStorage): Visits {
  const listeners = new Set<() => void>();
  let seen: Readonly<Record<string, string>> = {};
  const load = () => {
    try {
      const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
      seen =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, string>)
          : {};
    } catch {
      seen = {};
    }
  };
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const save = () => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(seen));
    } catch {
      // Storage full or blocked: visits only last this page.
    }
    changed();
  };
  load();
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      load();
      changed();
    });
  }
  return {
    get: (key) => seen[key],
    visit(key, at) {
      if (seen[key] !== undefined && seen[key] >= at) return;
      seen = { ...seen, [key]: at };
      save();
    },
    markUnread(key) {
      seen = { ...seen, [key]: "1970-01-01T00:00:00.000Z" };
      save();
    },
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    snapshot: () => seen,
  };
}

/** The visits of this page, shared by the sidebar, the chat and notifications. */
let shared: Visits | undefined;
export function visits(): Visits {
  shared ??= createVisits();
  return shared;
}
