// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/chat/AssistantCitationChip.tsx and
// apps/web/src/components/chat/AssistantCitationCommentEditor.tsx.
//
// A quote of an agent's message as a chip (t3-parity.md D1011): in the prompt with its comment
// editor, in a sent message with the quote and "Go to source".
import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  assistantCitationLabel,
} from "@jhin/agent-api";
import {
  Button,
  ContextChip,
  ContextChipAction,
  ContextChipLabel,
  ContextChipPopover,
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@jhin/ui";
import { ArrowUpRightIcon, PencilIcon, QuoteIcon } from "lucide-react";
import { useState } from "react";

/** T3's AssistantCitationQuote: the quoted text, and the user's comment under it. */
function CitationQuote(props: { readonly citation: AssistantCitation }) {
  return (
    <div className="max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word">
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {props.citation.text}
      </blockquote>
      {props.citation.comment ? <p>{props.citation.comment}</p> : null}
    </div>
  );
}

/** A quote in a sent message: pressed, the quote and "Go to source". */
export function MessageCitationChip(props: {
  readonly citation: AssistantCitation;
  readonly showSource?: ((citation: AssistantCitation) => void) | undefined;
}) {
  const label = assistantCitationLabel(props.citation);
  const { showSource } = props;
  return (
    <ContextChipPopover
      accessibleLabel={`Quoted assistant text: ${label}`}
      icon={<QuoteIcon />}
      kind="citation"
      label={label}
    >
      <div className="flex flex-col items-start gap-3 p-1 text-sm">
        <CitationQuote citation={props.citation} />
        {showSource === undefined ? null : (
          <PopoverClose
            onClick={() => showSource(props.citation)}
            render={<Button size="sm" variant="outline" />}
          >
            <ArrowUpRightIcon aria-hidden="true" />
            Go to source
          </PopoverClose>
        )}
      </div>
    </ContextChipPopover>
  );
}

/** T3's AssistantCitationCommentEditor: Enter saves, Escape cancels, Shift+Enter a new line. */
function CommentEditor(props: {
  readonly citation: AssistantCitation;
  onSave(comment: string): void;
  onCancel(): void;
}) {
  const [comment, setComment] = useState(props.citation.comment ?? "");
  const tooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const save = () => {
    if (!tooLong) props.onSave(comment);
  };
  return (
    <div
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <textarea
        aria-description="Enter to save the citation comment; Shift+Enter for a new line."
        aria-invalid={tooLong || undefined}
        aria-label="Comment on selected text"
        autoFocus
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        onChange={(event) => setComment(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            save();
          }
        }}
        placeholder="Add an optional comment..."
        rows={2}
        value={comment}
      />
      {tooLong ? (
        <p className="pt-1 text-xs text-destructive" role="status">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          onClick={props.onCancel}
          onPointerDown={(event) => event.preventDefault()}
          size="xs"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          disabled={tooLong}
          onClick={save}
          onPointerDown={(event) => event.preventDefault()}
          size="xs"
        >
          {tooLong ? "Shorten comment" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A quote in the prompt (T3's composer citation chip): pressed, its source in the thread; its
 * pencil edits the user's comment on it.
 */
export function ComposerCitationChip(props: {
  readonly citation: AssistantCitation;
  readonly showSource?: ((citation: AssistantCitation) => void) | undefined;
  /** Saves the comment; without it the comment cannot be edited (a read-only prompt). */
  readonly onComment?: ((comment: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const label = assistantCitationLabel(props.citation);
  const { showSource, onComment } = props;
  return (
    <ContextChip contentEditable={false} data-assistant-citation-chip="true" kind="citation">
      <button
        aria-label={`View cited assistant text: ${label}`}
        className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit focus-visible:outline-2 focus-visible:outline-foreground"
        onClick={() => showSource?.(props.citation)}
        type="button"
      >
        <QuoteIcon aria-hidden="true" />
        <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
      </button>
      {onComment === undefined ? null : (
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger
            aria-label={
              props.citation.comment ? "Edit citation comment" : "Add comment to citation"
            }
            render={<ContextChipAction />}
          >
            <PencilIcon aria-hidden="true" />
          </PopoverTrigger>
          {open ? (
            <PopoverPopup
              align="end"
              aria-label="Edit citation comment"
              padding="compact"
              side="top"
              width="md"
            >
              <CommentEditor
                citation={props.citation}
                onCancel={() => setOpen(false)}
                onSave={(comment) => {
                  onComment(comment);
                  setOpen(false);
                }}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      )}
    </ContextChip>
  );
}
