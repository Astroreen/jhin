/**
 * The parts of a Markdown page the context library addresses: front matter,
 * headings with their GitHub anchors, sections, decisions and routes.
 */

export const MATURITY_LEVELS = ["observation", "note", "insight", "canon"] as const;
export type Maturity = (typeof MATURITY_LEVELS)[number];

const isMaturity = (value: unknown): value is Maturity =>
  (MATURITY_LEVELS as readonly unknown[]).includes(value);

/** Higher is more trusted; canon wins on conflicts (D665). */
export const maturityRank = (level: Maturity | undefined): number =>
  level === undefined ? 0 : MATURITY_LEVELS.indexOf(level) + 1;

export interface Heading {
  /** 1–6. */
  readonly depth: number;
  readonly text: string;
  /** GitHub's anchor: `docs/plans/terminal.md#deferred`. */
  readonly anchor: string;
  /** 0-based line of the heading in the page body (after front matter). */
  readonly line: number;
  /** 0-based line where the section ends (exclusive). */
  readonly end: number;
}

/** A route out of a page: a Markdown link, or a path in backticks (D664). */
interface Route {
  readonly kind: "link" | "mention";
  /** The target as written, without the fragment. Empty for `#anchor` links. */
  readonly target: string;
  readonly fragment: string | undefined;
  /** 1-based line in the whole file, for reports. */
  readonly line: number;
}

export interface Page {
  readonly frontMatter: Readonly<Record<string, string>>;
  /** The page without its front matter. */
  readonly body: string;
  readonly lines: readonly string[];
  readonly headings: readonly Heading[];
  /** Decision ids (`D11`) found as `**D11.` at the start of a paragraph or list item. */
  readonly decisions: readonly string[];
  /** The line of each decision's first `**D11.` outside a code block. */
  readonly decisionLines: ReadonlyMap<string, number>;
  readonly routes: readonly Route[];
}

