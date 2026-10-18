// Prompt history is derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/composerPromptHistory.ts. Drafts follow apps/web/src/composerDraftStore.ts.
import type { TurnAttachment } from "@jhin/agent-api";

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

/** Composer drafts per thread (or per project for a new thread), kept on this device. */
export function createDrafts(storage: Storage = localStorage) {
  let drafts: Record<string, ComposerDraft> = {};
  try {
    const value: unknown = JSON.parse(storage.getItem(DRAFTS_STORAGE_KEY) ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      drafts = value as Record<string, ComposerDraft>;
    }
  } catch {
    drafts = {};
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
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
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        flush();
      }
    });
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
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    },
  };
}

export type Drafts = ReturnType<typeof createDrafts>;

/** Images the composer accepts, as T3 Code does (HEIC is not converted here). */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Per image; the node takes data URLs up to 8 MB, and base64 adds a third. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
