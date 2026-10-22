// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/ComposerPromptEditorTiptap.tsx, apps/web/src/composer-rich-text-doc.ts,
// apps/web/src/composer-rich-text.ts, apps/web/src/composer-code-block.ts,
// apps/web/src/composer-undo-grouping.ts, apps/web/src/composer-list-continuation.ts and
// apps/web/src/composer-editor-mentions.ts at eb7b35ac.
//
// The composer's prompt editor (D303): a tiptap document over a prompt that stays a markdown
// string. Inline marks, lists, task lists, quotes, headings, rules and code blocks show styled;
// file links, skills, pull requests and threads show as chips that write back their exact text. The parent owns the prompt, its history and its menus.
// Without rich text (T3's "Rich text composer" off) the prompt shows its markdown as typed and
// keeps only the chips; literal text (T3's prefilled answer) keeps not even those.
import { cn } from "@jhin/ui";
import {
  type Command,
  type Editor,
  Extension,
  InputRule,
  type JSONContent,
  mergeAttributes,
  Node,
  wrappingInputRule,
} from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import {
  exitCode,
  joinBackward,
  joinTextblockBackward,
  joinTextblockForward,
  newlineInCode,
  splitBlockKeepMarks,
} from "@tiptap/pm/commands";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import {
  Fragment,
  type NodeType,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

import {
  type ComposerSendShortcut,
  splitPromptIntoSegments,
  submitsOnKey,
} from "../../lib/composer-trigger.ts";
import { ComposerCodeBlockHighlight } from "./code-block-highlight.ts";
import { CODE_BLOCK_HEADER_CLASS_NAME, CodeBlockView } from "./code-block-view.tsx";
import { MentionNodeView, ReferenceNodeView, SkillNodeView } from "./composer-chips.tsx";

export interface PromptEditorHandle {
  focus(): void;
  /** Caret position in the markdown string. */
  cursor(): number;
  /** Replaces [start, end) of the markdown string and puts the caret after the inserted text. */
  replaceRange(start: number, end: number, text: string): void;
  /** Sets the whole prompt and puts the caret at the end. */
  setValue(value: string): void;
  /** The prompt as the editor holds it now, ahead of a render that reports it. */
  value(): string;
  caretOnFirstLine(): boolean;
  caretOnLastLine(): boolean;
}

export interface PromptEditorProps {
  /** The prompt, a markdown string. Setting it from outside rebuilds the document. */
  readonly value: string;
  /** Every edit and caret move, with the caret as an offset in the markdown string. */
  onChange(value: string, cursor: number): void;
  /** Called first for every keydown; `true` means the parent handled it and the editor does nothing. */
  readonly onKeyDown?: ((event: KeyboardEvent) => boolean) | undefined;
  onSubmit(): void;
  /** Called first for every paste; `true` means the parent took it (files, large text). */
  readonly onPaste?: ((event: ClipboardEvent) => boolean) | undefined;
  readonly onFocus?: (() => void) | undefined;
  readonly onBlur?: (() => void) | undefined;
  readonly placeholder: string;
  readonly disabled?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly sendShortcut: ComposerSendShortcut;
  /**
   * Markdown shows formatted as it is typed (T3's `richTextEnabled`, default on). Off, the prompt
   * is plain text with chips: no marks, no blocks, no markdown input rules.
   */
  readonly richText?: boolean | undefined;
  /**
   * The prompt is taken character for character (T3's `literalText`): no formatting, no chips and
   * no surround, and a paste goes in as it is. Wins over `richText`.
   */
  readonly literalText?: boolean | undefined;
  /** Classes of the editable element. */
  readonly className?: string | undefined;
  readonly handleRef?: Ref<PromptEditorHandle> | undefined;
}

// ---------------------------------------------------------------------------------------------
// Inline markdown (composer-rich-text.ts)

type RichTextMark = "bold" | "italic" | "strike" | "code";

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

function isRichTextMark(name: string): name is RichTextMark {
  return name === "bold" || name === "italic" || name === "strike" || name === "code";
}

function pushSpan(spans: RichTextSpan[], text: string, marks: RichTextMark[]): void {
  if (!text) return;
  const last = spans.at(-1);
  if (
    last &&
    last.marks.length === marks.length &&
    last.marks.every((mark, index) => mark === marks[index])
  ) {
    last.text += text;
  } else {
    spans.push({ text, marks });
  }
}

function parseInlineMarkdown(text: string): RichTextSpan[] {
  const root: RichTextSpan[] = [];
  const stack: { delimiter: string; mark: RichTextMark; spans: RichTextSpan[] }[] = [];
  const current = () => stack.at(-1)?.spans ?? root;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      pushSpan(current(), text.slice(index, index + 2), []);
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      if (
        run.length === 1 &&
        close > index + 1 &&
        !text.slice(index, close).includes("\n") &&
        text[close + 1] !== "`"
      ) {
        pushSpan(current(), text.slice(index + 1, close), ["code"]);
        index = close + 1;
      } else {
        pushSpan(current(), run, []);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      pushSpan(current(), char, []);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const span of top.spans) pushSpan(current(), span.text, [top.mark, ...span.marks]);
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // A mark cannot nest inside itself, which bounds the stack for any input.
        if (stack.some((frame) => frame.mark === mark)) {
          pushSpan(current(), text.slice(index, end), []);
          index = end;
          continue;
        }
        stack.push({ delimiter: char.repeat(length), mark, spans: [] });
        index += length;
      } else {
        pushSpan(current(), text.slice(index, end), []);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    pushSpan(current(), frame.delimiter, []);
    for (const span of frame.spans) pushSpan(current(), span.text, span.marks);
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// Markdown to document (composer-rich-text-doc.ts: buildTiptapContent)

type Json = Record<string, unknown>;

function parseOpeningFence(line: string): { fence: string; language: string } | null {
  // `[^\n]` rather than `.`: a CRLF draft's lines end in `\r`, which `.` refuses.
  const match = /^(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const language = match[2]!;
  if (fence.startsWith("`") && language.includes("`")) return null;
  return { fence, language };
}

function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence[0] && run.length >= fence.length;
}

interface TaskLinePrefix {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = /^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/.exec(head);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[3] ?? " ").toLowerCase() === "x",
      markerSpace: match[2]!,
      contentSpace: match[4]!,
    },
    markerLength: match[0].length,
  };
}

type ListLinePrefix =
  | ({ kind: "task" } & TaskLinePrefix)
  | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };

/**
 * A task first (it also looks like a bullet), then an ordered marker, then a bullet, the grammar
 * the literal continuation uses too.
 */
function parseListPrefix(line: string): { prefix: ListLinePrefix; markerLength: number } | null {
  const task = parseTaskPrefix(line);
  if (task) return { prefix: { kind: "task", ...task.prefix }, markerLength: task.markerLength };
  const ordered = /^([ \t]*)(\d+[.)])((?:[ \t]+)|$)/.exec(line);
  if (ordered) {
    return {
      prefix: { kind: "ordered", indent: ordered[1]!, marker: ordered[2]!, space: ordered[3]! },
      markerLength: ordered[0].length,
    };
  }
  const bullet = /^([ \t]*)([-*+])((?:[ \t]+)|$)/.exec(line);
  if (bullet) {
    return {
      prefix: { kind: "bullet", indent: bullet[1]!, marker: bullet[2]!, space: bullet[3]! },
      markerLength: bullet[0].length,
    };
  }
  return null;
}

function listKey(prefix: ListLinePrefix): string {
  if (prefix.kind === "task") return "task";
  if (prefix.kind === "ordered") return `ordered:${prefix.marker.slice(-1)}`;
  return `bullet:${prefix.marker}`;
}

interface PendingItem {
  prefix: ListLinePrefix;
  content: Json[];
  children: PendingList[];
}

interface PendingList {
  key: string;
  items: PendingItem[];
}

function listJson(list: PendingList): Json {
  const first = list.items[0]!.prefix;
  const items = list.items.map((item) => {
    const content = [{ type: "paragraph", content: item.content }, ...item.children.map(listJson)];
    if (item.prefix.kind === "task") {
      return {
        type: "taskItem",
        attrs: {
          checked: item.prefix.checked,
          indent: item.prefix.indent,
          markerSpace: item.prefix.markerSpace,
          contentSpace: item.prefix.contentSpace,
        },
        content,
      };
    }
    return {
      type: "listItem",
      attrs: { indent: item.prefix.indent, marker: item.prefix.marker, space: item.prefix.space },
      content,
    };
  });
  if (first.kind === "task") return { type: "taskList", content: items };
  if (first.kind === "ordered") {
    return {
      type: "orderedList",
      attrs: { start: Number.parseInt(first.marker, 10) || 1 },
      content: items,
    };
  }
  return { type: "bulletList", content: items };
}

