// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/diffs/DiffCommentAnnotation.tsx
// (the draft's textarea and buttons, a sent comment with "Delete comment") and
// diffs/commentSubmitShortcut.ts.
import { Button, Textarea } from "@jhin/ui";
import { MessageCircleIcon, Trash2Icon } from "lucide-react";
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

  // Focused once Pierre has placed the annotation (T3 waits a frame the same way).
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
        // What is sent is fixed once Comment is pressed: nothing typed meanwhile could go.
        readOnly={pending}
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

/** T3's comment already added to the message, under its lines, with "Delete comment" (D1285). */
export function DiffComment(props: { text: string; onDelete(): void }) {
  return (
    <div
      className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground selection:bg-primary selection:text-primary-foreground"
      contentEditable={false}
      data-diff-comment-annotation
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MessageCircleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5">{props.text}</p>
      <span className="-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
        <Button
          aria-label="Delete comment"
          onClick={props.onDelete}
          size="icon-xs"
          variant="ghost-muted"
        >
          <Trash2Icon className="size-3" />
        </Button>
      </span>
    </div>
  );
}
