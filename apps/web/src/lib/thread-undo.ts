// Undoing a thread action follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/hooks/showThreadUndoNotice.ts and apps/web/src/hooks/threadUndo.ts.

/** What the notice says was done (T3's actions). */
export type UndoAction = "Settled" | "Snoozed" | "Unpinned" | "Archived" | "Discarded";

/** How long a notice offers its undo (T3's 5 seconds). */
export const UNDO_NOTICE_MS = 5_000;

/** The notice shown: the latest action and how many of it in a row. */
export interface UndoNotice {
  readonly action: UndoAction;
  readonly count: number;
}

/** A claim on undoing one kind of action on one thread; a later action of that kind on it voids it. */
export interface UndoClaim {
  isCurrent(): boolean;
  finish(): void;
}

interface Entry {
  readonly action: UndoAction;
  readonly claim: UndoClaim;
  readonly undo: () => Promise<void>;
  readonly failureTitle: string;
  readonly commit?: (() => void) | undefined;
}

/** "Unpinned 1 thread", "Discarded 2 drafts". */
export const undoNoticeText = (notice: UndoNotice) =>
  `${notice.action} ${notice.count} ${notice.action === "Discarded" ? "draft" : "thread"}${
    notice.count === 1 ? "" : "s"
  }`;

/**
 * The undo of thread actions, one store per client: `begin` claims an
 * action before it runs, `show` offers its undo once it succeeded. The
 * notice groups the latest run of one action; one undo restores the whole
 * group. A notice expires `UNDO_NOTICE_MS` after the latest action, which
 * commits what it held.
 */
export function createThreadUndo(options: {
  /** Says why an undo failed. */
  readonly fail: (title: string, error: unknown) => void;
  readonly timeoutMs?: number;
}) {
  const current = new Map<string, symbol>();
  const listeners = new Set<() => void>();
  let live: Entry[] = [];
  let notice: UndoNotice | undefined;
  let group: Entry[] = [];
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const refresh = () => {
    const stale = live.filter(({ claim }) => !claim.isCurrent());
    live = live.filter((entry) => !stale.includes(entry));
    for (const entry of stale) entry.commit?.();
    const latest = live.at(-1);
    group = [];
    if (latest === undefined) {
      clearTimeout(expiry);
      notice = undefined;
    } else {
      for (let index = live.length - 1; index >= 0; index -= 1) {
        const entry = live[index]!;
        if (entry.action !== latest.action) break;
        group.push(entry);
      }
      notice = { action: latest.action, count: group.length };
    }
    notify();
  };

  const keyOf = (kind: string, threadKey: string) => JSON.stringify([kind, threadKey]);

  return {
    /** Claims undoing `kind` for a thread; voids the claim before it. */
    begin(kind: string, threadKey: string): UndoClaim {
      const key = keyOf(kind, threadKey);
      const token = Symbol(kind);
      current.set(key, token);
      const isCurrent = () => current.get(key) === token;
      return {
        isCurrent,
        finish: () => {
          if (!isCurrent()) return;
          current.delete(key);
          refresh();
        },
      };
    },
    /** An action that undoes `kind` by itself (pinning a thread voids its unpin's undo). */
    invalidate(kind: string, threadKey: string): void {
      if (current.delete(keyOf(kind, threadKey))) refresh();
    },
    /** Offers the undo of a claimed action that succeeded. */
    show(entry: Entry): void {
      if (!entry.claim.isCurrent()) return;
      live.push(entry);
      refresh();
      clearTimeout(expiry);
      expiry = setTimeout(() => {
        const expired = live;
        live = [];
        for (const { claim, commit } of expired) {
          claim.finish();
          commit?.();
        }
        refresh();
      }, options.timeoutMs ?? UNDO_NOTICE_MS);
    },
    notice: () => notice,
    /** Undoes the notice's group; false when there is nothing to undo. */
    undoLatest(): boolean {
      if (notice === undefined) return false;
      const taken = group.filter((entry) => live.includes(entry) && entry.claim.isCurrent());
      live = live.filter((entry) => !group.includes(entry));
      // Every claim is used up before anything is awaited: a second undo restores nothing twice.
      for (const entry of taken) entry.claim.finish();
      refresh();
      void Promise.all(
        taken.map(async ({ undo, failureTitle }) => {
          try {
            await undo();
          } catch (error) {
            options.fail(failureTitle, error);
          }
        }),
      );
      return true;
    },
    subscribe(listener: () => void): { dispose(): void } {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose(): void {
      clearTimeout(expiry);
      listeners.clear();
    },
  };
}