function textJson(text: string, marks: RichTextMark[]): Json {
  const json: Json = { type: "text", text };
  if (marks.length > 0) {
    json["marks"] = marks
      .toSorted((a, b) => MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b))
      .map((mark) => ({ type: mark }));
  }
  return json;
}

/**
 * `blocks: false` reads only inline syntax, for a paste inside a list item or a quote;
 * `styling: false` reads no markdown at all, only chips; `literalText` reads nothing, one
 * paragraph per line.
 */
function buildTiptapContent(
  value: string,
  options?: { blocks?: boolean; styling?: boolean; literalText?: boolean },
): Json[] {
  if (options?.literalText) {
    return value.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    }));
  }
  const styling = options?.styling ?? true;
  const blockSyntax = styling && (options?.blocks ?? true);
  // Chips are cut out first and stand in as one sentinel character each, so markdown parsing
  // never looks inside a file link.
  let sentinel = "￼";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: Json[] = [];
  const atomSources: string[] = [];
  const text = splitPromptIntoSegments(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      atoms.push(
        segment.type === "mention"
          ? { type: "composer-mention", attrs: { path: segment.path, source: segment.source } }
          : segment.type === "skill"
            ? { type: "composer-skill", attrs: { name: segment.name, source: segment.source } }
            : {
                type: "composer-reference",
                attrs: {
                  kind: segment.kind,
                  label: segment.label,
                  href: segment.href,
                  source: segment.source,
                },
              },
      );
      atomSources.push(segment.source);
      return sentinel;
    })
    .join("");
  let atomIndex = 0;
  const buildInline = (content: string): Json[] => {
    const inline: Json[] = [];
    const spans = styling ? parseInlineMarkdown(content) : [{ text: content, marks: [] }];
    for (const span of spans) {
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0)
          inline.push({ ...atoms[atomIndex++]!, marks: textJson("", span.marks)["marks"] });
        if (piece) inline.push(textJson(piece, span.marks));
      });
    }
    return inline;
  };
  // Code is literal: a chip's source inside a fence goes back in as text.
  const restoreSources = (line: string) =>
    line.split(sentinel).reduce((joined, piece, index) => {
      if (index === 0) return piece;
      atomIndex += 1;
      return joined + atomSources[atomIndex - 1]! + piece;
    }, "");

  type Entry =
    | { code: Json }
    | { rule: string }
    | { heading: { level: number; space: string; inline: Json[] } }
    | { quote: { prefix: string; inline: Json[] } }
    | { line: { list: ListLinePrefix | null; inline: Json[] } };
  const entries: Entry[] = [];
  const sourceLines = text.split("\n");
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index]!;
    const opening = blockSyntax ? parseOpeningFence(line) : null;
    if (!opening) {
      if (blockSyntax && /^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/.test(line)) {
        entries.push({ rule: line });
        continue;
      }
      const heading = blockSyntax ? /^(#{1,6})([ \t]+)([^\n]*)$/.exec(line) : null;
      if (heading) {
        entries.push({
          heading: {
            level: heading[1]!.length,
            space: heading[2]!,
            inline: buildInline(heading[3]!),
          },
        });
        continue;
      }
      const quote = blockSyntax ? /^(>[ \t]*)([^\n]*)$/.exec(line) : null;
      if (quote) {
        entries.push({ quote: { prefix: quote[1]!, inline: buildInline(quote[2]!) } });
        continue;
      }
      const parsed = blockSyntax ? parseListPrefix(line) : null;
      entries.push({
        line: {
          list: parsed?.prefix ?? null,
          inline: buildInline(parsed ? line.slice(parsed.markerLength) : line),
        },
      });
      continue;
    }
    const language = restoreSources(opening.language);
    const body: string[] = [];
    let cursor = index + 1;
    let close = "";
    while (cursor < sourceLines.length) {
      const candidate = sourceLines[cursor]!;
      if (isClosingFence(candidate, opening.fence)) {
        close = `\n${candidate}`;
        break;
      }
      body.push(restoreSources(candidate));
      cursor += 1;
    }
    const content = body.join("\n");
    entries.push({
      code: {
        type: "codeBlock",
        attrs: { language, fence: opening.fence, close },
        ...(content ? { content: [{ type: "text", text: content }] } : {}),
      },
    });
    index = cursor < sourceLines.length ? cursor : sourceLines.length;
  }

  const blocks: Json[] = [];
  let rootLists: PendingList[] = [];
  let stack: { indent: string; list: PendingList; container: PendingList[] }[] = [];
  const flushLists = () => {
    for (const list of rootLists) blocks.push(listJson(list));
    rootLists = [];
    stack = [];
  };
  const openList = (container: PendingList[], key: string): PendingList => {
    const list: PendingList = { key, items: [] };
    container.push(list);
    return list;
  };
  let openQuote: { prefix: string; content: Json[][] } | null = null;
  const flushQuote = () => {
    if (!openQuote) return;
    blocks.push({
      type: "blockquote",
      attrs: { prefix: openQuote.prefix },
      content: openQuote.content.map((inline) => ({ type: "paragraph", content: inline })),
    });
    openQuote = null;
  };
  for (const entry of entries) {
    if ("quote" in entry) {
      flushLists();
      if (openQuote && openQuote.prefix !== entry.quote.prefix) flushQuote();
      openQuote ??= { prefix: entry.quote.prefix, content: [] };
      openQuote.content.push(entry.quote.inline);
      continue;
    }
    flushQuote();
    if ("code" in entry) {
      flushLists();
      blocks.push(entry.code);
      continue;
    }
    if ("rule" in entry) {
      flushLists();
      blocks.push({ type: "horizontalRule", attrs: { source: entry.rule } });
      continue;
    }
    if ("heading" in entry) {
      flushLists();
      blocks.push({
        type: "heading",
        attrs: { level: entry.heading.level, space: entry.heading.space },
        content: entry.heading.inline,
      });
      continue;
    }
    const line = entry.line;
    if (!line.list) {
      flushLists();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingItem = { prefix: line.list, content: line.inline, children: [] };
    const key = listKey(line.list);
    const indent = line.list.indent;
    for (;;) {
      const top = stack.at(-1);
      if (!top) {
        stack.push({ indent, list: openList(rootLists, key), container: rootLists });
        continue;
      }
      if (top.indent === indent) {
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      if (top.indent !== "" && !indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = indent;
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      const parent = top.list.items.at(-1);
      if (!parent) {
        top.list.items.push(item);
        break;
      }
      const list = openList(parent.children, key);
      stack.push({ indent, list, container: parent.children });
      list.items.push(item);
      break;
    }
  }
  flushQuote();
  flushLists();
  return blocks;
}

/** A draft ending in a rule gets an empty line after it, for the caret. */
function buildDocJson(
  value: string,
  options?: { styling?: boolean; literalText?: boolean },
): JSONContent {
  const content = buildTiptapContent(value, options);
  if (content.at(-1)?.["type"] === "horizontalRule") content.push({ type: "paragraph" });
  return { type: "doc", content: content as JSONContent[] };
}

// ---------------------------------------------------------------------------------------------
// Document to markdown, with a map between document positions and markdown offsets
// (composer-rich-text-doc.ts: serializeEditorDoc). T3 also keeps a "collapsed" cursor space
// where a chip counts one; the handle here speaks markdown offsets only.

interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset: text counts its characters, a chip one, markers none. */
  flatStart: number;
  docLen: number;
  mdStart: number;
  mdLen: number;
  openLen: number;
  closeLen: number;
  pmPos: number;
  nodeName?: string;
}

interface RichDocMap {
  value: string;
  runs: RichRun[];
  docLength: number;
}

interface RichAccumulator {
  runs: RichRun[];
  value: string;
  flat: number;
  md: number;
}

const LIST_NODE_NAMES = new Set(["taskList", "bulletList", "orderedList"]);
const LIST_ITEM_NODE_NAMES = new Set(["taskItem", "listItem"]);

function atomSource(node: ProseMirrorNode): string {
  const source = (node.attrs as { source?: unknown }).source;
  return typeof source === "string" ? source : "";
}

function pushBreakRun(acc: RichAccumulator, position?: number): void {
  const previous = acc.runs.at(-1);
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos: position ?? (previous ? previous.pmPos + previous.docLen : 1),
    mdStart: acc.md,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.md += 1;
}

/** Markdown text that owns no document characters: a list marker, a quote prefix. */
function pushPrefixRun(acc: RichAccumulator, text: string, pmPos: number): void {
  acc.runs.push({
    kind: "prefix",
    flatStart: acc.flat,
    docLen: 0,
    mdLen: text.length,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
  });
  acc.value += text;
  acc.md += text.length;
}

/**
 * A paragraph on the line right after a quote reads as part of it in Markdown (a lazy
 * continuation), so the draft writes a blank line between them.
 */
function needsBlankLineAfterQuote(previous: ProseMirrorNode, block: ProseMirrorNode): boolean {
  return (
    previous.type.name === "blockquote" && block.type.name === "paragraph" && block.content.size > 0
  );
}

function appendInlineRuns(
  container: ProseMirrorNode,
  contentStart: number,
  acc: RichAccumulator,
): void {
  // Whitespace at the edges of styled text is written outside its markers: `** x**` is not bold.
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "code")) {
      children.push(child);
      return;
    }
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (
          child.type.name === "hardBreak" ||
          !child.marks.some((item) => item.type.name === mark)
        ) {
          hasContent = false;
        } else if (
          child.isText &&
          !child.marks.some((item) => item.type.name === "code") &&
          /^\s+$/.test(child.text!)
        ) {
          if (!hasContent) {
            children[index] = child.mark(child.marks.filter((item) => item.type.name !== mark));
          }
        } else {
          hasContent = true;
        }
      }
    }
  }
  // A mark that runs longer opens first, so nested markers close in the right order.
  const markEnds = new Map<RichTextMark, number>();
  const orderedMarks: RichTextMark[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const marks =
      child.type.name === "hardBreak"
        ? []
        : child.marks.map((mark) => mark.type.name).filter(isRichTextMark);
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    orderedMarks[index] = marks.toSorted(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! ||
        MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
    );
  }
  for (let index = 1; index < orderedMarks.length; index += 1) {
    const marks = orderedMarks[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of orderedMarks[index - 1]!) {
      if (!marks.includes(mark)) break;
      retained.push(mark);
    }
    orderedMarks[index] = [...retained, ...marks.filter((mark) => !retained.includes(mark))];
  }
  const commonLength = (left: RichTextMark[], right: RichTextMark[]) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
  };
  let inlineOffset = 0;
  children.forEach((child, index) => {
    const pmPos = contentStart + inlineOffset;
    inlineOffset += child.nodeSize;
    if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      return;
    }
    const marks = orderedMarks[index]!;
    const open = marks
      .slice(commonLength(marks, orderedMarks[index - 1] ?? []))
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const close = marks
      .slice(commonLength(marks, orderedMarks[index + 1] ?? []))
      .toReversed()
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const source = child.isText ? child.text! : atomSource(child);
    const docLen = child.isText ? source.length : 1;
    const mdText = open + source + close;
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      mdLen: mdText.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
      mdStart: acc.md,
      ...(child.isText ? {} : { nodeName: child.type.name }),
    });
    acc.value += mdText;
    acc.flat += docLen;
    acc.md += mdText.length;
  });
  if (children.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
      mdStart: acc.md,
    });
  }
}

