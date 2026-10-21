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
/** How a node older than `threads.search` (or a relay in front of it) says it has no such command. */
const UNKNOWN_COMMAND = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "UNKNOWN_COMMAND"]);
/** What `threads.search` takes at most (D227). */
const MAX_CONTENT_QUERY = 200;

/** The query a view asks the nodes for: trimmed, and a longer one cut to what they take. */
export const contentQuery = (raw: string) => raw.trim().slice(0, MAX_CONTENT_QUERY).trimEnd();
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
  /** The deadlines of the nodes still asked; a newer query or disposal clears them. */
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  const dropDeadlines = () => {
    for (const deadline of deadlines) clearTimeout(deadline);
    deadlines.clear();
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
        deadlines.add(deadline);
      });
      const answer = threads
        .call<{ matches: Omit<ContentMatch, "target">[] }>(target, "threads.search", { query })
        .then(
          (result): ContentMatch[] | "failed" =>
            result.matches.map((match) => ({ ...match, target })),
          // A node without the command finds nothing; any other failure is told apart.
          (error: unknown): ContentMatch[] | "failed" =>
            UNKNOWN_COMMAND.has(String((error as { code?: unknown } | null)?.code)) ? [] : "failed",
        );
      void Promise.race([answer, late])
        .finally(() => {
          clearTimeout(deadline);
          deadlines.delete(deadline!);
        })
        .then((found) => {
          if (id !== generation) return;
          waiting -= 1;
          if (found === "failed") failed += 1;
          else matches = [...matches, ...found].toSorted(byRank);
          publish({ query, pending: waiting > 0, matches, failed });
          if (found !== "failed") return;
          // Past its deadline: an answer that still comes for this query counts after all.
          void answer.then((late) => {
            if (id !== generation || late === "failed") return;
            failed -= 1;
            matches = [...matches, ...late].toSorted(byRank);
            publish({ query, pending: waiting > 0, matches, failed });
          });
        });
    }
  };
  return {
    get: () => state,
    /** Searches `query` on `targets`; the same request again does nothing. */
    request(raw: string, targets: readonly NodeTarget[]) {
      const query = contentQuery(raw);
      const key = `${query}\n${targets.map(targetKey).join("\n")}`;
      // The same request again asks nothing, unless a node failed it: then it is asked again.
      if (key === asked && !(state.failed > 0 && !state.pending)) return;
      asked = key;
      generation += 1;
      clearTimeout(timer);
      dropDeadlines();
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
      dropDeadlines();
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
  const trimmed = contentQuery(query);
  if (trimmed.length < MIN_CONTENT_QUERY) return false;
  return state.query !== trimmed || state.pending;
}

/** What a search's empty result says (T3's "No threads found"), and why it may be incomplete. */
export function emptySearchLabel(state: ContentSearchState, query: string): string {
  if (searchingContents(state, query)) return "Searching thread messages…";
  return state.failed > 0 && state.query === contentQuery(query)
    ? "No threads found. Some nodes could not search their messages."
    : "No threads found";
}

/** Splits a snippet around every occurrence of the query, ASCII case folded (T3's highlight). */
export function highlightParts(
  text: string,
  rawQuery: string,
): { readonly text: string; readonly highlighted: boolean }[] {
  // Whitespace collapsed, as the node matches and the snippet shows it.
  const query = rawQuery.replace(/\s+/g, " ").trim();
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
