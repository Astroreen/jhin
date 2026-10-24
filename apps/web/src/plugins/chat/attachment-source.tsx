// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/ReadOnlySourcePreview.tsx: a text attachment highlighted by
// @pierre/diffs, a chunk of its own. T3's virtualizer and worker pool are left out: a preview
// holds at most 1 MB of text. A line asked for is shown and tinted as T3's `useFileLineReveal`
// and `FILE_LINK_REVEAL_UNSAFE_CSS` of apps/web/src/components/files/ do (t3-parity.md D1430).
import { File } from "@pierre/diffs/react";
import { useRef } from "react";

import { useResolvedTheme } from "../../lib/resolved-theme.ts";

const REVEAL_ATTRIBUTE = "data-file-link-reveal";

const SOURCE_UNSAFE_CSS = `
[data-file] {
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background, var(--background)) !important;
  --diffs-light-bg: var(--code-background, var(--background)) !important;
  --diffs-dark-bg: var(--code-background, var(--background)) !important;
}
[${REVEAL_ATTRIBUTE}][data-line] {
  --diffs-line-bg: light-dark(
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 82%, var(--diffs-bg-selection-override, var(--diffs-selection-base))),
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 75%, var(--diffs-bg-selection-override, var(--diffs-selection-base)))
  ) !important;
}
[${REVEAL_ATTRIBUTE}][data-column-number] {
  background-color: light-dark(
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 75%, var(--diffs-bg-selection-number-override, var(--diffs-selection-base))),
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 60%, var(--diffs-bg-selection-number-override, var(--diffs-selection-base)))
  ) !important;
  color: var(--diffs-selection-number-fg) !important;
}
`;

/** T3's `clampFileLine`: a line past the end is the last one. */
function clampLine(text: string, line: number): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) lines += 1;
    else if (code === 13) {
      lines += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, line), lines);
}

export function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly wordWrap: boolean;
  /** A line to show, centred and tinted, and the request it is (bumped to show it again). */
  readonly reveal?: { readonly line: number; readonly id: number } | undefined;
}) {
  const theme = useResolvedTheme();
  const handled = useRef<number | undefined>(undefined);
  const reveal = props.reveal;
  const line = reveal === undefined ? undefined : clampLine(props.text, reveal.line);
  // T3's updateFileLinkReveal, after each render of the file: the line is marked, and scrolled to
  // once per request.
  const onPostRender = (container: HTMLElement) => {
    const root = container.shadowRoot ?? container;
    for (const element of root.querySelectorAll<HTMLElement>(`[${REVEAL_ATTRIBUTE}]`)) {
      element.removeAttribute(REVEAL_ATTRIBUTE);
    }
    if (line === undefined || reveal === undefined) return;
    const row = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
    row?.setAttribute(REVEAL_ATTRIBUTE, "");
    root.querySelector<HTMLElement>(`[data-column-number="${line}"]`)?.setAttribute(REVEAL_ATTRIBUTE, "");
    if (row === null || handled.current === reveal.id) return;
    handled.current = reveal.id;
    row.scrollIntoView({ block: "center" });
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <File
        className="min-h-full"
        disableWorkerPool
        file={{ name: props.name, contents: props.text }}
        key={`${props.name}:${theme}:${props.text.length}`}
        options={{
          disableFileHeader: true,
          overflow: props.wordWrap ? "wrap" : "scroll",
          theme: theme === "dark" ? "pierre-dark" : "pierre-light",
          themeType: theme,
          unsafeCSS: SOURCE_UNSAFE_CSS,
          onPostRender,
        }}
      />
    </div>
  );
}