function listItemPrefix(item: ProseMirrorNode, empty: boolean): string {
  const attrs = item.attrs as Record<string, unknown>;
  const indent = typeof attrs["indent"] === "string" ? attrs["indent"] : "";
  if (item.type.name === "taskItem") {
    const markerSpace = typeof attrs["markerSpace"] === "string" ? attrs["markerSpace"] : " ";
    const contentSpace =
      typeof attrs["contentSpace"] === "string"
        ? attrs["contentSpace"] || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    return `${indent}-${markerSpace}[${attrs["checked"] === true ? "x" : " "}]${contentSpace}`;
  }
  const marker = typeof attrs["marker"] === "string" && attrs["marker"] ? attrs["marker"] : "-";
  const space =
    typeof attrs["space"] === "string" ? attrs["space"] || (empty ? "" : " ") : empty ? "" : " ";
  return `${indent}${marker}${space}`;
}

function walkList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
    pushPrefixRun(acc, listItemPrefix(item, empty), itemContentStart + 1);
    let childPos = itemContentStart;
    let firstBlock = true;
    item.content.forEach((child) => {
      if (!firstBlock) pushBreakRun(acc);
      firstBlock = false;
      if (LIST_NODE_NAMES.has(child.type.name)) walkList(child, childPos, acc);
      else if (child.type.name === "paragraph") appendInlineRuns(child, childPos + 1, acc);
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

function walkBlockquote(quote: ProseMirrorNode, quoteStart: number, acc: RichAccumulator): void {
  const prefix = typeof quote.attrs["prefix"] === "string" ? quote.attrs["prefix"] : "> ";
  let childPos = quoteStart + 1;
  let firstLine = true;
  quote.content.forEach((child) => {
    if (!firstLine) pushBreakRun(acc);
    firstLine = false;
    pushPrefixRun(acc, prefix, childPos + 1);
    if (child.type.name === "paragraph") appendInlineRuns(child, childPos + 1, acc);
    childPos += child.nodeSize;
  });
}

function codeBlockSource(
  node: ProseMirrorNode,
  followed: boolean,
): { open: string; content: string; close: string } {
  const attrs = node.attrs as Record<string, unknown>;
  let fence = typeof attrs["fence"] === "string" && attrs["fence"] ? attrs["fence"] : "```";
  const language = typeof attrs["language"] === "string" ? attrs["language"] : "";
  let close = typeof attrs["close"] === "string" ? attrs["close"] : "";
  const content = node.textContent;
  // Code holding a line that would close the fence is written inside a longer one.
  const longest = Math.max(
    0,
    ...content
      .split("\n")
      .filter((line) => isClosingFence(line, fence))
      .map((line) => /^[`~]+/.exec(line)![0].length),
  );
  if (longest > 0) {
    fence = fence[0]!.repeat(longest + 1);
    if (close) close = `\n${fence}`;
  }
  // An unclosed fence runs to the end of the draft, so with a block after it the fence is
  // written closed, or the next rebuild would read that block as code.
  if (!close && followed) close = `\n${fence}`;
  return { open: `${fence}${language}${content ? "\n" : ""}`, content, close };
}

function appendCodeBlockRun(
  block: ProseMirrorNode,
  pmPos: number,
  followed: boolean,
  acc: RichAccumulator,
): void {
  const { open, content, close } = codeBlockSource(block, followed);
  acc.runs.push({
    kind: "text",
    flatStart: acc.flat,
    docLen: content.length,
    mdLen: open.length + content.length + close.length,
    openLen: open.length,
    closeLen: close.length,
    pmPos,
    mdStart: acc.md,
    nodeName: "codeBlock",
  });
  acc.value += open + content + close;
  acc.flat += content.length;
  acc.md += open.length + content.length + close.length;
}

/**
 * The empty line kept after a final rule is where the caret goes, not a line of the draft, so
 * `---` stays `---`.
 */
function isTrailingLineAfterRule(doc: ProseMirrorNode, index: number): boolean {
  const block = doc.child(index);
  return (
    index === doc.childCount - 1 &&
    index > 0 &&
    block.type.name === "paragraph" &&
    block.content.size === 0 &&
    doc.child(index - 1).type.name === "horizontalRule"
  );
}

function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, md: 0 };
  const blocks: ProseMirrorNode[] = [];
  doc.content.forEach((node) => {
    blocks.push(node);
  });
  let pmBlockStart = 0;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0 && !isTrailingLineAfterRule(doc, blockIndex)) pushBreakRun(acc);
    if (blockIndex > 0 && needsBlankLineAfterQuote(blocks[blockIndex - 1]!, block)) {
      pushPrefixRun(acc, "\n", pmBlockStart + 1);
    }
    if (LIST_NODE_NAMES.has(block.type.name)) walkList(block, pmBlockStart, acc);
    else if (block.type.name === "codeBlock") {
      appendCodeBlockRun(block, pmBlockStart + 1, blockIndex < blocks.length - 1, acc);
    } else if (block.type.name === "blockquote") walkBlockquote(block, pmBlockStart, acc);
    else if (block.type.name === "heading") {
      const attrs = block.attrs as Record<string, unknown>;
      const level = typeof attrs["level"] === "number" ? attrs["level"] : 1;
      const space = typeof attrs["space"] === "string" ? attrs["space"] : " ";
      pushPrefixRun(acc, `${"#".repeat(level)}${space}`, pmBlockStart + 1);
      appendInlineRuns(block, pmBlockStart + 1, acc);
    } else if (block.type.name === "horizontalRule") {
      const source = block.attrs["source"];
      pushPrefixRun(
        acc,
        typeof source === "string" && source ? source : "---",
        pmBlockStart + block.nodeSize,
      );
    } else if (block.type.name === "paragraph") appendInlineRuns(block, pmBlockStart + 1, acc);
    pmBlockStart += block.nodeSize;
  });
  return { value: acc.value, runs: acc.runs, docLength: acc.flat };
}

/**
 * A slice holds only the content of the blocks the ends share, so items or quote lines arrive
 * without the list or quote that writes their markers.
 */
function serializeSelection(doc: ProseMirrorNode, from: number, to: number): string {
  const slice = doc.slice(from, to);
  const $from = doc.resolve(from);
  let depth = $from.sharedDepth(to);
  let content: Fragment | ProseMirrorNode = slice.content;
  if (slice.content.firstChild?.isInline) {
    content = doc.type.schema.nodes["paragraph"]!.create(null, slice.content);
  } else {
    while (depth > 0) {
      const shared = $from.node(depth);
      content = shared.copy(Fragment.from(content));
      if (!LIST_ITEM_NODE_NAMES.has(shared.type.name)) break;
      depth -= 1;
    }
  }
  try {
    return serializeEditorDoc(doc.type.create(null, content)).value;
  } catch {
    return slice.content.textBetween(0, slice.content.size, "\n");
  }
}

/**
 * The end of a run belongs to the next run, which is how the end of `**bold**` lands after its
 * markers. A fence is the exception: the end of the code stays inside the block.
 */
function runOwnsOffset(run: RichRun, flatOffset: number): boolean {
  const end = run.flatStart + run.docLen;
  return flatOffset < end || (flatOffset === end && run.nodeName === "codeBlock");
}

function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (runOwnsOffset(run, bounded)) {
      const within = bounded - run.flatStart;
      return run.mdStart + (run.kind === "text" || run.kind === "token" ? run.openLen : 0) + within;
    }
  }
  const last = map.runs.at(-1);
  return last ? last.mdStart + last.mdLen : 0;
}

/** An offset inside a chip's source lands after the chip; one inside a marker, at its text. */
function markdownToFlat(map: RichDocMap, mdOffset: number): number {
  for (const run of map.runs) {
    if (mdOffset >= run.mdStart + run.mdLen) continue;
    if (run.kind === "prefix") return run.flatStart;
    const within = mdOffset - run.mdStart;
    if (run.kind === "break") return run.flatStart + within;
    if (within <= run.openLen) return run.flatStart;
    if (run.kind === "token") return run.flatStart + run.docLen;
    if (within >= run.openLen + run.docLen) return run.flatStart + run.docLen;
    return run.flatStart + (within - run.openLen);
  }
  return map.docLength;
}

function flatToPm(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) return run.pmPos + (bounded - run.flatStart);
  }
  const last = map.runs.at(-1);
  return last ? last.pmPos + last.docLen : 1;
}

function pmToFlat(map: RichDocMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos >= run.pmPos && pmPos <= run.pmPos + run.docLen) {
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  let best = 0;
  for (const run of map.runs) if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  return Math.max(0, Math.min(best, map.docLength));
}

function caretInMarkdown(state: EditorState, map = serializeEditorDoc(state.doc)): number {
  return Math.min(map.value.length, flatToMarkdown(map, pmToFlat(map, state.selection.from)));
}

// ---------------------------------------------------------------------------------------------
// Extensions

const CHIP_CLASS_NAME =
  "mx-px inline-flex items-center rounded-sm bg-accent px-1 align-baseline text-[0.92em] leading-snug text-accent-foreground select-none";

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** A file: `[name](path)` or a legacy `@path`, shown by its basename. */
const ComposerMentionExtension = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-mention") ?? "",
        renderHTML: (attrs) => ({ "data-mention": attrs["path"], title: attrs["path"] }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? "",
        renderHTML: (attrs) => ({ "data-source": attrs["source"] }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: CHIP_CLASS_NAME, contenteditable: "false" }),
      basename(String(node.attrs["path"])),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView, {
      as: "span",
      // On the node's own element, there at once: the view inside renders a moment later.
      attrs: ({ node }) => ({ "data-mention": String(node.attrs["path"]) }),
    });
  },
  renderText({ node }) {
    return atomSource(node);
  },
});

/** A skill: `$name`, any currency sign. */
const ComposerSkillExtension = Node.create({
  name: "composer-skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-skill") ?? "",
        renderHTML: (attrs) => ({ "data-skill": attrs["name"] }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? "",
        renderHTML: (attrs) => ({ "data-source": attrs["source"], title: attrs["source"] }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-skill]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: CHIP_CLASS_NAME, contenteditable: "false" }),
      String(node.attrs["name"]),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(SkillNodeView, {
      as: "span",
      attrs: ({ node }) => ({ "data-skill": String(node.attrs["name"]) }),
    });
  },
  renderText({ node }) {
    return atomSource(node);
  },
});

/**
 * A pull request (`[#12](url)`) or a thread (`[title](jhin://node/threads/id)`), shown by its
 * label as T3 shows a context reference.
 */
const ComposerReferenceExtension = Node.create({
  name: "composer-reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: {
        default: "thread",
        parseHTML: (element) => element.getAttribute("data-reference") ?? "thread",
        renderHTML: (attrs) => ({ "data-reference": attrs["kind"] }),
      },
      label: {
        default: "",
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
      href: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-href") ?? "",
        renderHTML: (attrs) => ({ "data-href": attrs["href"], title: attrs["href"] }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? "",
        renderHTML: (attrs) => ({ "data-source": attrs["source"] }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-reference]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: CHIP_CLASS_NAME, contenteditable: "false" }),
      String(node.attrs["label"]),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ReferenceNodeView, {
      as: "span",
      attrs: ({ node }) => ({
        "data-reference": String(node.attrs["kind"]),
        "data-href": String(node.attrs["href"]),
      }),
    });
  },
  renderText({ node }) {
    return atomSource(node);
  },
});

/**
 * Tiptap's block extensions each bind a chord that turns the current block into their node. The
 * composer does not offer them, and run inside a quote they nest a block the serializer cannot
 * write.
 */
function withoutChords<Shortcuts extends Record<string, unknown>>(
  shortcuts: Shortcuts | undefined,
  drop: readonly string[],
): Shortcuts {
  return Object.fromEntries(
    Object.entries(shortcuts ?? {}).filter(([key]) => !drop.includes(key)),
  ) as Shortcuts;
}

/** Tiptap's code mark excludes every other mark, which rejects `**\`x\`**`. */
const ComposerCodeExtension = Code.extend({ excludes: "code", exitable: false });

/** Joining the code onto the line above instead would drop the fence from the draft. */
function unwrapCodeBlockAtStart(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "codeBlock" || $from.parentOffset !== 0) return false;
  const { schema } = editor.state;
  const paragraphs = $from.parent.textContent
    .split("\n")
    .map((line) => schema.nodes["paragraph"]!.create(null, line ? schema.text(line) : null));
  const start = $from.before();
  const tr = editor.state.tr.replaceWith(start, $from.after(), paragraphs);
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
  return true;
}

const ComposerCodeBlockExtension = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: { default: "" },
      fence: { default: "```" },
      close: { default: "\n```" },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...withoutChords(this.parent?.(), ["Mod-Alt-c"]),
      Backspace: () => unwrapCodeBlockAtStart(this.editor),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView, {
      // Tiptap shields only events aimed at the picker's button itself; a click on its
      // label would reach ProseMirror and move the selection.
      stopEvent: ({ event }) =>
        event.target instanceof Element &&
        event.target.closest(`.${CODE_BLOCK_HEADER_CLASS_NAME}`) !== null,
    });
  },
  // Tiptap's ``` + space rule would open a fence inside a list item or quote, where the
  // serializer has no line for it. Enter on a fence line covers the gesture at top level.
  addInputRules() {
    return [];
  },
});

