// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/reviewCommentContext.ts
// (a comment on lines of a diff: its rows, range label and patch) and
// packages/shared/src/composerContextLegacySend.ts (renderReviewComment: the `<review_comment>` block).
// Unlike T3, a `<review_comment` or `</review_comment` inside the comment or its lines is
// neutralized (neutralizeClosingTag), so the text can neither end the block nor fake another.
import type {
  AnnotationSide,
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from "@pierre/diffs";

/** A comment on lines of a diff, as T3's ReviewCommentContext keeps it. */
export interface ReviewComment {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly text: string;
  readonly diff: string;
}
interface DiffReviewLine {
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function buildDiffReviewLines(
  fileDiff: FileDiffMetadata,
  includeExpandedContext: boolean,
  slice?: { readonly startIndex: number; readonly endIndex: number },
): ReadonlyArray<DiffReviewLine> {
  const rows: DiffReviewLine[] = [];
  let rowIndex = 0;
  let oldContextStart = 1;
  let newContextStart = 1;
  const pushRow = (row: DiffReviewLine) => {
    if (!slice || (rowIndex >= slice.startIndex && rowIndex <= slice.endIndex)) {
      rows.push(row);
    }
    rowIndex += 1;
  };
  const pushContextGap = (oldStart: number, newStart: number, lineCount: number) => {
    const count = Math.max(0, lineCount);
    const firstOffset = slice ? Math.max(0, slice.startIndex - rowIndex) : 0;
    const lastOffset = slice ? Math.min(count - 1, slice.endIndex - rowIndex) : count - 1;
    for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
      rows.push({
        change: "context",
        oldLineNumber: oldStart + offset,
        newLineNumber: newStart + offset,
        content: stripTrailingNewline(fileDiff.additionLines[newStart + offset - 1] ?? ""),
      });
    }
    rowIndex += count;
  };

  for (const hunk of fileDiff.hunks) {
    if (includeExpandedContext) {
      const oldHunkStart = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
      const newHunkStart = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
      const contextLines = Math.min(oldHunkStart - oldContextStart, newHunkStart - newContextStart);
      pushContextGap(oldContextStart, newContextStart, contextLines);
    }

    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          pushRow({
            change: "context",
            oldLineNumber,
            newLineNumber,
            content: stripTrailingNewline(
              fileDiff.additionLines[additionLineIndex] ??
                fileDiff.deletionLines[deletionLineIndex] ??
                "",
            ),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }

      for (let index = 0; index < segment.deletions; index += 1) {
        pushRow({
          change: "delete",
          oldLineNumber,
          newLineNumber: null,
          content: stripTrailingNewline(fileDiff.deletionLines[deletionLineIndex] ?? ""),
        });
        oldLineNumber += 1;
        deletionLineIndex += 1;
      }

      for (let index = 0; index < segment.additions; index += 1) {
        pushRow({
          change: "add",
          oldLineNumber: null,
          newLineNumber,
          content: stripTrailingNewline(fileDiff.additionLines[additionLineIndex] ?? ""),
        });
        newLineNumber += 1;
        additionLineIndex += 1;
      }
    }

    oldContextStart = hunk.deletionStart + hunk.deletionCount;
    newContextStart = hunk.additionStart + hunk.additionCount;
    if (hunk.deletionCount === 0) oldContextStart += 1;
    if (hunk.additionCount === 0) newContextStart += 1;
  }

  if (includeExpandedContext) {
    const trailingLines = Math.min(
      fileDiff.deletionLines.length - oldContextStart + 1,
      fileDiff.additionLines.length - newContextStart + 1,
    );
    pushContextGap(oldContextStart, newContextStart, trailingLines);
  }

  return rows;
}

function findDiffReviewLineIndex(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined,
  includeExpandedContext = !fileDiff.isPartial,
): number {
  const findOnSide = (selectedSide: "left" | "right") => {
    let rowIndex = 0;
    let oldContextStart = 1;
    let newContextStart = 1;
    const findContextIndex = (oldStart: number, newStart: number, lineCount: number) => {
      const count = Math.max(0, lineCount);
      const selectedStart = selectedSide === "left" ? oldStart : newStart;
      const offset = lineNumber - selectedStart;
      return offset >= 0 && offset < count ? rowIndex + offset : -1;
    };

    for (const hunk of fileDiff.hunks) {
      if (includeExpandedContext) {
        const oldContextEnd = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
        const newContextEnd = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
        const contextLines = Math.min(
          oldContextEnd - oldContextStart,
          newContextEnd - newContextStart,
        );
        const contextIndex = findContextIndex(oldContextStart, newContextStart, contextLines);
        if (contextIndex >= 0) return contextIndex;
        rowIndex += Math.max(0, contextLines);
      }

      let oldLineNumber = hunk.deletionStart;
      let newLineNumber = hunk.additionStart;
      for (const segment of hunk.hunkContent) {
        if (segment.type === "context") {
          const contextIndex = findContextIndex(oldLineNumber, newLineNumber, segment.lines);
          if (contextIndex >= 0) return contextIndex;
          rowIndex += segment.lines;
          oldLineNumber += segment.lines;
          newLineNumber += segment.lines;
          continue;
        }

        if (
          selectedSide === "left" &&
          lineNumber >= oldLineNumber &&
          lineNumber < oldLineNumber + segment.deletions
        ) {
          return rowIndex + lineNumber - oldLineNumber;
        }
        rowIndex += segment.deletions;
        oldLineNumber += segment.deletions;

        if (
          selectedSide === "right" &&
          lineNumber >= newLineNumber &&
          lineNumber < newLineNumber + segment.additions
        ) {
          return rowIndex + lineNumber - newLineNumber;
        }
        rowIndex += segment.additions;
        newLineNumber += segment.additions;
      }

      oldContextStart = hunk.deletionStart + hunk.deletionCount;
      newContextStart = hunk.additionStart + hunk.additionCount;
      if (hunk.deletionCount === 0) oldContextStart += 1;
      if (hunk.additionCount === 0) newContextStart += 1;
    }

    if (!includeExpandedContext) return -1;
    const trailingLines = Math.min(
      fileDiff.deletionLines.length - oldContextStart + 1,
      fileDiff.additionLines.length - newContextStart + 1,
    );
    return findContextIndex(oldContextStart, newContextStart, trailingLines);
  };

  const selectedSide = side === "deletions" ? "left" : "right";
  const preferredIndex = findOnSide(selectedSide);
  return preferredIndex >= 0
    ? preferredIndex
    : findOnSide(selectedSide === "left" ? "right" : "left");
}

function getDiffRange(
  lines: ReadonlyArray<DiffReviewLine>,
  key: "oldLineNumber" | "newLineNumber",
): { start: number; count: number } {
  const numberedLines = lines.filter((line) => line[key] !== null);
  return {
    start: numberedLines[0]?.[key] ?? 0,
    count: numberedLines.length,
  };
}

function getDiffChangeMarker(change: DiffReviewLine["change"]): string {
  if (change === "add") return "+";
  if (change === "delete") return "-";
  return " ";
}

function formatDiffReviewRangeLabel(lines: ReadonlyArray<DiffReviewLine>): string {
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  if (!firstLine || !lastLine) return "line";
  const firstNumber = firstLine.newLineNumber ?? firstLine.oldLineNumber;
  const lastNumber = lastLine.newLineNumber ?? lastLine.oldLineNumber;
  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? "line" : `${lines.length} lines`;
  }

  const firstMarker = getDiffChangeMarker(firstLine.change).trim();
  const marker =
    firstMarker.length > 0 && lines.every((line) => line.change === firstLine.change)
      ? firstMarker
      : "";
  return firstNumber === lastNumber
    ? `${marker}${firstNumber}`
    : `${marker}${firstNumber} to ${marker}${lastNumber}`;
}

