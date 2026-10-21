// Find in a thread (mod+f) follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadFindBar.tsx, threadFind.ts and
// threadFindHighlights.ts, and packages/shared/src/threadSearch.ts (case folding).
// Jhin's timeline is not virtualized, so the find runs over the page's text
// rather than on the node (docs/plans/t3-parity.md, D801).
import { Button, InputGroup, InputGroupAddon, InputGroupInput, cn } from "@jhin/ui";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

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

/** The matches of `query` in the text shown inside `container`, in document order. */
export function findRanges(container: HTMLElement, query: string): Range[] {
  if (query.length === 0) return [];
  const ranges: Range[] = [];
  let text = "";
  let nodes: { node: Node; start: number; end: number }[] = [];
  const flush = () => {
    let first = 0;
    let last = 0;
    for (const offset of findOccurrences(text, query)) {
      while (first < nodes.length && nodes[first]!.end <= offset) first++;
      if (last < first) last = first;
      while (last < nodes.length && nodes[last]!.end < offset + query.length) last++;
      const start = nodes[first];
      const end = nodes[last];
      if (start === undefined || end === undefined) continue;
      const range = container.ownerDocument.createRange();
      range.setStart(start.node, offset - start.start);
      range.setEnd(end.node, offset + query.length - end.start);
      ranges.push(range);
    }
    text = "";
    nodes = [];
  };
  const visit = (node: Node, inPre: boolean) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
    if (element?.matches(IGNORE) === true) {
      flush();
      return;
    }
    const tag = element?.tagName.toLowerCase() ?? "";
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      const start = text.length;
      text += inPre ? value : value.replace(/\r?\n/g, " ");
      nodes.push({ node, start, end: text.length });
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

/** T3's find bar: the field, "3/12", previous, next and close. */
export function ThreadFindBar(props: ThreadFindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.open) return;
    input.current?.focus();
    input.current?.select();
  }, [props.focusRequest, props.open]);
  if (!props.open) return null;

  const hasQuery = props.query.trim().length > 0;
  const noResults = hasQuery && props.total === 0;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) props.onPrevious();
    else props.onNext();
  };
  return (
    <div className="absolute top-3 right-3 z-40 w-[min(22rem,calc(100%-1.5rem))] transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none">
      <InputGroup
        aria-label="Find in thread"
        className="w-full"
        onContextMenu={(event) => event.stopPropagation()}
        role="search"
        size="lg"
        variant="popover"
      >
        <InputGroupInput
          aria-label="Find in thread"
          autoComplete="off"
          maxLength={200}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in thread"
          ref={input}
          size="sm"
          spellCheck={false}
          type="search"
          value={props.query}
        />
        <InputGroupAddon align="inline-end">
          <span
            aria-live="polite"
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              noResults ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {hasQuery ? formatCount(props.active, props.total) : ""}
          </span>
          <Button
            aria-label="Previous match"
            disabled={props.total === 0}
            onClick={props.onPrevious}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            aria-label="Next match"
            disabled={props.total === 0}
            onClick={props.onNext}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
          <Button aria-label="Close find" onClick={props.onClose} size="icon-xs" variant="ghost">
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