/** What a list item may hold: its own line, then nested lists — all the Markdown can write. */
const LIST_ITEM_CONTENT = "paragraph list*";

function nextOrderedMarkerText(marker: string): string {
  const numberText = marker.slice(0, -1);
  const delimiter = marker.slice(-1);
  const number = Number.parseInt(numberText, 10);
  const next = Number.isSafeInteger(number)
    ? String(number + 1).padStart(numberText.length, "0")
    : numberText;
  return `${next}${delimiter}`;
}

function renumberFollowingItems(tr: Transaction, listPos: number, index: number, marker: string) {
  const list = tr.doc.nodeAt(listPos);
  if (!list) return;
  let pos = listPos + 1;
  let previous = marker;
  list.forEach((child, _, childIndex) => {
    if (childIndex > index) {
      previous = nextOrderedMarkerText(previous);
      if (child.attrs["marker"] !== previous) {
        tr.setNodeMarkup(pos, undefined, { ...child.attrs, marker: previous });
      }
    }
    pos += child.nodeSize;
  });
}

/**
 * Tiptap moves items between lists without touching these attributes, so without this the
 * stored draft keeps an outdented item at its old depth, and the next rebuild nests it again.
 */
function alignListItemWithSiblings(tr: Transaction, itemType: string): void {
  const $pos = tr.selection.$from;
  if ($pos.depth < 3 || $pos.node(-1).type.name !== itemType) return;
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const sibling =
    index > 0 ? list.child(index - 1) : index + 1 < list.childCount ? list.child(index + 1) : null;
  if (!sibling) return;
  const attrs: Record<string, unknown> = { ...item.attrs, indent: sibling.attrs["indent"] };
  if (item.type.name === "taskItem") {
    attrs["markerSpace"] = sibling.attrs["markerSpace"];
  } else {
    const marker = typeof sibling.attrs["marker"] === "string" ? sibling.attrs["marker"] : "-";
    attrs["marker"] =
      index > 0 && /^\d+[.)]$/.test(marker) ? nextOrderedMarkerText(marker) : marker;
  }
  tr.setNodeMarkup($pos.before(-1), undefined, attrs);
  if (typeof attrs["marker"] === "string" && /^\d+[.)]$/.test(attrs["marker"])) {
    renumberFollowingItems(tr, $pos.before(-2), index, attrs["marker"]);
  }
}