/** The comment on a range of a file's diff; none when the range is not in it. */
export function buildDiffReviewComment(input: {
  sectionId: string;
  sectionTitle: string;
  filePath: string;
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
  text: string;
}): ReviewComment | null {
  const includeExpandedContext = !input.fileDiff.isPartial;
  const startIndex = findDiffReviewLineIndex(
    input.fileDiff,
    input.range.start,
    input.range.side,
    includeExpandedContext,
  );
  const endIndex = findDiffReviewLineIndex(
    input.fileDiff,
    input.range.end,
    input.range.endSide ?? input.range.side,
    includeExpandedContext,
  );
  if (startIndex < 0 || endIndex < 0) return null;

  const normalizedStartIndex = Math.min(startIndex, endIndex);
  const normalizedEndIndex = Math.max(startIndex, endIndex);
  const selectedLines = buildDiffReviewLines(input.fileDiff, includeExpandedContext, {
    startIndex: normalizedStartIndex,
    endIndex: normalizedEndIndex,
  });
  const oldRange = getDiffRange(selectedLines, "oldLineNumber");
  const newRange = getDiffRange(selectedLines, "newLineNumber");

  return {
    sectionId: input.sectionId,
    sectionTitle: input.sectionTitle,
    filePath: input.filePath,
    startIndex: normalizedStartIndex,
    endIndex: normalizedEndIndex,
    rangeLabel: formatDiffReviewRangeLabel(selectedLines),
    text: input.text.trim(),
    diff: [
      `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@`,
      ...selectedLines.map((line) => `${getDiffChangeMarker(line.change)}${line.content}`),
    ].join("\n"),
  };
}

