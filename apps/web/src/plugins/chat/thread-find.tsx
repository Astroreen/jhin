// Find in a thread (mod+f) follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadFindBar.tsx, threadFind.ts and
// threadFindHighlights.ts, and packages/shared/src/threadSearch.ts (case folding).
// Jhin's timeline is not virtualized, so the find runs over the page's text
// rather than on the node (docs/plans/t3-parity.md, D801).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Sent to a fold holding the current match (D1351): its turn opens it, as T3's find opens the
 * work it found the match in.
 */
export const THREAD_FIND_UNFOLD_EVENT = "jhin-thread-find-unfold";
/** Folded work rendered hidden while the bar is open, so its text is found too. */
const FOLD = "[data-thread-find-fold]";

const HIGHLIGHT = "jhin-thread-find";
const ACTIVE_HIGHLIGHT = "jhin-thread-find-active";
/** What the find passes over: controls, icons and what is marked to be skipped. */
const IGNORE =
  'svg, button, input, textarea, [role="toolbar"], [aria-hidden="true"], [data-thread-find-ignore]';
/** Tags that end a run of text, so a match never spans two blocks (T3's THREAD_FIND_BLOCK_TAGS). */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

/** Lower case that keeps every offset where it was (T3's foldThreadSearchCase). */
function fold(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;
  let folded = "";
  for (const character of text) {
    const one = character.toLowerCase().replace(/ς/g, "σ");
    folded += one.length === character.length ? one : character;
  }
  return folded;
}

/** Where `query` occurs in `text`, case folded and not overlapping. */
export function findOccurrences(text: string, query: string): number[] {
  if (text.length === 0 || query.length === 0) return [];
  const haystack = fold(text);
  const needle = fold(query);
  const offsets: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    offsets.push(at);
  }
  return offsets;
}

/**
 * The matches of `query` in the text shown inside `container`, in document order.
 * Outside `<pre>` a run of white space counts as one space, as the browser shows it.
 */
export function findRanges(container: HTMLElement, query: string): Range[] {
  if (query.length === 0) return [];
  const ranges: Range[] = [];
  let text = "";
  /** Where each character of `text` is: its text node and its offset there. */
  let positions: { node: Node; offset: number }[] = [];
  const flush = () => {
    for (const offset of findOccurrences(text, query)) {
      const start = positions[offset];
      const end = positions[offset + query.length - 1];
      if (start === undefined || end === undefined) continue;
      const range = container.ownerDocument.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      ranges.push(range);
    }
    text = "";
    positions = [];
  };
  const visit = (node: Node, inPre: boolean) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
    // Skipped, and a break: the text on either side never joins into one match. What is hidden
    // is too, but the folded work kept to be found.
    if (
      element?.matches(IGNORE) === true ||
      (element?.hasAttribute("hidden") === true && !element.matches(FOLD))
    ) {
      flush();
      return;
    }
    const tag = element?.tagName.toLowerCase() ?? "";
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      for (let offset = 0; offset < value.length; offset++) {
        let character = value[offset]!;
        if (!inPre && /\s/.test(character)) {
          if (text === "" || text.endsWith(" ")) continue;
          character = " ";
        }
        text += character;
        positions.push({ node, offset });
      }
    }
    for (const child of node.childNodes) visit(child, inPre || tag === "pre");
    if (block) flush();
  };
  visit(container, false);
  flush();
  return ranges;
}

/** `index` moved by `delta`, wrapping around (T3's stepThreadFindIndex). */
export function stepIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const clamped = Math.min(Math.max(0, Math.trunc(index)), total - 1);
  return (((clamped + delta) % total) + total) % total;
}

/** "3/12", or "0/0" without matches (T3's formatThreadFindCount). */
export function formatCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${Math.min(Math.max(0, index), total - 1) + 1}/${total}`;
}

const highlightsSupported = () =>
  typeof CSS !== "undefined" && CSS.highlights !== undefined && typeof Highlight !== "undefined";

/**
 * The find of one thread view: whether its bar is open, what it looks for and
 * which match is current. Matches are painted with the CSS Custom Highlight
 * API, as in T3, and found again when the thread's text changes.
 */
export function useThreadFind(scroller: RefObject<HTMLElement | null>, threadKey: string) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [ranges, setRanges] = useState<readonly Range[]>([]);
  /** Bumped by each mod+f, so an open bar takes focus and selects its text again. */
  const [focusRequest, setFocusRequest] = useState(0);
  // Another thread starts with the bar closed (T3 keys the find by thread).
  useEffect(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, [threadKey]);

  const needle = open ? query.trim() : "";
  useEffect(() => {
    const container = scroller.current;
    if (container === null || needle === "") {
      setRanges([]);
      return;
    }
    const collect = () => setRanges(findRanges(container, needle));
    collect();
    // Streaming text, folds that open and turns that arrive change what matches.
    let frame: number | undefined;
    const observer = new MutationObserver(() => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        collect();
      });
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [needle, threadKey]);

  const current = ranges.length === 0 ? undefined : ranges[Math.min(active, ranges.length - 1)];
  useEffect(() => {
    if (!highlightsSupported()) return;
    const inactive = new Highlight(...ranges.filter((range) => range !== current));
    CSS.highlights.set(HIGHLIGHT, inactive);
    if (current === undefined) CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    else CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(current));
    return () => {
      CSS.highlights.delete(HIGHLIGHT);
      CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    };
  }, [ranges, current]);

  // The current match is scrolled into view when it changes, not when the
  // matches are found again around it.
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    const container = scroller.current;
    if (current === undefined || container === null) {
      scrolledTo.current = undefined;
      return;
    }
    const key = `${needle}|${active}`;
    if (scrolledTo.current === key) return;
    // In folded work: its turn unfolds it, and the match found there again is scrolled to.
    const fold = (
      current.startContainer instanceof Element
        ? current.startContainer
        : current.startContainer.parentElement
    )?.closest(FOLD);
    if (fold !== null && fold !== undefined) {
      fold.dispatchEvent(new CustomEvent(THREAD_FIND_UNFOLD_EVENT, { bubbles: true }));
      return;
    }
    scrolledTo.current = key;
    const box = current.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    if (box.top >= viewport.top && box.bottom <= viewport.bottom) return;
    container.scrollTop += box.top - viewport.top - (viewport.height - box.height) / 2;
  }, [current, needle, active]);

  const show = useCallback(() => {
    setOpen(true);
    setFocusRequest((request) => request + 1);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);
  const total = ranges.length;
  return {
    open: show,
    close,
    bar: {
      open,
      query,
      total,
      active,
      focusRequest,
      onQueryChange: (next: string) => {
        setQuery(next);
        setActive(0);
      },
      onNext: () => setActive((index) => stepIndex(index, total, 1)),
      onPrevious: () => setActive((index) => stepIndex(index, total, -1)),
      onClose: close,
    },
  };
}

export type ThreadFindBarProps = ReturnType<typeof useThreadFind>["bar"];