function listItemTypeAt($pos: ResolvedPos): "listItem" | "taskItem" | null {
  const name = $pos.depth > 1 ? $pos.node(-1).type.name : null;
  return name === "listItem" || name === "taskItem" ? name : null;
}

/**
 * Enter in an item starts the next one, a task unchecked; in an empty item it leaves the list.
 */
function splitOrLiftListItem(editor: Editor): boolean {
  const $from = editor.state.selection.$from;
  const itemType = listItemTypeAt($from);
  if (!itemType) return false;
  const empty = $from.parent.content.size === 0;
  const move: Command = ({ commands, tr }) => {
    const moved =
      commands.splitListItem(
        itemType,
        itemType === "taskItem" ? { checked: false } : { space: " " },
      ) ||
      (empty && commands.liftListItem(itemType));
    if (moved) alignListItemWithSiblings(tr, itemType);
    return moved;
  };
  return editor.can().command(move) && editor.chain().command(move).run();
}

function backspaceAcrossList(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const itemType = listItemTypeAt($from);
  if (itemType && $from.index(-1) === 0) {
    const lift: Command = ({ commands, tr }) => {
      const moved = commands.liftListItem(itemType);
      if (moved) alignListItemWithSiblings(tr, itemType);
      return moved;
    };
    // Not `can()` first: a dry run of the lift skips the schema check, so it says yes to a task
    // under a bullet, which has no list to lift into.
    return editor.chain().command(lift).run() || joinBackward(state, editor.view.dispatch);
  }
  const before = $from.depth === 1 ? $from.node(0).maybeChild($from.index(0) - 1) : null;
  if (before && LIST_NODE_NAMES.has(before.type.name) && $from.parent.type.name !== "codeBlock") {
    return joinTextblockBackward(state, editor.view.dispatch);
  }
  return false;
}

function deleteAcrossList(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.depth === 0) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const next = Selection.findFrom(state.doc.resolve($from.after()), 1, true);
  if (!next) return false;
  if (next.$from.parent.type.name === "codeBlock") return $from.parent.type.name !== "codeBlock";
  if (!listItemTypeAt($from) && !listItemTypeAt(next.$from)) return false;
  return joinTextblockForward(state, editor.view.dispatch);
}

/** Tab and Shift-Tab sink and lift an item without touching its `indent`. */
const LIST_NESTING_KEYS = ["Tab", "Shift-Tab"];

const ComposerListItemExtension = ListItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      marker: { default: "-" },
      space: { default: " " },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...withoutChords(this.parent?.(), LIST_NESTING_KEYS),
      Backspace: () => backspaceAcrossList(this.editor),
      Delete: () => deleteAcrossList(this.editor),
    };
  },
});

/**
 * `- ` alone is not enough for a dash: it waits for the first character after the space, which
 * it carries into the new item.
 */
function listMarkerInputRule(find: RegExp, listType: "bulletList" | "orderedList"): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match, chain }) => {
      const marker = match.groups?.["marker"] ?? "-";
      const space = match.groups?.["space"] ?? " ";
      const carried = match.groups?.["carried"] ?? "";
      // Top-level paragraphs only: inside an item or a quote the new list would nest under a
      // line the stored draft writes flat.
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
      const command = chain()
        .deleteRange(range)
        .wrapInList(
          listType,
          listType === "orderedList" ? { start: Number.parseInt(marker, 10) || 1 } : {},
        )
        .updateAttributes("listItem", { marker, space });
      (carried ? command.insertContent(carried) : command).run();
      return undefined;
    },
  });
}

const blockquoteInputRule = new InputRule({
  find: /^>(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .wrapIn("blockquote", { prefix: `>${match[1] ?? " "}` })
      .run();
    return undefined;
  },
});

const ComposerBlockquoteExtension = Blockquote.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), prefix: { default: "> " } };
  },
  addKeyboardShortcuts() {
    return withoutChords(this.parent?.(), ["Mod-Shift-b"]);
  },
  addInputRules() {
    return [blockquoteInputRule];
  },
});

const ComposerBulletListExtension = BulletList.extend({
  addKeyboardShortcuts() {
    return withoutChords(this.parent?.(), ["Mod-Shift-8"]);
  },
  addInputRules() {
    return [
      listMarkerInputRule(/^(?<marker>[*+])(?<space>\s)$/, "bulletList"),
      listMarkerInputRule(/^(?<marker>-)(?<space>[ \t]+)(?<carried>[^\s[])$/, "bulletList"),
    ];
  },
});

const ComposerOrderedListExtension = OrderedList.extend({
  addKeyboardShortcuts() {
    return withoutChords(this.parent?.(), ["Mod-Shift-7"]);
  },
  addInputRules() {
    return [listMarkerInputRule(/^(?<marker>\d+[.)])(?<space>\s)$/, "orderedList")];
  },
});

/** `[ ] ` or `[x] ` typed at the start of a bullet item turns that item into a task. */
function convertBulletItemToTask(tr: Transaction, from: number, to: number, checked: boolean) {
  tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const { schema } = tr.doc.type;
  const before: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((child, _, childIndex) => {
    if (childIndex < index) before.push(child);
    else if (childIndex > index) after.push(child);
  });
  const markerSpace =
    typeof item.attrs["space"] === "string" && item.attrs["space"] ? item.attrs["space"] : " ";
  const task = schema.nodes["taskItem"]!.create(
    { checked, indent: item.attrs["indent"], markerSpace },
    item.content,
  );
  const lists = [
    ...(before.length > 0 ? [list.copy(Fragment.from(before))] : []),
    schema.nodes["taskList"]!.create(null, task),
    ...(after.length > 0 ? [list.copy(Fragment.from(after))] : []),
  ];
  const listStart = $pos.before(-2);
  tr.replaceWith(listStart, listStart + list.nodeSize, lists);
  const caret = listStart + (before.length > 0 ? lists[0]!.nodeSize : 0) + 3;
  tr.setSelection(TextSelection.create(tr.doc, caret));
}

const bulletToTaskInputRule = new InputRule({
  find: /^\[([ xX])\] $/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    const item = $from.node(-1);
    if ($from.parent.type.name !== "paragraph" || item?.type.name !== "listItem") return null;
    if (!["-", "*", "+"].includes((item.attrs as { marker?: string }).marker ?? "")) return null;
    const checked = (match[1] ?? " ").toLowerCase() === "x";
    chain()
      .command(({ tr }) => {
        convertBulletItemToTask(tr, range.from, range.to, checked);
        return true;
      })
      .run();
    return undefined;
  },
});

/** `- [ ] ` or `- [x] ` at a top-level paragraph opens a task list. */
function taskInputRule(type: NodeType): InputRule {
  const rule = wrappingInputRule({
    find: /^- \[([ xX])\] $/,
    type,
    getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
  });
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      props.state.doc.resolve(props.range.from).depth === 1 ? rule.handler(props) : null,
  });
}

/** Task lists come from `- [ ]` alone; Mod-Shift-9 would nest one in a quote. */
const ComposerTaskListExtension = TaskList.extend({
  addKeyboardShortcuts() {
    return withoutChords(this.parent?.(), ["Mod-Shift-9"]);
  },
});

const ComposerTaskItemExtension = TaskItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
  addKeyboardShortcuts() {
    return withoutChords(this.parent?.(), LIST_NESTING_KEYS);
  },
  addInputRules() {
    return [taskInputRule(this.type), bulletToTaskInputRule];
  },
}).configure({ nested: true });

/**
 * `---` becomes a rule as the third dash lands; `***` and `___` need a space after them so typing
 * bold or an underscore is not interrupted, matching Tiptap's own rule. Only at a top-level
 * paragraph: the list and quote serializers have no line to write a rule into.
 */
const horizontalRuleInputRule = new InputRule({
  find: /^(---|\*\*\*|___)\s?$/,
  handler: ({ state, range, match, chain }) => {
    const source = match[0] ?? "---";
    if (!source.startsWith("---") && !/\s$/.test(source)) return null;
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setHorizontalRule()
      .command(({ tr }) => {
        const $pos = tr.selection.$from;
        const index = $pos.index(0) - 1;
        if (index < 0) return true;
        const rulePos = $pos.posAtIndex(index, 0);
        const rule = tr.doc.nodeAt(rulePos);
        if (rule?.type.name === "horizontalRule") {
          tr.setNodeMarkup(rulePos, undefined, { ...rule.attrs, source });
        }
        return true;
      })
      .run();
    return undefined;
  },
});

