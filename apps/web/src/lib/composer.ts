// Prompt history is derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/composerPromptHistory.ts. Drafts follow apps/web/src/composerDraftStore.ts.
import type { TurnAttachment } from "@jhin/agent-api";
import { targetKey, type NodeTarget } from "@jhin/client-api";

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

/** What a composer keeps between visits: its text and pasted images. */
export interface ComposerDraft {
  readonly prompt: string;
  readonly attachments: readonly TurnAttachment[];
}

const DRAFTS_STORAGE_KEY = "jhin.drafts.v1";
/** Drafts with images can be large; beyond this the images are not kept. */
const MAX_STORED_BYTES = 2_000_000;

/**
 * Composer drafts per thread (or per project for a new thread), kept on this
 * device. Several tabs share them: a save merges this tab's changes into what
 * is stored, and a change saved by another tab is taken in.
 */
export function createDrafts(storage: Storage = localStorage) {
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
      const next = { ...drafts };
      if (empty) delete next[key];
      else next[key] = draft;
      drafts = next;
      changed.add(key);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 300);
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

/** Where a thread's composer keeps its draft. */
export const threadDraftKey = (target: NodeTarget, threadId: string) =>
  `${targetKey(target)}|thread|${threadId}`;

/** Where the composer of a new thread in a project keeps its draft. */
export const newThreadDraftKey = (target: NodeTarget, projectId: string) =>
  `${targetKey(target)}|draft|${projectId}`;

/** A draft with a sent message put back after it: its text after the draft's (a blank line between), its images after the draft's. */
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

/** Images the composer accepts, as T3 Code does (HEIC is not converted here). */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Per image; the node takes data URLs up to 8 MB, and base64 adds a third. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** All images of one message, as data URLs; the node takes no more. */
const MAX_ATTACHMENTS_TOTAL = 20 * 1024 * 1024;

/** The attachments that fit together in one message, and those that do not. */
export function fitAttachments(
  current: readonly TurnAttachment[],
  added: readonly TurnAttachment[],
  limit = { count: 10, total: MAX_ATTACHMENTS_TOTAL },
): { kept: TurnAttachment[]; dropped: TurnAttachment[] } {
  const kept = [...current];
  const dropped: TurnAttachment[] = [];
  let total = current.reduce((sum, item) => sum + item.dataUrl.length, 0);
  for (const item of added) {
    if (kept.length >= limit.count || total + item.dataUrl.length > limit.total) {
      dropped.push(item);
      continue;
    }
    kept.push(item);
    total += item.dataUrl.length;
  }
  return { kept, dropped };
}

export function readImage(file: File): Promise<TurnAttachment> {
  return new Promise((resolve, reject) => {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
      reject(
        new Error(
          `'${file.name}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images.`,
        ),
      );
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`'${file.name}' is larger than 5 MB.`));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve({
        kind: "image",
        name: file.name || "image",
        mimeType: file.type,
        dataUrl: String(reader.result),
      }),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(`Cannot read '${file.name}'`)),
    );
    reader.readAsDataURL(file);
  });
}
