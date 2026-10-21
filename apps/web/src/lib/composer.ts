// Prompt history is derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/composerPromptHistory.ts. Drafts follow apps/web/src/composerDraftStore.ts.
import type { StoredAttachment } from "@jhin/agent-api";
import { targetKey, type NodeTarget } from "@jhin/client-api";

import { ATTACHMENT_LIMITS } from "./uploads.ts";

export interface PromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

export interface PromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

/** Oldest first; repeated prompts in a row collapse to the newest (like HISTCONTROL=ignoredups). */
export function buildPromptHistory(
  messages: readonly { readonly id: string; readonly text: string }[],
): PromptHistoryEntry[] {
  const entries: PromptHistoryEntry[] = [];
  for (const message of messages) {
    const prompt = message.text.trim();
    if (prompt === "") continue;
    const previous = entries.at(-1);
    if (previous !== undefined && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

function findActive(entries: readonly PromptHistoryEntry[], position: PromptHistoryPosition) {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  return byId >= 0 ? byId : entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

/**
 * One step through earlier prompts. Backward starts only from an empty
 * composer and stops at the oldest; forward past the newest empties the
 * composer and stops browsing. Editing a recalled prompt ends browsing.
 */
export function stepPromptHistory(input: {
  direction: "backward" | "forward";
  entries: readonly PromptHistoryEntry[];
  position: PromptHistoryPosition | null;
  currentPrompt: string;
}): { position: PromptHistoryPosition | null; prompt: string } | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position !== null && position.recalled === currentPrompt ? findActive(entries, position) : -1;
  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (entry === undefined) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }
  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (entry === undefined) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}

/** An uploaded attachment kept with a draft, with its thumbnail when it is an image. */
export type DraftAttachment = StoredAttachment & { readonly previewUrl?: string };

/** What a composer keeps between visits: its text and uploaded attachments. */
export interface ComposerDraft {
  readonly prompt: string;
  readonly attachments: readonly DraftAttachment[];
  /** When the text was last typed (ms), here or on another device (D486). */
  readonly at?: number;
}

/** Where drafts are shared with the owner's other devices (D486): their thread's node. */
export interface DraftsRemote {
  /** Keeps the text of the draft at `key` as of `at`; an empty text clears it. */
  send(key: string, prompt: string, at: number): void;
}

const DRAFTS_STORAGE_KEY = "jhin.drafts.v1";
/** Drafts with thumbnails can be large; beyond this the attachments are not kept. */
const MAX_STORED_BYTES = 2_000_000;

/**
 * Composer drafts per thread (or per project for a new thread), kept on this
 * device. Several tabs share them: a save merges this tab's changes into what
 * is stored, and a change saved by another tab is taken in.
 */
export function createDrafts(storage: Storage = localStorage, remote?: DraftsRemote) {
  const read = (): Record<string, ComposerDraft> => {
    try {
      const value: unknown = JSON.parse(storage.getItem(DRAFTS_STORAGE_KEY) ?? "{}");
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, ComposerDraft>)
        : {};
    } catch {
      return {};
    }
  };
  let drafts = read();
  /** Keys changed here since the last save: they win over what another tab stored. */
  const changed = new Set<string>();
  /** Texts typed here since the last save, with when: what goes to the node (D486). */
  const typed = new Map<string, { prompt: string; at: number }>();
  /**
   * When each draft forgotten here was cleared: an older text from the node
   * (the echo of what was typed before) must not bring it back (D486).
   */
  const cleared = new Map<string, number>();
  /** Composers following a key, told when another device's text is taken. */
  const followers = new Map<string, Set<(draft: ComposerDraft) => void>>();
  const mine = () =>
    Object.fromEntries([...changed].flatMap((key) => (drafts[key] ? [[key, drafts[key]]] : [])));
  const merged = () => {
    const next = { ...read(), ...mine() };
    for (const key of changed) if (drafts[key] === undefined) delete next[key];
    return next;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const [key, text] of typed) remote?.send(key, text.prompt, text.at);
    typed.clear();
    if (changed.size === 0) return;
    drafts = merged();
    changed.clear();
    let text = JSON.stringify(drafts);
    if (text.length > MAX_STORED_BYTES) {
      text = JSON.stringify(
        Object.fromEntries(
          Object.entries(drafts).map(([key, draft]) => [key, { ...draft, attachments: [] }]),
        ),
      );
    }
    try {
      storage.setItem(DRAFTS_STORAGE_KEY, text);
    } catch {
      // Full or blocked storage: drafts last for this page only.
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === DRAFTS_STORAGE_KEY) drafts = merged();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flush);
    window.addEventListener("storage", onStorage);
  }
  return {
    get: (key: string): ComposerDraft | undefined => drafts[key],
    set(key: string, draft: ComposerDraft) {
      const empty = draft.prompt === "" && draft.attachments.length === 0;
      if (empty && drafts[key] === undefined) return;
      // Typed now when the text changed; images alone are not shared.
      const before = drafts[key];
      const textChanged = (before?.prompt ?? "") !== draft.prompt;
      const at = textChanged ? Date.now() : before?.at;
      if (textChanged) typed.set(key, { prompt: draft.prompt, at: at! });
      const next = { ...drafts };
      if (empty) {
        delete next[key];
        if (at !== undefined) cleared.set(key, at);
      } else next[key] = at === undefined ? draft : { ...draft, at };
      drafts = next;
      changed.add(key);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    },
    /**
     * Takes another device's text for `key` when it is later than this one's
     * (D486), keeping this device's attachments; the composers following the
     * key are told. Returns whether it was taken.
     */
    take(key: string, prompt: string, at: number): boolean {
      const before = drafts[key];
      const latest = Math.max(before?.at ?? -1, cleared.get(key) ?? -1);
      if (at <= latest || (before?.prompt ?? "") === prompt) return false;
      const draft: ComposerDraft = { prompt, attachments: before?.attachments ?? [], at };
      const next = { ...drafts };
      if (prompt === "" && draft.attachments.length === 0) {
        delete next[key];
        cleared.set(key, at);
      } else next[key] = draft;
      drafts = next;
      changed.add(key);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 300);
      for (const follower of Array.from(followers.get(key) ?? [])) follower(draft);
      return true;
    },
    /** Follows `key` for texts taken from other devices. */
    follow(key: string, listener: (draft: ComposerDraft) => void): () => void {
      let set = followers.get(key);
      if (set === undefined) followers.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) followers.delete(key);
      };
    },
    /** Saves what changed now instead of shortly after. */
    flush,
    /** Saves what changed and stops following other tabs. */
    dispose() {
      flush();
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", flush);
        window.removeEventListener("storage", onStorage);
      }
    },
  };
}