/** A rule keeps the text it was written with; a draft never ends in one, so the caret has a line. */
const ComposerHorizontalRuleExtension = HorizontalRule.extend({
  addAttributes() {
    return { ...this.parent?.(), source: { default: "---" } };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        appendTransaction: (transactions, _, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (state.doc.lastChild?.type.name !== "horizontalRule") return null;
          return state.tr.insert(state.doc.content.size, state.schema.nodes["paragraph"]!.create());
        },
      }),
    ];
  },
  addInputRules() {
    return [horizontalRuleInputRule];
  },
});

/**
 * The space is required, which is exactly what keeps `#1234` a pull request reference with its
 * picker rather than a heading. Not inside lists or quotes, whose serializers have no line for
 * one.
 */
const headingInputRule = new InputRule({
  find: /^(#{1,6})(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setNode("heading", { level: match[1]?.length ?? 1, space: match[2] ?? " " })
      .run();
    return undefined;
  },
});

/** A heading keeps the spacing after its hashes; Mod-Alt-1…6 are not offered. */
const ComposerHeadingExtension = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), space: { default: " " } };
  },
  addKeyboardShortcuts() {
    return {};
  },
  addInputRules() {
    return [headingInputRule];
  },
});

// Undo grouping (composer-undo-grouping.ts). ProseMirror's history starts a new undo step only
// after a pause, so typing, backspacing and typing again would be one step; a change of kind
// closes the step instead.
type ChangeKind = "insert" | "delete" | "other";

const UNDO_GROUP_DELAY = 1000;

function changeKindOf(tr: Transaction): ChangeKind | null {
  if (!tr.docChanged) return null;
  const uiEvent = tr.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || uiEvent === "cut") return "other";
  // IME input replaces its own range on each keystroke; it is still typing.
  if (tr.getMeta("composition") != null) return "insert";
  let kind: ChangeKind | null = null;
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) return "other";
    const inserts = step.slice.size > 0;
    const deletes = step.to > step.from;
    const stepKind = inserts && !deletes ? "insert" : deletes && !inserts ? "delete" : "other";
    if (kind !== null && kind !== stepKind) return "other";
    kind = stepKind;
  }
  return kind;
}

const ComposerUndoGroupingExtension = Extension.create<
  Record<string, never>,
  { previous: ChangeKind | null }
>({
  name: "composer-undo-grouping",
  addStorage() {
    return { previous: null };
  },
  // Dispatch middleware: the grouping must be decided before history applies the transaction.
  dispatchTransaction({ transaction, next }) {
    if (isHistoryTransaction(transaction)) {
      this.storage.previous = "other";
    } else {
      const kind = changeKindOf(transaction);
      if (kind !== null) {
        const previous = this.storage.previous;
        if (previous !== null && (kind !== previous || kind === "other")) closeHistory(transaction);
        this.storage.previous = kind;
      }
    }
    next(transaction);
  },
});

// Extensions are fixed when an editor is created: a change of text mode mounts a new editor.
function createComposerExtensions(richText: boolean) {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      link: false,
      orderedList: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
      listKeymap: false,
      undoRedo: { newGroupDelay: UNDO_GROUP_DELAY },
      ...(richText ? {} : { bold: false, italic: false, strike: false }),
    }),
    ComposerUndoGroupingExtension,
    ComposerMentionExtension,
    ComposerSkillExtension,
    ComposerReferenceExtension,
    ...(richText
      ? [
          ComposerCodeExtension,
          ComposerCodeBlockExtension,
          ComposerCodeBlockHighlight,
          ComposerBlockquoteExtension,
          ComposerHorizontalRuleExtension,
          ComposerHeadingExtension,
          ComposerBulletListExtension,
          ComposerOrderedListExtension,
          ComposerListItemExtension,
          ComposerTaskListExtension,
          ComposerTaskItemExtension,
        ]
      : []),
  ];
}

const RICH_TEXT_EXTENSIONS = createComposerExtensions(true);
const PLAIN_TEXT_EXTENSIONS = createComposerExtensions(false);

// ---------------------------------------------------------------------------------------------
// Surround (ComposerPromptEditorTiptap.tsx handleTextInput, composer-editor-mentions.ts)

const SURROUND_CLOSE: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

/** Whether [from, to) holds the whitespace just before or after a chip, which the chip needs. */
function boundsChip(doc: ProseMirrorNode, from: number, to: number): boolean {
  let touches = false;
  const whitespaceAt = (pos: number) =>
    pos >= from && pos < to && /\s/.test(doc.textBetween(pos, pos + 1, "", ""));
  // Only a chip just outside the range or inside it can own one of its characters.
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
    if (touches) return false;
    if (node.isAtom && node.isInline && !node.isText) {
      touches = whitespaceAt(pos - 1) || whitespaceAt(pos + node.nodeSize);
    }
    return true;
  });
  return touches;
}

// ---------------------------------------------------------------------------------------------
// Code blocks (composer-code-block.ts)

function codeBlockText(state: EditorState): { from: number; text: string } | null {
  const { $from, $to } = state.selection;
  if ($from.parent.type.spec.code !== true || !$from.sameParent($to)) return null;
  return { from: $from.start(), text: $from.parent.textContent };
}

const CODE_BLOCK_INDENT = "  ";

function outdentLine(line: string): string {
  if (line.startsWith(CODE_BLOCK_INDENT)) return line.slice(CODE_BLOCK_INDENT.length);
  if (line.startsWith("\t") || line.startsWith(" ")) return line.slice(1);
  return line;
}

/** Tab in a code block (D843): two spaces at the caret, or every touched line moved in or out. */
function indentCodeBlock(
  state: EditorState,
  direction: "in" | "out",
  dispatch: (tr: Transaction) => void,
): boolean {
  const block = codeBlockText(state);
  if (!block) return false;
  const { from, to } = state.selection;
  if (from === to && direction === "in") {
    dispatch(state.tr.insertText(CODE_BLOCK_INDENT, from, to));
    return true;
  }
  const startOffset = from - block.from;
  const endOffset = to - block.from;
  // At offset 0 a search from `startOffset - 1` would find a newline at 0, past an empty first line.
  const lineStart = startOffset === 0 ? 0 : block.text.lastIndexOf("\n", startOffset - 1) + 1;
  const newlineAfter = block.text.indexOf("\n", Math.max(startOffset, endOffset - 1));
  const lineEnd = newlineAfter === -1 ? block.text.length : newlineAfter;
  const before = block.text.slice(lineStart, lineEnd).split("\n");
  const after = before.map((line) =>
    direction === "in"
      ? line.length === 0
        ? line
        : `${CODE_BLOCK_INDENT}${line}`
      : outdentLine(line),
  );
  const text = after.join("\n");
  if (text === before.join("\n")) return true;
  const tr = state.tr.insertText(text, block.from + lineStart, block.from + lineEnd);
  const nextFrom = Math.max(block.from + lineStart, from + after[0]!.length - before[0]!.length);
  // An end inside the indent its own line lost stays on that line, at its start.
  const lastLineStart = block.from + lineStart + text.length - after.at(-1)!.length;
  const nextTo = Math.max(nextFrom, lastLineStart, to + text.length - before.join("\n").length);
  dispatch(tr.setSelection(TextSelection.create(tr.doc, nextFrom, nextTo)));
  return true;
}

function indentedNewlineInCodeBlock(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
): boolean {
  const block = codeBlockText(state);
  if (!block) return false;
  const { from, to } = state.selection;
  const beforeCursor = block.text.slice(0, from - block.from);
  const indent = /^[ \t]*/.exec(beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1))![0];
  if (indent.length === 0) return false;
  const inserted = `\n${indent}`;
  const tr = state.tr.insertText(inserted, from, to);
  dispatch(tr.setSelection(TextSelection.create(tr.doc, from + inserted.length)));
  return true;
}

/** Two blank lines at the end of a fence leave it. */
function exitCodeBlockOnTrailingBlankLines(view: EditorView): boolean {
  const { $from, empty } = view.state.selection;
  if (!empty || $from.parent.type.spec.code !== true) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const trailing = /\n[ \t]*\n[ \t]*$/.exec($from.parent.textContent);
  if (!trailing) return false;
  const tr = view.state.tr.delete($from.pos - trailing[0].length, $from.pos);
  if (!$from.parent.attrs["close"]) {
    tr.setNodeAttribute($from.before(), "close", `\n${String($from.parent.attrs["fence"])}`);
  }
  view.dispatch(tr);
  return exitCode(view.state, (next) => view.dispatch(next.scrollIntoView()));
}

/**
 * Lets ProseMirror read a selection it has not been told of yet (D1042). It
 * reads the page's selection on `selectionchange`, which comes after the
 * change, so a key pressed right after a script selected the text (Playwright's
 * `fill`, an assistive tool) acted on the old caret: Delete over a selected
 * prompt deleted nothing, and the Enter after it sent the prompt.
 */
