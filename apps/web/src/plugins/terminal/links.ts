// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/terminal-links.ts, the
// link patterns of nightly eb7b35ac with the xterm.js buffer ranges of the version before acf761b2.
import { isMacPlatform } from "../../lib/keybindings.ts";

type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

interface TerminalLinkBufferPosition {
  x: number;
  y: number;
}

export interface TerminalLinkBufferRange {
  start: TerminalLinkBufferPosition;
  end: TerminalLinkBufferPosition;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
const FILE_PATH_PATTERN =
  /(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)+(?::\d+){0,2}/g;
const QUOTED_FILE_PATH_PATTERN =
  /(["'`])(?<path>(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|[A-Za-z0-9._ -]+[\\/])[^\r\n]*?|[A-Za-z0-9._ -]+\.[A-Za-z0-9_-]+(?::\d+){0,2})\1(?<position>(?::\d+){0,2})/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
// Paths also drop a trailing colon: compilers end `file:line:col:` with one.
const TRAILING_PATH_PUNCTUATION_PATTERN = /[.,;:!?]+$/;

function trimClosingDelimiters(value: string, kind: TerminalLinkKind): string {
  let output = value.replace(
    kind === "path" ? TRAILING_PATH_PUNCTUATION_PATTERN : TRAILING_PUNCTUATION_PATTERN,
    "",
  );
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const quotedPath = rawMatch.groups?.path;
    const raw =
      quotedPath === undefined ? rawMatch[0] : quotedPath + (rawMatch.groups?.position ?? "");
    const start = rawMatch.index + (quotedPath === undefined ? 0 : 1);
    if (start < 0 || raw.length === 0) continue;

    const trimmed = quotedPath === undefined ? trimClosingDelimiters(raw, kind) : raw;
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      // A position outside quotes spans the closing quote in the terminal buffer.
      end: start + trimmed.length + (rawMatch.groups?.position ? 1 : 0),
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const quotedMatches = collectMatches(line, "path", QUOTED_FILE_PATH_PATTERN, urlMatches);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, [
    ...urlMatches,
    ...quotedMatches,
  ]);
  return [...urlMatches, ...quotedMatches, ...pathMatches].toSorted((a, b) => a.start - b.start);
}

function isTerminalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

function resolveCharacterPosition(
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>,
  characterIndex: number,
): TerminalLinkBufferPosition {
  for (const segment of segments) {
    if (characterIndex < segment.endIndex) {
      return {
        x: characterIndex - segment.startIndex + 1,
        y: segment.bufferLineNumber,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  return {
    x: Math.max(lastSegment?.text.length ?? 0, 1),
    y: lastSegment?.bufferLineNumber ?? 1,
  };
}

export function resolveWrappedTerminalLinkRange(
  wrappedLine: WrappedTerminalLinkLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkBufferRange {
  return {
    start: resolveCharacterPosition(wrappedLine.segments, match.start),
    end: resolveCharacterPosition(wrappedLine.segments, match.end - 1),
  };
}

export function wrappedTerminalLinkRangeIntersectsBufferLine(
  range: TerminalLinkBufferRange,
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

// T3's packages/shared/src/fileLinks.ts and path.ts (eb7b35ac): a path link's target (D965).

/** A file and where in it, as a `path:line:column` link names it. */
export interface FilePathPosition {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

const POSITION_SUFFIX_CAPTURE_PATTERN = /:(\d+)(?::(\d+))?$/;

export function splitFilePathPosition(path: string): FilePathPosition {
  const match = path.match(POSITION_SUFFIX_CAPTURE_PATTERN);
  if (!match?.[1]) return { path };
  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return {
    path: path.slice(0, -match[0].length),
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

const isWindowsAbsolutePath = (value: string) =>
  value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
const isAbsolutePath = (value: string) => value.startsWith("/") || isWindowsAbsolutePath(value);
const isWindowsPathStyle = (value: string) =>
  isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) return `/Users/${posixUser[1]}`;
  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) return `/home/${posixHome[1]}`;
  return cwd.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i)?.[1];
}

/** T3's resolvePathLinkTarget: `~/` from the home `cwd` shows, a relative path joined to `cwd`. */
export function resolvePathLinkTarget(rawPath: string, cwd: string): FilePathPosition {
  const position = splitFilePathPosition(rawPath);
  const { path } = position;
  let resolved = path;
  if (path.startsWith("~/") || (isWindowsPathStyle(cwd) && path.startsWith("~\\"))) {
    const home = inferHomeFromCwd(cwd);
    if (home !== undefined)
      resolved = joinPath(home, path.slice(2), isWindowsPathStyle(home) ? "\\" : "/");
  } else if (!isAbsolutePath(path)) {
    resolved = joinPath(cwd, path, isWindowsPathStyle(cwd) ? "\\" : "/");
  }
  return { ...position, path: resolved };
}
