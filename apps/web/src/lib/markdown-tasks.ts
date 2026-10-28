// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/ChatMarkdown.tsx (findTaskListMarkerOffset) and
// apps/web/src/components/files/filePreviewMode.ts (setMarkdownTaskChecked).
//
// Ticking a rendered markdown file's task boxes (t3-parity.md D1648).

/**
 * T3's findTaskListMarkerOffset: where the `[ ]` of a task item is in the source, from the offset
 * its list item starts at; null when its first line has none.
 */
export function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

/**
 * T3's setMarkdownTaskChecked: the one character between the brackets at `markerOffset` swapped,
 * the text unchanged when no box is there.
 */
export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }
  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