function readPendingSelection(view: EditorView): void {
  // A chip's node selection maps to other DOM positions: only a text selection can be stale.
  if (!(view.state.selection instanceof TextSelection)) return;
  const selection = view.dom.ownerDocument.getSelection();
  const { anchorNode, focusNode } = selection ?? {};
  if (!selection || !anchorNode || !focusNode) return;
  if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return;
  let anchor: number;
  let head: number;
  try {
    anchor = view.posAtDOM(anchorNode, selection.anchorOffset);
    head = view.posAtDOM(focusNode, selection.focusOffset);
  } catch {
    return;
  }
  if (anchor === view.state.selection.anchor && head === view.state.selection.head) return;
  // ProseMirror's own handler reads it, with its rules for what a selection is.
  view.dom.ownerDocument.dispatchEvent(new Event("selectionchange"));
}

/** Enter after a typed closing fence ends the block there. */
function exitCodeBlockOnClosingFence(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
): boolean {
  const block = codeBlockText(state);
  if (!block || !state.selection.empty) return false;
  const caret = state.selection.from - block.from;
  const lineStart = block.text.lastIndexOf("\n", caret - 1) + 1;
  const newlineAfter = block.text.indexOf("\n", caret);
  const lineEnd = newlineAfter === -1 ? block.text.length : newlineAfter;
  const line = block.text.slice(lineStart, lineEnd);
  const node = state.selection.$from.parent;
  if (caret !== lineEnd || !isClosingFence(line, String(node.attrs["fence"]))) return false;
  const { schema } = state;
  const paragraph = (text: string) =>
    schema.nodes["paragraph"]!.create(null, text ? schema.text(text) : null);
  const code = block.text.slice(0, Math.max(0, lineStart - 1));
  const rest = newlineAfter === -1 ? [] : block.text.slice(newlineAfter + 1).split("\n");
  const closed = node.type.create(
    { ...node.attrs, close: `\n${line}` },
    code ? schema.text(code) : null,
  );
  const start = state.selection.$from.before();
  const tr = state.tr.replaceWith(start, start + node.nodeSize, [
    closed,
    paragraph(""),
    ...rest.map(paragraph),
  ]);
  dispatch(tr.setSelection(TextSelection.create(tr.doc, start + closed.nodeSize + 1)));
  return true;
}

/** ```` ```ts ```` then Enter opens a fence, at a top-level paragraph only. */
function convertCodeFenceOnEnter(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "paragraph" || $from.depth !== 1) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const opening = parseOpeningFence(serializeSelection(state.doc, $from.start(), $from.end()));
  const codeBlock = state.schema.nodes["codeBlock"];
  if (!opening || !codeBlock) return false;
  const blockStart = $from.before();
  const { fence, language } = opening;
  const tr = state.tr.replaceWith(
    blockStart,
    blockStart + $from.parent.nodeSize,
    codeBlock.create({ language, fence, close: `\n${fence}` }),
  );
  dispatch(tr.setSelection(TextSelection.create(tr.doc, blockStart + 1)));
  return true;
}

function inBlockquote($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "blockquote") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Caret lines (ComposerPromptEditorTiptap.tsx: isCaretOnVisualEdge)

function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const rect = edge === "start" ? rects.at(-1) : rects[0];
  if (rect) return rect;
  const probe = (text: Text, start: number) => {
    const probeRange = document.createRange();
    probeRange.setStart(text, start);
    probeRange.setEnd(text, start + 1);
    const found = Array.from(probeRange.getClientRects()).find((item) => item.height > 0);
    if (found) return found;
    const bounding = probeRange.getBoundingClientRect();
    return bounding.height > 0 ? bounding : null;
  };
  const container = range.startContainer;
  if (container instanceof Text) {
    if (container.data.length === 0) return null;
    const start = Math.max(
      0,
      Math.min(
        edge === "start" ? range.startOffset : range.startOffset - 1,
        container.data.length - 1,
      ),
    );
    return probe(container, start);
  }
  if (!(container instanceof HTMLElement)) return null;
  const neighbour =
    container.childNodes[Math.max(0, range.startOffset - 1)] ??
    container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    const before = neighbour === container.childNodes[range.startOffset - 1];
    const found = probe(neighbour, before ? neighbour.data.length - 1 : 0);
    if (found) return found;
  }
  const containerRect = container.getBoundingClientRect();
  return containerRect.height > 0 ? containerRect : null;
}

function caretOnVisualEdge(editor: Editor | null, edge: "start" | "end"): boolean {
  if (!editor) return true;
  const map = serializeEditorDoc(editor.state.doc);
  if (map.value.length === 0) return true;
  const cursor = caretInMarkdown(editor.state, map);
  const text = edge === "start" ? map.value.slice(0, cursor) : map.value.slice(cursor);
  if (text.includes("\n")) return false;
  // One markdown line can still wrap: compare the caret with the editor's first or last line.
  const root = editor.view.dom;
  const selection = window.getSelection();
  if (
    !selection?.isCollapsed ||
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !root.contains(selection.anchorNode)
  ) {
    return false;
  }
  const caretRect = caretLineRect(selection.getRangeAt(0), edge);
  if (!caretRect) return false;
  const edgeElement = edge === "start" ? root.firstElementChild : root.lastElementChild;
  const edgeRect = (edgeElement ?? root).getBoundingClientRect();
  const threshold = caretRect.height / 2;
  return edge === "start"
    ? caretRect.top - edgeRect.top < threshold
    : edgeRect.bottom - caretRect.bottom < threshold;
}

// ---------------------------------------------------------------------------------------------
// The component

// Headings, rules and task lists follow T3's index.css (`.composer-tiptap`), without the block
// margins the composer's other blocks do not have either.
const EDITOR_CLASS_NAME = [
  "-m-1 block max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] overflow-y-auto bg-transparent p-1 leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground outline-none [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_ol]:list-decimal [&_ol]:ps-5 [&_pre]:font-mono [&_pre]:text-[0.9em] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:ps-5",
  "[&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-[1.3] [&_:is(h1,h2,h3,h4,h5,h6)]:text-foreground [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_:is(h4,h5,h6)]:text-sm [&_h6]:text-muted-foreground",
  "[&_hr]:my-2.5",
  // Tiptap's task item view builds its <li> with only a data-checked attribute.
  "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:ps-0 [&_ul[data-type=taskList]_ul[data-type=taskList]]:ps-[1.375rem] [&_li[data-checked]]:flex [&_li[data-checked]]:items-start [&_li[data-checked]]:gap-2 [&_li[data-checked]>label]:flex [&_li[data-checked]>label]:h-[1lh] [&_li[data-checked]>label]:flex-none [&_li[data-checked]>label]:cursor-pointer [&_li[data-checked]>label]:items-center [&_li[data-checked]>label>input]:m-0 [&_li[data-checked]>label>input]:block [&_li[data-checked]>label>input]:size-[0.95rem] [&_li[data-checked]>label>input]:cursor-pointer [&_li[data-checked]>div]:min-w-0 [&_li[data-checked]>div]:flex-auto",
].join(" ");

