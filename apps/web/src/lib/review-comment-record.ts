// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/reviewCommentContext.ts
// (ReviewCommentContext, buildFileReviewComment, inferReviewCommentFenceLanguage) and
// lib/composerContextRecords.ts (reviewCommentContextRecord and its label): a comment on lines,
// of a diff (source-control.md D1284) or of a file's own contents (t3-parity.md D1439), as the
// composer's record.
import {
  sanitizeContextLabel,
  toKindScopedContextId,
  type ReviewCommentContextRecord,
} from "@jhin/agent-api";

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

/** T3's buildFileReviewComment: a comment on lines of a file, the lines themselves its "diff". */
export function buildFileReviewComment(input: {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly contents: string;
}): ReviewComment {
  const startLine = Math.max(1, Math.min(input.startLine, input.endLine));
  const endLine = Math.max(startLine, Math.max(input.startLine, input.endLine));
  return {
    sectionId: `file:${input.filePath}`,
    sectionTitle: "File comment",
    filePath: input.filePath,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel: startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`,
    text: input.text.trim(),
    diff: input.contents.split("\n").slice(startLine - 1, endLine).join("\n"),
  };
}

/**
 * T3's reviewCommentContextLabel: the file's name and the lines, `L3 to L5`, `(before)` for
 * removed ones.
 */
function reviewCommentLabel(comment: Pick<ReviewComment, "filePath" | "rangeLabel">) {
  const diffRange = /^([+-])(\d+)(?: to \1(\d+))?$/u.exec(comment.rangeLabel);
  const rangeLabel = diffRange
    ? `L${diffRange[2]}${diffRange[3] ? ` to L${diffRange[3]}` : ""}${diffRange[1] === "-" ? " (before)" : ""}`
    : comment.rangeLabel;
  const name = comment.filePath.split("/").at(-1) ?? comment.filePath;
  return `${name} ${rangeLabel}`;
}

/** T3's COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS and COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS. */
const REVIEW_TEXT_MAX_CHARS = 16_000;
const REVIEW_DIFF_MAX_CHARS = 32_000;
const TRUNCATION_MARKER = "\n… truncated …";

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

/**
 * The comment as T3's reviewCommentContextRecord (D1284): a `review-comment` record the
 * composer shows as a chip, its id this comment's own.
 */
export function reviewCommentRecord(
  comment: ReviewComment,
  commentId: string,
): ReviewCommentContextRecord {
  return {
    version: 1,
    kind: "review-comment",
    contextId: toKindScopedContextId("review-comment", commentId),
    label: sanitizeContextLabel(reviewCommentLabel(comment), "review-comment"),
    sectionId: comment.sectionId,
    sectionTitle: comment.sectionTitle,
    filePath: comment.filePath,
    startIndex: comment.startIndex,
    endIndex: comment.endIndex,
    rangeLabel: comment.rangeLabel,
    text: clamp(comment.text, REVIEW_TEXT_MAX_CHARS),
    diff: clamp(comment.diff, REVIEW_DIFF_MAX_CHARS),
  };
}
