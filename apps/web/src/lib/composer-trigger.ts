// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/shared/src/composerTrigger.ts,
// packages/shared/src/composerInlineTokens.ts, apps/web/src/composer-logic.ts and
// apps/web/src/composer-editor-mentions.ts at eb7b35ac.
//
// Pure helpers over the prompt, which is a markdown string: what the caret is typing (a `/`
// command, a `$` skill, an `@` path), how a picked file is written, and where the chips are.

type ComposerTriggerKind = "path" | "slash-command" | "skill";

export interface ComposerTrigger {
  readonly kind: ComposerTriggerKind;
  /** The text typed after the trigger character. */
  readonly query: string;
  /** Prompt offsets of the whole token, trigger character included: [rangeStart, rangeEnd). */
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

/** A picked file as the prompt writes it: a markdown link labelled with its basename. */
export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(basename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * A slash word with a second slash, such as `/tmp/build.sh`, is a path, not a command. The whole
 * word counts, so a caret before the second slash still sees it.
 */
export function isPathWord(text: string, wordStart: number, cursor: number): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespace(text[wordEnd] ?? "")) wordEnd += 1;
  return text.slice(wordStart + 1, wordEnd).includes("/");
}

/**
 * The trigger the caret is typing, read from the whitespace-delimited token that ends at the
 * caret: `/name` a command, `$name` (any currency sign) a skill, `@path` a file.
 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) index -= 1;
  const tokenStart = index + 1;
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) return null;
  return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

/** `/plan` or `/default` sent on its own switches the interaction mode instead of sending. */
export function parseStandaloneComposerSlashCommand(text: string): "plan" | "default" | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) return null;
  return match[1]?.toLowerCase() === "plan" ? "plan" : "default";
}

export type ComposerSendShortcut = "enter" | "mod-enter";

/**
 * Whether a keydown sends the prompt: Enter (or Mod+Enter when the shortcut asks for it), never
 * with Shift or Alt, and never while an input method is composing.
 */
export function submitsOnKey(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey" | "isComposing" | "keyCode"
  >,
  sendShortcut: ComposerSendShortcut,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return false;
  return sendShortcut === "enter" || event.metaKey || event.ctrlKey;
}

export type ComposerPromptSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly path: string; readonly source: string }
  | { readonly type: "skill"; readonly name: string; readonly source: string };

interface InlineToken {
  readonly type: "mention" | "skill";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

// T3 ends a token only at whitespace, since its editor rebuilds chips as you type. Here the
// prompt becomes chips only when it is set from outside (a menu pick, history, a draft), so a
// token may also end the prompt.
const TOKEN_END = "(?=\\s|$)";
const SKILL_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)${TOKEN_END}`,
  "gu",
);
const MENTION_TOKEN_REGEX = new RegExp(
  `(^|\\s)@(?:"((?:\\\\.|[^"\\\\])*)"|([^\\s@"]+))${TOKEN_END}`,
  "g",
);
/** Bounded so input like " [[[[…" cannot make the scan quadratic; 255 is the longest filename. */
const MAX_FILE_LINK_LABEL_LENGTH = 512;
const FILE_LINK_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\[((?:\\\\.|[^\\]\\\\]){0,${MAX_FILE_LINK_LABEL_LENGTH}})\\]\\(([^)\\s]+)\\)${TOKEN_END}`,
  "g",
);
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const SCOPED_PACKAGE_REFERENCE_REGEX =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;

function collectInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  for (const match of text.matchAll(FILE_LINK_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    const encoded = match[3] ?? "";
    let path = encoded;
    try {
      path = decodeURIComponent(encoded);
    } catch {}
    const external = URI_SCHEME_REGEX.test(path) && !WINDOWS_DRIVE_PATH_REGEX.test(path);
    // A link labelled with anything but its file's name is a link the user wrote, not a chip.
    if (!path || external || label !== basename(path)) continue;
    const start = (match.index ?? 0) + prefix.length;
    tokens.push({
      type: "mention",
      value: path,
      start,
      end: start + match[0].length - prefix.length,
    });
  }
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const quoted = match[2];
    const path = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (!path || (quoted === undefined && SCOPED_PACKAGE_REFERENCE_REGEX.test(path))) continue;
    const start = (match.index ?? 0) + prefix.length;
    tokens.push({
      type: "mention",
      value: path,
      start,
      end: start + match[0].length - prefix.length,
    });
  }
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value) continue;
    const start = (match.index ?? 0) + prefix.length;
    tokens.push({ type: "skill", value, start, end: start + match[0].length - prefix.length });
  }
  return tokens.toSorted((left, right) => left.start - right.start);
}

/**
 * The prompt as text and chips: a file link `[name](path)` or a legacy `@path` is a mention, a
 * `$name` a skill. Joining every segment's text or source gives the prompt back unchanged.
 */
export function splitPromptIntoSegments(prompt: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.type === "text")
      segments[segments.length - 1] = { type: "text", text: last.text + text };
    else segments.push({ type: "text", text });
  };
  let cursor = 0;
  for (const token of collectInlineTokens(prompt)) {
    if (token.start < cursor) continue;
    pushText(prompt.slice(cursor, token.start));
    const source = prompt.slice(token.start, token.end);
    segments.push(
      token.type === "mention"
        ? { type: "mention", path: token.value, source }
        : { type: "skill", name: token.value, source },
    );
    cursor = token.end;
  }
  pushText(prompt.slice(cursor));
  return segments;
}
