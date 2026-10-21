// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/ReadOnlySourcePreview.tsx: a text attachment highlighted by
// @pierre/diffs, a chunk of its own. T3's virtualizer and worker pool are left out: a preview
// holds at most 1 MB of text.
import { File } from "@pierre/diffs/react";

import { useResolvedTheme } from "../../lib/resolved-theme.ts";

const SOURCE_UNSAFE_CSS = `
[data-file] {
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background, var(--background)) !important;
  --diffs-light-bg: var(--code-background, var(--background)) !important;
  --diffs-dark-bg: var(--code-background, var(--background)) !important;
}
`;

export function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly wordWrap: boolean;
}) {
  const theme = useResolvedTheme();
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
        }}
      />
    </div>
  );
}
