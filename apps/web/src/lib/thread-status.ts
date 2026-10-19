import { visitKey, type ThreadVisits, type TurnStatus } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

/** The statuses of a turn that ended. */
export const ENDED_STATUSES: ReadonlySet<TurnStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
]);

const STORAGE_KEY = "jhin.visits";

/**
 * The visits of this device (`client.visits@1`), so finished turns can show as
 * unread. Kept in `storage`; a change made in another tab is taken in.
 */
export function createVisits(storage: Storage = localStorage): ThreadVisits & Disposable {
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
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    load();
    changed();
  };
  load();
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return {
    get: (target, threadId) => seen[visitKey(target, threadId)],
    visit(target, threadId, at) {
      const key = visitKey(target, threadId);
      if (seen[key] !== undefined && seen[key] >= at) return;
      seen = { ...seen, [key]: at };
      save();
    },
    markUnread(target, threadId) {
      seen = { ...seen, [visitKey(target, threadId)]: "1970-01-01T00:00:00.000Z" };
      save();
    },
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    snapshot: () => seen,
    dispose() {
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    },
  };
}