/** CommonMark fences: three or more of one character; a fence closes only on one at least as long. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A closing `##` must follow a space: `## Learning C#` keeps its `#`. */
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const DECISION = /^\s*(?:[-*]\s+|\d+\.\s+)?\*\*(D\d+)\./;
/** `[x](target "title")`, or `[x](<target with spaces>)` as CommonMark allows. */
const LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^>\n]*)>|([^)\s]*))(?:\s+"[^"]*")?\s*\)/g;
const CODE_SPAN = /`([^`\n]+)`/g;
/** A backtick span that names a Markdown file or directory: `docs/map.md#shape`, `docs/lore/`. */
const PATH_MENTION = /^(?:\.{0,2}\/)?(?:[\w@.-]+\/)*(?:[\w@.-]+\.md|[\w@.-]+\/)(?:#[\w-]+)?$/;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** `%20` → space; a malformed escape (`100%.md`) stays as written, to be reported as a broken route. */
function decode(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** The open fence after `line`, given the one open before it, and whether `line` is a fence. */
function fenceAfter(
  line: string,
  fence: string | undefined,
): { fence: string | undefined; isFence: boolean } {
  const match = FENCE.exec(line);
  if (match === null) return { fence, isFence: false };
  const marker = match[1]!;
  if (fence === undefined) return { fence: marker, isFence: true };
  const closes = marker[0] === fence[0] && marker.length >= fence.length && match[2]!.trim() === "";
  return { fence: closes ? undefined : fence, isFence: true };
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function parseFrontMatter(text: string): {
  frontMatter: Record<string, string>;
  body: string;
  offset: number;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) return { frontMatter: {}, body: text, offset: 0 };
  const frontMatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([\w.#-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (pair === null) continue;
    frontMatter[pair[1]!] = pair[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return {
    frontMatter,
    body: text.slice(match[0].length),
    offset: match[0].split("\n").length - 1,
  };
}

export function parsePage(text: string): Page {
  const { frontMatter, body, offset } = parseFrontMatter(text);
  const lines = body.split(/\r?\n/);
  const open: { depth: number; text: string; anchor: string; line: number }[] = [];
  const counts = new Map<string, number>();
  const decisions: string[] = [];
  const decisionLines = new Map<string, number>();
  const routes: Route[] = [];
  let fence: string | undefined;

  for (const [index, line] of lines.entries()) {
    const next = fenceAfter(line, fence);
    if (next.isFence) {
      fence = next.fence;
      continue;
    }
    if (fence !== undefined) continue;

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const text = heading[2]!;
      const base = slug(text);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      open.push({
        depth: heading[1]!.length,
        text,
        anchor: seen === 0 ? base : `${base}-${seen}`,
        line: index,
      });
    }
    const decision = DECISION.exec(line);
    if (decision !== null) {
      decisions.push(decision[1]!);
      if (!decisionLines.has(decision[1]!)) decisionLines.set(decision[1]!, index);
    }

    const fileLine = index + offset + 1;
    // Links inside code spans are code, not routes.
    const prose = line.replace(CODE_SPAN, (span) => " ".repeat(span.length));
    for (const link of prose.matchAll(LINK)) {
      const raw = link[1] ?? link[2] ?? "";
      if (raw === "" || EXTERNAL.test(raw)) continue;
      const hash = raw.indexOf("#");
      routes.push({
        kind: "link",
        target: decode(hash < 0 ? raw : raw.slice(0, hash)),
        fragment: hash < 0 ? undefined : raw.slice(hash + 1),
        line: fileLine,
      });
    }
    // A path in a link's text is the link's label, not a second route.
    for (const span of line.replace(LINK, (link) => " ".repeat(link.length)).matchAll(CODE_SPAN)) {
      const raw = span[1]!.trim();
      if (!PATH_MENTION.test(raw)) continue;
      const hash = raw.indexOf("#");
      routes.push({
        kind: "mention",
        target: hash < 0 ? raw : raw.slice(0, hash),
        fragment: hash < 0 ? undefined : raw.slice(hash + 1),
        line: fileLine,
      });
    }
  }

  const headings: Heading[] = open.map((heading, index) => {
    const next = open.slice(index + 1).find((later) => later.depth <= heading.depth);
    return { ...heading, end: next?.line ?? lines.length };
  });
  return { frontMatter, body, lines, headings, decisions, decisionLines, routes };
}

/** The heading an address names: its anchor, its text (any case), or undefined. */
export function findHeading(page: Page, heading: string): Heading | undefined {
  const wanted = heading.replace(/^#/, "");
  return (
    page.headings.find((candidate) => candidate.anchor === wanted) ??
    page.headings.find((candidate) => candidate.text.toLowerCase() === wanted.toLowerCase()) ??
    page.headings.find((candidate) => candidate.anchor === slug(wanted))
  );
}

/**
 * The lines of decision `id`: from its `**D11.` to the next decision, heading
 * or blank line after a paragraph that is not a continuation.
 */
export function decisionRange(page: Page, id: string): { line: number; end: number } | undefined {
  // A `**D11.` in a code block is an example, not the decision.
  const start = page.decisionLines.get(id);
  if (start === undefined) return undefined;
  let end = start + 1;
  let fence: string | undefined;
  for (; end < page.lines.length; end += 1) {
    const line = page.lines[end]!;
    // A code block inside the decision belongs to it, blank lines and `#`s included.
    const next = fenceAfter(line, fence);
    if (next.isFence || fence !== undefined) {
      fence = next.fence;
      continue;
    }
    if (DECISION.test(line) || HEADING.test(line)) break;
    // A blank line ends it unless the next line is indented (the same list item).
    if (line.trim() === "" && !/^\s+\S/.test(page.lines[end + 1] ?? "")) break;
  }
  return { line: start, end };
}

/** The maturity marked for a section: `maturity.<anchor>` in front matter, inherited from enclosing sections, then the page. */
export function markedMaturity(page: Page, heading: Heading | undefined): Maturity | undefined {
  if (heading !== undefined) {
    const enclosing = page.headings
      .filter((candidate) => candidate.line <= heading.line && candidate.end >= heading.end)
      .toSorted((a, b) => b.depth - a.depth);
    for (const candidate of enclosing) {
      const level = page.frontMatter[`maturity.${candidate.anchor}`];
      if (isMaturity(level)) return level;
    }
  }
  const level = page.frontMatter.maturity;
  return isMaturity(level) ? level : undefined;
}
