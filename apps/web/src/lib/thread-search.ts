// Searching thread contents from the client follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/state/queries.ts (useThreadSearch: two characters, a 200 ms pause, every
// environment) and packages/client-runtime/src/state/threadSearch.ts (merging their matches).
import { targetKey, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";

/** One thread a node found by its messages (`threads.search`, D227). */
export interface ContentMatch {
  readonly target: NodeTarget;
  readonly threadId: string;
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly at: string;
  /** The thread's last change on its node: matches sort by it after their source. */
  readonly updatedAt: string;
}

export interface ContentSearchState {
  /** The query the matches are for, trimmed; "" when nothing is searched. */
  readonly query: string;
  /** Some node has not answered yet. */
  readonly pending: boolean;
  /** User matches first, then the most recently changed thread, across nodes (D227's order). */
  readonly matches: readonly ContentMatch[];
  /**
   * Nodes whose search failed or did not answer in time: "no matches" from
   * them is not known. A node older than `threads.search` is not counted.
   */
  readonly failed: number;
}

/** T3 searches messages from two characters on. */
const MIN_CONTENT_QUERY = 2;
const DEBOUNCE_MS = 200;
/** A node that has not answered by then counts as finding nothing, so the view stops waiting. */
const NODE_DEADLINE_MS = 10_000;
const IDLE: ContentSearchState = { query: "", pending: false, matches: [], failed: 0 };

const byRank = (a: ContentMatch, b: ContentMatch) =>
  Number(a.source !== "user") - Number(b.source !== "user") ||
  b.updatedAt.localeCompare(a.updatedAt);

/**
 * The contents search of one view: `request` asks every given node after a
 * pause; only the newest request's answers count. A node that cannot search
 * (older than `threads.search`) or is out of reach adds no matches.
 */
export function createContentSearch(
  threads: Pick<ThreadsCatalog, "call">,
  options: { readonly debounceMs?: number; readonly deadlineMs?: number } = {},
) {
  let state = IDLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let asked = "";
  const listeners = new Set<() => void>();
  const publish = (next: ContentSearchState) => {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  };
  const run = (query: string, targets: readonly NodeTarget[], id: number) => {
    let waiting = targets.length;
    let matches: ContentMatch[] = [];
    let failed = 0;
    publish({ query, pending: waiting > 0, matches, failed });
    for (const target of targets) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<ContentMatch[] | "failed">((resolve) => {
        deadline = setTimeout(() => resolve("failed"), options.deadlineMs ?? NODE_DEADLINE_MS);
      });
      const answer = threads
        .call<{ matches: Omit<ContentMatch, "target">[] }>(target, "threads.search", { query })
        .then(
          (result): ContentMatch[] | "failed" =>
            result.matches.map((match) => ({ ...match, target })),
          // A node without the command finds nothing; any other failure is told apart.
          (error: unknown): ContentMatch[] | "failed" =>
            (error as { code?: unknown } | null)?.code === "COMMAND_NOT_FOUND" ? [] : "failed",
        );
      void Promise.race([answer, late])
        .finally(() => clearTimeout(deadline))
        .then((found) => {
          if (id !== generation) return;
          waiting -= 1;
          if (found === "failed") failed += 1;
          else matches = [...matches, ...found].toSorted(byRank);
          publish({ query, pending: waiting > 0, matches, failed });
        });
    }
  };
  return {
    get: () => state,
    /** Searches `query` on `targets`; the same request again does nothing. */
    request(raw: string, targets: readonly NodeTarget[]) {
      const query = raw.trim();
      const key = `${query}\n${targets.map(targetKey).join("\n")}`;
      if (key === asked) return;
      asked = key;
      generation += 1;
      clearTimeout(timer);
      if (query.length < MIN_CONTENT_QUERY) {
        publish(IDLE);
        return;
      }
      const id = generation;
      // Pending at once, so a view never says "No threads found" before asking.
      publish({
        query,
        pending: true,
        matches: state.query === query ? state.matches : [],
        failed: 0,
      });
      timer = setTimeout(() => run(query, targets, id), options.debounceMs ?? DEBOUNCE_MS);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      clearTimeout(timer);
      generation += 1;
      listeners.clear();
    },
  };
}

/**
 * Whether a view still waits for matches of `query`: also before its request
 * went out, so "No threads found" never shows for a render in between.
 */
export function searchingContents(state: ContentSearchState, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < MIN_CONTENT_QUERY) return false;
  return state.query !== trimmed || state.pending;
}

/** What a search's empty result says (T3's "No threads found"), and why it may be incomplete. */
export function emptySearchLabel(state: ContentSearchState, query: string): string {
  if (searchingContents(state, query)) return "Searching thread messages…";
  return state.failed > 0 && state.query === query.trim()
    ? "No threads found. Some nodes could not search their messages."
    : "No threads found";
}

/** Splits a snippet around every occurrence of the query, ASCII case folded (T3's highlight). */
export function highlightParts(
  text: string,
  rawQuery: string,
): { readonly text: string; readonly highlighted: boolean }[] {
  const query = rawQuery.trim();
  if (query === "") return [{ text, highlighted: false }];
  const fold = (value: string) => value.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const haystack = fold(text);
  const needle = fold(query);
  const parts: { text: string; highlighted: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) {
      parts.push({ text: text.slice(cursor), highlighted: false });
      break;
    }
    if (index > cursor) parts.push({ text: text.slice(cursor, index), highlighted: false });
    parts.push({ text: text.slice(index, index + needle.length), highlighted: true });
    cursor = index + needle.length;
  }
  return parts;
}