export function PromptEditor(props: PromptEditorProps) {
  const { value, placeholder, disabled = false, readOnly = false, className, handleRef } = props;
  const literalText = props.literalText === true;
  const richText = !literalText && props.richText !== false;
  const docOptions = { styling: richText, literalText };
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  // The prompt as last reported or applied, so a value echoed back by the parent is not rebuilt.
  const snapshot = useRef({ value, cursor: value.length });
  const applying = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  /** The editor whose view is mounted: only it may be touched (another may still be mounting). */
  const mountedEditor = useRef<Editor | null>(null);
  const [empty, setEmpty] = useState(value.length === 0);

  const report = (editor: Editor) => {
    if (applying.current) return;
    const map = serializeEditorDoc(editor.state.doc);
    const cursor = caretInMarkdown(editor.state, map);
    setEmpty(map.value.length === 0);
    if (map.value === snapshot.current.value && cursor === snapshot.current.cursor) return;
    snapshot.current = { value: map.value, cursor };
    latest.current.onChange(map.value, cursor);
  };

  const apply = (editor: Editor, next: string, caret: number, emit: boolean) => {
    applying.current = true;
    try {
      editor.commands.setContent(buildDocJson(next, docOptions), { emitUpdate: false });
      const map = serializeEditorDoc(editor.state.doc);
      const tr = editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, flatToPm(map, markdownToFlat(map, caret))),
      );
      editor.view.dispatch(editor.view.hasFocus() ? tr.scrollIntoView() : tr);
    } finally {
      applying.current = false;
    }
    snapshot.current = { value: next, cursor: caret };
    setEmpty(next.length === 0);
    if (emit) latest.current.onChange(next, caret);
  };

  const handleKeyDown = (view: EditorView, event: KeyboardEvent): boolean => {
    // Enter while an input method composes confirms the composition; it never sends.
    if (event.isComposing || event.keyCode === 229) return event.key === "Enter";
    readPendingSelection(view);
    const current = latest.current;
    if (current.onKeyDown?.(event) === true) return true;
    const dispatch = (tr: Transaction) => view.dispatch(tr.scrollIntoView());
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (codeBlockText(view.state) === null) return false;
      event.preventDefault();
      return indentCodeBlock(view.state, event.shiftKey ? "out" : "in", dispatch);
    }
    if (event.key !== "Enter") return false;
    const mod = event.metaKey || event.ctrlKey;
    if (richText && !mod && codeBlockText(view.state) !== null) {
      return (
        exitCodeBlockOnClosingFence(view.state, dispatch) ||
        exitCodeBlockOnTrailingBlankLines(view) ||
        indentedNewlineInCodeBlock(view.state, dispatch) ||
        newlineInCode(view.state, dispatch)
      );
    }
    if (richText && !mod && convertCodeFenceOnEnter(view.state, dispatch)) return true;
    if (submitsOnKey(event, current.sendShortcut)) {
      // A held Enter sends once.
      if (!event.repeat) current.onSubmit();
      return true;
    }
    const editor = editorRef.current;
    if (richText && editor && splitOrLiftListItem(editor)) return true;
    const { $from } = view.state.selection;
    if (
      richText &&
      editor &&
      inBlockquote($from) &&
      $from.parent.content.size === 0 &&
      editor.commands.lift("blockquote")
    ) {
      return true;
    }
    return splitBlockKeepMarks(view.state, dispatch);
  };

  /** T3's surround (D844): a bracket or quote typed over a selection wraps it. */
  const surroundSelection = (view: EditorView, from: number, to: number, text: string) => {
    if (literalText || view.composing || text.length !== 1) return false;
    const closer = SURROUND_CLOSE[text];
    const { selection, doc } = view.state;
    // An input method's update replaces a range even without a user selection.
    if (
      closer === undefined ||
      !(selection instanceof TextSelection) ||
      selection.empty ||
      selection.from !== from ||
      selection.to !== to
    ) {
      return false;
    }
    // Never a chip or styled text (the plain replace keeps its marks), nor the space bounding a chip.
    let special = false;
    doc.nodesBetween(from, to, (node) => {
      if (
        (node.isAtom && node.isInline && !node.isText) ||
        (node.isText && node.marks.length > 0)
      ) {
        special = true;
      }
      return !special;
    });
    if (special || boundsChip(doc, from, to)) return false;
    const tr = view.state.tr.insertText(closer, to).insertText(text, from);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1)));
    return true;
  };

  /** Pasted text is read as markdown, so a pasted file link or list arrives as one. */
  const handlePaste = (view: EditorView, event: ClipboardEvent): boolean => {
    const data = event.clipboardData;
    const editor = editorRef.current;
    if (!data || data.files.length > 0 || !editor) return false;
    let text = data.getData("text/plain");
    if (!text) return false;
    event.preventDefault();
    const markPaste = (tr: Transaction) => tr.setMeta("uiEvent", "paste");
    const { $from, from, to } = view.state.selection;
    if ($from.parent.type.spec.code === true) {
      view.dispatch(markPaste(view.state.tr.insertText(text, from, to)).scrollIntoView());
      return true;
    }
    // A chip pasted at either end keeps a space from the text around it.
    const segments = literalText ? [] : splitPromptIntoSegments(text);
    if (segments.length > 0 && segments.at(-1)?.type !== "text") text += " ";
    if (segments.length > 0 && segments[0]?.type !== "text") {
      const map = serializeEditorDoc(view.state.doc);
      const offset = caretInMarkdown(view.state, map);
      if (offset > 0 && !/\s/.test(map.value[offset - 1]!)) text = ` ${text}`;
    }
    const nested = listItemTypeAt($from) !== null || inBlockquote($from);
    const blocks = buildTiptapContent(text, { ...docOptions, blocks: !nested }) as JSONContent[];
    const content =
      blocks.length === 1 && blocks[0]?.type === "paragraph" ? (blocks[0].content ?? []) : blocks;
    if (Array.isArray(content) && content.length === 0) return true;
    editor
      .chain()
      .command(({ tr }) => {
        markPaste(tr);
        return true;
      })
      .insertContent(content)
      .command(({ tr }) => {
        // A paste ending in a rule leaves the rule selected, and the next keystroke would replace
        // it. The caret goes to the line after it, which is added when there is none.
        const { selection } = tr;
        if (!(selection instanceof NodeSelection) || !selection.node.isBlock) return true;
        if (!tr.doc.resolve(selection.to).nodeAfter?.isTextblock) {
          tr.insert(selection.to, tr.doc.type.schema.nodes["paragraph"]!.create());
        }
        tr.setSelection(TextSelection.create(tr.doc, selection.to + 1));
        return true;
      })
      .scrollIntoView()
      .run();
    return true;
  };

  const editable = !disabled && !readOnly;
  const attributes: Record<string, string> = {
    class: cn(EDITOR_CLASS_NAME, className),
    role: "textbox",
    "aria-label": "Message",
    "aria-multiline": "true",
    "aria-placeholder": placeholder,
    "data-composer-rich-text": richText ? "true" : "false",
    ...(disabled ? { "aria-disabled": "true" } : {}),
    ...(readOnly ? { "aria-readonly": "true" } : {}),
  };

  const editor = useEditor(
    {
      extensions: richText ? RICH_TEXT_EXTENSIONS : PLAIN_TEXT_EXTENSIONS,
      content: buildDocJson(value, docOptions),
      editable,
      editorProps: {
        attributes,
        handleKeyDown,
        handleTextInput: surroundSelection,
        handlePaste,
        handleDOMEvents: {
          paste: (_view, event) => {
            if (latest.current.onPaste?.(event) !== true) return false;
            event.preventDefault();
            return true;
          },
        },
        clipboardTextSerializer: (_slice, view) =>
          serializeSelection(view.state.doc, view.state.selection.from, view.state.selection.to),
      },
      onMount: ({ editor: created }) => {
        editorRef.current = created;
        mountedEditor.current = created;
        // A restored draft goes on where it ends.
        applying.current = true;
        try {
          created.view.dispatch(
            created.state.tr.setSelection(TextSelection.atEnd(created.state.doc)),
          );
        } finally {
          applying.current = false;
        }
      },
      // A destroyed editor has no view: nothing may touch it until the next one mounts.
      onDestroy: () => {
        mountedEditor.current = null;
      },
      onUpdate: ({ editor: updated }) => report(updated),
      onSelectionUpdate: ({ editor: updated }) => report(updated),
      onFocus: () => latest.current.onFocus?.(),
      onBlur: () => latest.current.onBlur?.(),
    },
    // Extensions are creation-time: a change of text mode builds the editor again, in place,
    // so the component and the parent's handle stay.
    [richText, literalText],
  );

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useLayoutEffect(() => {
    if (!editor || mountedEditor.current !== editor) return;
    editor.view.setProps({ attributes });
    if (editor.isEditable !== editable) {
      editor.setEditable(editable, false);
      // Node views (a code block's language picker) read `isEditable` on a transaction.
      editor.view.dispatch(editor.state.tr.setMeta("composerEditable", editable));
    }
  });

  useLayoutEffect(() => {
    if (!editor || mountedEditor.current !== editor || value === snapshot.current.value) return;
    apply(editor, value, value.length, false);
  }, [editor, value]);

  useImperativeHandle(
    handleRef,
    (): PromptEditorHandle => ({
      focus: () => {
        if (editor && mountedEditor.current === editor) editor.view.focus();
      },
      cursor: () => (editor ? caretInMarkdown(editor.state) : snapshot.current.cursor),
      replaceRange: (start, end, text) => {
        if (!editor || mountedEditor.current !== editor) return;
        const current = serializeEditorDoc(editor.state.doc).value;
        const from = Math.max(0, Math.min(current.length, start));
        const to = Math.max(from, Math.min(current.length, end));
        apply(editor, current.slice(0, from) + text + current.slice(to), from + text.length, true);
      },
      setValue: (next) => {
        if (editor && mountedEditor.current === editor) apply(editor, next, next.length, true);
      },
      value: () =>
        editor && mountedEditor.current === editor
          ? serializeEditorDoc(editor.state.doc).value
          : snapshot.current.value,
      caretOnFirstLine: () => caretOnVisualEdge(editor, "start"),
      caretOnLastLine: () => caretOnVisualEdge(editor, "end"),
    }),
    [editor],
  );

  return (
    <div className="relative flow-root">
      <EditorContent editor={editor} />
      {empty && placeholder ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75"
        >
          {placeholder}
        </div>
      ) : null}
    </div>
  );
}
