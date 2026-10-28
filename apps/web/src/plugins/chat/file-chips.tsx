// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/chat/FileTagChip.tsx, the file-link chip of
// apps/web/src/components/ChatMarkdown.tsx and apps/web/src/components/chat/SkillInlineText.tsx.
//
// A file's chip and a skill's, in the prompt (D1003) and in a sent message (t3-parity.md D1341).
import { ContextChip, ContextChipLabel, Tooltip, TooltipPopup, TooltipTrigger } from "@jhin/ui";
import { BoxIcon } from "lucide-react";
import type { ComponentProps, MouseEvent } from "react";

import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/** T3's SkillChipIcon: lucide's box, a little bolder. */
export function SkillChipIcon() {
  return <BoxIcon aria-hidden strokeWidth={1.85} />;
}

/**
 * A file or folder: its Pierre icon and basename, its path in a tooltip; pressed, `onPreview`
 * (T3's mention chip), with the click for its ⌘/Ctrl (D1643). A folder opens nothing.
 */
export function FileMentionChip(
  props: {
    readonly path: string;
    readonly onPreview?: ((path: string, event: MouseEvent<HTMLElement>) => void) | undefined;
    /** In place of the basename: T3's `fileLinkLabel` of an agent's link ("a.ts · L12"). */
    readonly label?: string;
  } & Omit<ComponentProps<typeof ContextChip>, "kind" | "children">,
) {
  const { path, onPreview, label, ...rest } = props;
  const theme = useResolvedTheme();
  const folder = /[\\/]$/.test(path);
  const content = (
    <>
      <PierreEntryIcon kind={folder ? "directory" : "file"} pathValue={path} theme={theme} />
      <ContextChipLabel>{label ?? basename(path)}</ContextChipLabel>
    </>
  );
  const preview = folder ? undefined : onPreview;
  const chip =
    preview === undefined ? (
      <ContextChip {...rest} kind="mention" spellCheck={false} tabIndex={0}>
        {content}
      </ContextChip>
    ) : (
      <ContextChip
        {...rest}
        aria-label={`Preview ${path}`}
        kind="mention"
        onClick={(event: MouseEvent<HTMLElement>) => preview(path, event)}
        render={<button type="button" />}
        spellCheck={false}
      >
        {content}
      </ContextChip>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top">{path}</TooltipPopup>
    </Tooltip>
  );
}

/** A skill of a sent message: it only shows, as T3's `SkillChip`. */
export function MessageSkillChip(props: { readonly label: string }) {
  return (
    <ContextChip kind="skill">
      <SkillChipIcon />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}
