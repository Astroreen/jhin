import { visitKey, type NodeTarget, type ThreadRecord, type ThreadVisits } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

const STORAGE_KEY = "jhin.visits";

/** The nodes visits are shared through (D485): a thread's record, and its node's commands. */
export interface VisitNodes {
  record(target: NodeTarget, threadId: string): ThreadRecord | undefined;
  call(target: NodeTarget, method: string, params: unknown): Promise<unknown>;
}

/**
 * The visits of this device (`client.visits@1`), shared through `nodes` (D485), so finished turns can show as
 * unread. Kept in `storage`; a change made in another tab is taken in.
 */
export function createVisits(
  storage: Storage = localStorage,
  nodes?: VisitNodes,
): ThreadVisits & Disposable {
  /** The latest visit sent per thread, so each moves the node forward once. */
  const sent = new Map<string, string>();
  /** Times of a node compared as times: a visit may carry any offset. */
  const after = (a: string | undefined, b: string) =>
    a !== undefined && Date.parse(a) >= Date.parse(b);
  // A node that cannot take it (older, unreachable) keeps this device's visit
  // only; `onFail` lets the next visit try again.
  const tell = (target: NodeTarget, method: string, params: unknown, onFail = () => {}) =>
    void nodes?.call(target, method, params).catch(onFail);
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
      if (!after(seen[key], at)) {
        seen = { ...seen, [key]: at };
        save();
      }
      // Shared through the thread's node when it moves the node's visit forward (D485).
      if (after(nodes?.record(target, threadId)?.lastVisitedAt, at) || after(sent.get(key), at))
        return;
      sent.set(key, at);
      tell(target, "threads.visit", { threadId, at }, () => {
        if (sent.get(key) === at) sent.delete(key);
      });
    },
    markUnread(target, threadId) {
      const key = visitKey(target, threadId);
      seen = { ...seen, [key]: "1970-01-01T00:00:00.000Z" };
      sent.delete(key);
      save();
      tell(target, "threads.mark-unread", { threadId });
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