/** Neither an opening nor a closing tag inside the text can start or end a block. */
function neutralizeClosingTag(value: string): string {
  return value.replace(/<(\/?)(review_comment)/gi, (_tag, slash: string, name: string) =>
    slash === "" ? `<\u200b${name}` : `<\\/${name}`,
  );
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The comment as T3 sends it to a provider without inline context: a
 * `<review_comment>` block with the comment and the lines as a fenced diff.
 */
export function serializeReviewComment(comment: ReviewComment): string {
  const attributes = [
    `sectionId="${escapeAttribute(comment.sectionId)}"`,
    `sectionTitle="${escapeAttribute(comment.sectionTitle)}"`,
    `filePath="${escapeAttribute(comment.filePath)}"`,
    `rangeLabel="${escapeAttribute(comment.rangeLabel)}"`,
    `startIndex="${comment.startIndex}"`,
    `endIndex="${comment.endIndex}"`,
  ].join(" ");
  // The fence must be longer than any run of backticks inside the diff so the body stays intact.
  const longestRun = Math.max(
    0,
    ...[...comment.diff.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  // A tag inside the comment or the lines would end the block early or fake another one.
  const text = neutralizeClosingTag(comment.text);
  const diff = neutralizeClosingTag(comment.diff);
  const body = diff ? `${text}\n\n${fence}diff\n${diff}\n${fence}` : text;
  return `<review_comment ${attributes}>\n${body}\n</review_comment>`;
}

/** Both ends of a range are rows of the file's diff (a refresh may have dropped them). */
export function rangeInDiff(fileDiff: FileDiffMetadata, range: SelectedLineRange): boolean {
  const expanded = !fileDiff.isPartial;
  return (
    findDiffReviewLineIndex(fileDiff, range.start, range.side, expanded) >= 0 &&
    findDiffReviewLineIndex(fileDiff, range.end, range.endSide ?? range.side, expanded) >= 0
  );
}

/**
 * Where a draft opens: under the selection's last row, also for a range
 * dragged upwards or across sides. Rows are compared, not line numbers: the
 * two ends' numbers may belong to the old and the new file.
 */
export function annotationAnchor(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): { side: AnnotationSide; lineNumber: number } {
  const endSide = range.endSide ?? range.side;
  const startRow = findDiffReviewLineIndex(fileDiff, range.start, range.side, !fileDiff.isPartial);
  const endRow = findDiffReviewLineIndex(fileDiff, range.end, endSide, !fileDiff.isPartial);
  const startIsLast = startRow > endRow;
  const side = startIsLast ? range.side : endSide;
  return {
    side: side === "deletions" ? "deletions" : "additions",
    lineNumber: startIsLast ? range.start : range.end,
  };
}
