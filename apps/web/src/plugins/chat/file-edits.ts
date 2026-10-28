// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/fileSaveCoordinator.ts (saving half a second after the last
// change, one write at a time, the newest winning), useFileSaveCoordinator.ts (a kept draft
// written again once write access returns), projectFilesQueryState.ts (a file's unsaved contents
// over what was read, until a read after its write) and ChatView.tsx (the pending `file:<path>`
// ids its tabs draw a dot for).
//
// What the file panel's edits share with its tab (t3-parity.md D1438, D1645–D1648), kept by the
// chat plugin while it runs: each file's unsaved text, whether a write of it is due, and the
// nodes that refused a write for want of permission.
import { targetKey, type Connections, type NodeTarget } from "@jhin/client-api";
import { useSyncExternalStore } from "react";

import { revealKey } from "./file-panel-route.ts";

/** T3's FILE_SAVE_DEBOUNCE_MS. */
export const SAVE_DEBOUNCE_MS = 500;

/**
 * T3's FileSaveCoordinator: the latest contents written half a second after the last change, one
 * write at a time, the newest winning; what is left is written when the file closes. Pending from
 * the first change until a write of the latest contents succeeds.
 */
export function createSaveCoordinator(options: {
  readonly debounceMs: number;
  /** False while nothing may be written (a read-only connection, D1646): the change waits. */
  readonly canPersist?: () => boolean;
  persist(contents: string): Promise<void>;
  onPendingChange(pending: boolean): void;
  /** A write succeeded; false when newer unsaved contents came meanwhile. */
  readonly onConfirmed?: (contents: string) => boolean | void;
  onError(error: unknown): void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = "";
  let revision = 0;
  let confirmed = 0;
  let lastChangeAt = 0;
  let saving = false;
  let disposed = false;
  const persistLatest = async (): Promise<void> => {
    if (saving || revision === confirmed) return;
    if (options.canPersist?.() === false) return;
    saving = true;
    const contents = latest;
    const saved = revision;
    let succeeded = false;
    try {
      await options.persist(contents);
      confirmed = saved;
      succeeded = options.onConfirmed?.(contents) !== false;
    } catch (error) {
      options.onError(error);
    } finally {
      saving = false;
    }
    if (saved === revision) {
      if (succeeded) options.onPendingChange(false);
      return;
    }
    if (disposed) void persistLatest();
    else schedule(Math.max(0, options.debounceMs - (Date.now() - lastChangeAt)));
  };
  const schedule = (delay: number) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void persistLatest();
    }, delay);
  };
  return {
    change(contents: string) {
      if (disposed) return;
      latest = contents;
      revision += 1;
      lastChangeAt = Date.now();
      options.onPendingChange(true);
      schedule(options.debounceMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (revision !== confirmed) void persistLatest();
    },
  };
}

export type SaveCoordinator = ReturnType<typeof createSaveCoordinator>;

/** A write the node refused for want of a permission (`projects.write`, D1646). */
export const isPermissionDenied = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "PERMISSION_DENIED";

/** A file's text as its edits left it: unsaved, or written and waiting for a read (T3's optimistic copy). */
interface FileDraft {
  readonly contents: string;
  /** Written: it shows until a read after the write replaces it. */
  readonly confirmed: boolean;
}

export interface FileEdits {
  /** The text a file of a place (its `revealKey`) shows over what was read, while it has one. */
  draft(key: string): FileDraft | undefined;
  /** Its text changed here: it shows over what was read (T3's `setProjectFileQueryData`). */
  edit(key: string, contents: string): void;
  /** A write of `contents` succeeded: the draft it was is kept until `settle`; false when it moved on. */
  confirm(key: string, contents: string): FileDraft | undefined;
  /** A read after the write came: the written draft goes, unless it changed since. */
  settle(key: string, draft: FileDraft): void;
  /** Whether a change of the file waits for a write that succeeds: the tab's dot (D1645). */
  pending(key: string): boolean;
  setPending(key: string, pending: boolean): void;
  /** The node refused a write for want of permission, until the connection to it changes (D1646). */
  readOnly(target: NodeTarget): boolean;
  refuse(target: NodeTarget): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createFileEdits(connections: Pick<Connections, "get" | "subscribe">): FileEdits {
  const drafts = new Map<string, FileDraft>();
  const pending = new Set<string>();
  /** The connection each refusal came on, and whether it has gone or changed since. */
  const refused = new Map<string, { node: string; client: unknown; changed: boolean }>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  // A new token or a reconnect gives write access its chance again: the kept edits are written.
  const following = connections.subscribe(() => {
    let lifted = false;
    for (const [key, refusal] of refused) {
      const connection = connections.get(refusal.node);
      if (
        connection === undefined ||
        connection.client !== refusal.client ||
        connection.state !== "open"
      ) {
        refusal.changed = true;
      }
      if (refusal.changed && connection?.state === "open") {
        refused.delete(key);
        lifted = true;
      }
    }
    if (lifted) notify();
  });
  return {
    draft: (key) => drafts.get(key),
    edit(key, contents) {
      drafts.set(key, { contents, confirmed: false });
      notify();
    },
    confirm(key, contents) {
      const draft = drafts.get(key);
      if (draft?.contents !== contents) return undefined;
      const confirmed = { contents, confirmed: true };
      drafts.set(key, confirmed);
      notify();
      return confirmed;
    },
    settle(key, draft) {
      if (drafts.get(key) !== draft) return;
      drafts.delete(key);
      notify();
    },
    pending: (key) => pending.has(key),
    setPending(key, value) {
      if (pending.has(key) === value) return;
      if (value) pending.add(key);
      else pending.delete(key);
      notify();
    },
    readOnly: (target) => refused.has(targetKey(target)),
    refuse(target) {
      const key = targetKey(target);
      if (refused.has(key)) return;
      refused.set(key, {
        node: target.node,
        client: connections.get(target.node)?.client,
        changed: false,
      });
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      following.dispose();
      listeners.clear();
    },
  };
}

/** Whether a file of a place has unsaved changes: its tab's dot (D1645). */
export function useFilePending(
  edits: FileEdits,
  place: { readonly target: NodeTarget; readonly threadId?: string; readonly projectId?: string },
  path: string,
): boolean {
  return useSyncExternalStore(edits.subscribe, () => edits.pending(revealKey(place, path)));
}