export type Drafts = ReturnType<typeof createDrafts>;

/**
 * The node and the node's key of a draft key (D486): `thread:<id>` or
 * `project:<id>`, on the connection (and mesh member) the key names.
 */
export function nodeDraftKey(key: string): { target: NodeTarget; key: string } | undefined {
  const parts = key.split("|");
  const [node, remote, kind, id] =
    parts.length === 4 ? parts : [parts[0], undefined, parts[1], parts[2]];
  if (node === undefined || id === undefined || (kind !== "thread" && kind !== "draft")) return;
  return {
    target: remote === undefined ? { node } : { node, remote },
    key: `${kind === "thread" ? "thread" : "project"}:${id}`,
  };
}

/** Where a thread's composer keeps its draft. */
export const threadDraftKey = (target: NodeTarget, threadId: string) =>
  `${targetKey(target)}|thread|${threadId}`;

/** Where the composer of a new thread in a project keeps its draft. */
export const newThreadDraftKey = (target: NodeTarget, projectId: string) =>
  `${targetKey(target)}|draft|${projectId}`;

/** A draft with a sent message put back after it: its text after the draft's (a blank line between), its attachments after the draft's. */
export function appendToDraft(
  draft: ComposerDraft | undefined,
  message: ComposerDraft,
): ComposerDraft {
  const current = draft ?? { prompt: "", attachments: [] };
  const prompt =
    current.prompt.trim() === ""
      ? message.prompt
      : message.prompt === ""
        ? current.prompt
        : `${current.prompt}\n\n${message.prompt}`;
  return { prompt, attachments: [...current.attachments, ...message.attachments] };
}

/**
 * As T3 Code's "Edit from here" puts a message back: `appendToDraft`, or
 * `undefined` when the images do not fit beside the draft's (T3 refuses the
 * rewind then).
 */
export function restoreIntoDraft(
  draft: ComposerDraft | undefined,
  message: ComposerDraft,
): ComposerDraft | undefined {
  const { dropped } = fitAttachments(draft?.attachments ?? [], message.attachments);
  return dropped.length > 0 ? undefined : appendToDraft(draft, message);
}

/**
 * The attachments that fit together in one message (T3's limits: 100 of them,
 * 80 MiB of images), and those that do not. Sizes are what will be uploaded.
 */
export function fitAttachments<T extends { readonly kind: string; readonly sizeBytes: number }>(
  current: readonly T[],
  added: readonly T[],
  limit: { readonly count: number; readonly totalImageBytes: number } = ATTACHMENT_LIMITS,
): { kept: T[]; dropped: T[] } {
  const kept = [...current];
  const dropped: T[] = [];
  const imageBytes = (item: T) => (item.kind === "image" ? item.sizeBytes : 0);
  let total = current.reduce((sum, item) => sum + imageBytes(item), 0);
  for (const item of added) {
    if (kept.length >= limit.count || total + imageBytes(item) > limit.totalImageBytes) {
      dropped.push(item);
      continue;
    }
    kept.push(item);
    total += imageBytes(item);
  }
  return { kept, dropped };
}
