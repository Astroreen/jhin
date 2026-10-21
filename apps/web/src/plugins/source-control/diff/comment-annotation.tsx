// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/diffs/DiffCommentAnnotation.tsx
// (the draft's textarea and buttons) and diffs/commentSubmitShortcut.ts.
import { Button, Textarea } from "@jhin/ui";
import { useLayoutEffect, useRef } from "react";

interface CommentSubmitShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

function isCommentSubmitShortcut(
  event: CommentSubmitShortcutEvent,
  value: string,
  pending: boolean,
): boolean {
  return (
    !pending && (event.metaKey || event.ctrlKey) && event.key === "Enter" && value.trim().length > 0
  );
}

/** T3's comment draft under the lines it is about. */
export function DiffCommentAnnotation(props: {
  rangeLabel: string;
  text: string;
  pending: boolean;
  onTextChange(text: string): void;
  onCancel(): void;
  onComment(text: string): void;
}) {
  const { rangeLabel, text, pending } = props;
  const trimmedText = text.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Editable file annotations inherit Pierre's transparent native caret and selection.
  // Comments use a native textarea, so they need their own visible text feedback.
  return (
    <div
      className="px-3 py-2 font-sans text-foreground caret-foreground selection:bg-primary selection:text-primary-foreground"
      contentEditable={false}
      data-diff-comment-annotation
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        aria-label={`Comment on lines ${rangeLabel}`}
        autoFocus
        onChange={(event) => props.onTextChange(event.target.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          // While the comment is on its way, it can no longer be called back.
          if (event.key === "Escape" && !pending) {
            event.preventDefault();
            props.onCancel();
          }
          if (isCommentSubmitShortcut(event, trimmedText, pending)) {
            event.preventDefault();
            props.onComment(trimmedText);
          }
        }}
        placeholder="Add a comment…"
        ref={textareaRef}
        size="sm"
        value={text}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-3xs text-muted-foreground/70">⌘/Ctrl Enter to send</span>
        <Button disabled={pending} onClick={props.onCancel} size="xs" variant="ghost-muted">
          Cancel
        </Button>
        <Button
          disabled={pending || !trimmedText}
          onClick={() => props.onComment(trimmedText)}
          size="xs"
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
