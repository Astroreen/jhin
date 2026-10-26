// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/contextChipParts.tsx (PullRequestChip, UnresolvedChip),
// apps/web/src/components/PullRequestContextDetails.tsx, apps/web/src/components/ThreadContextChip.tsx,
// apps/web/src/components/composerContextPresentation.tsx (ComposerReviewCommentDetails: a review
// comment's popover, source-control.md D1458),
// apps/web/src/components/chat/TerminalContextInlineChip.tsx and the context chips of
// apps/web/src/components/composerContextPresentation.tsx and chat/MessagesTimeline.tsx.
//
// The chip of a context record (t3-parity.md D1007): in the prompt and in a sent message alike, a
// pull request with its state and branches, a thread, a terminal excerpt, or "no longer
// available" for a reference whose record is gone.
import type {
  AssistantCitation,
  MessageContextRecord,
  ReviewCommentContextRecord,
  TerminalContextRecord,
  ThreadContextRecord,
} from "@jhin/agent-api";
import {
  cn,
  ContextChip,
  ContextChipLabel,
  ContextChipPopover,
  ContextChipShell,
  type ContextChipKind,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import {
  ArrowRightIcon,
  CircleDashedIcon,
  GitPullRequestIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  TerminalIcon,
} from "lucide-react";

import { pullRequestDisplayState, pullRequestKindLabel } from "../../lib/composer-context.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import { resolvePullRequestState } from "../../lib/pull-request.ts";
import { ChatMarkdown } from "./markdown.tsx";

/** What a record's chip can do where it shows; without them it only shows. */
export interface ContextChipActions {
  /**
   * The thread's title now: `null` when its node has no such thread any more, `undefined` when
   * that is not known here (its record's title stands).
   */
  readonly threadTitle?: ((record: ThreadContextRecord) => string | null | undefined) | undefined;
  /** Whether a linked thread's `jhin://` address is one this view can open. */
  readonly canOpenThread?: ((href: string) => boolean) | undefined;
  /** Opens a linked thread; false when its address names no node in reach. */
  readonly openThread?: ((href: string) => boolean) | undefined;
  readonly openUrl?: ((url: string) => void) | undefined;
  /** Shows a quote's text in its message, selected (T3's "Go to source", D1011). */
  readonly showCitationSource?: ((citation: AssistantCitation) => void) | undefined;
}

const PULL_REQUEST_CHIP_KINDS = {
  open: "pr-open",
  draft: "pr-draft",
  merged: "pr-merged",
  closed: "pr-closed",
} as const satisfies Record<string, ContextChipKind>;

/** T3's PullRequestContextDetails: number and state, title, and its branches. */
function PullRequestContextDetails(props: {
  readonly metadata: NonNullable<ReviewCommentContextRecord["pullRequest"]>;
}) {
  const state = resolvePullRequestState(props.metadata);
  return (
    <div className="max-w-80 space-y-1 overflow-hidden py-0.5 text-left">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <state.Icon className={cn("size-3.5 shrink-0", state.toneClassName)} />
        <span className="text-foreground">Pull request #{props.metadata.number}</span>
        <span className={state.toneClassName}>{state.label}</span>
      </div>
      <div className="wrap-break-word text-foreground">{props.metadata.title}</div>
      <div className="flex min-w-0 items-center gap-1 text-3xs text-secondary-label">
        <code className="truncate">{props.metadata.headBranch}</code>
        <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
        <code className="truncate">{props.metadata.baseBranch}</code>
      </div>
    </div>
  );
}

function PullRequestChip(props: {
  readonly record: ReviewCommentContextRecord;
  readonly actions: ContextChipActions;
}) {
  const metadata = props.record.pullRequest!;
  const state = resolvePullRequestState(metadata);
  const display = pullRequestDisplayState(props.record) ?? "open";
  const open = props.actions.openUrl;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            aria-label={`Open ${pullRequestKindLabel(props.record)} ${props.record.label}: ${metadata.title}`}
            kind={PULL_REQUEST_CHIP_KINDS[display]}
            onClick={open === undefined ? undefined : () => open(metadata.url)}
            render={<button type="button" />}
          >
            <state.Icon />
            <ContextChipLabel>{props.record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        <PullRequestContextDetails metadata={metadata} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** T3's ThreadContextChip: the thread's title now, and "Open thread". */
function ThreadChip(props: {
  readonly record: ThreadContextRecord;
  readonly href: string;
  readonly actions: ContextChipActions;
}) {
  const current = props.actions.threadTitle?.(props.record);
  const title = current?.trim() || props.record.title;
  const { openThread, canOpenThread } = props.actions;
  // A thread gone, or on no node in reach, is no button.
  const open =
    current === null || openThread === undefined || canOpenThread?.(props.href) === false
      ? undefined
      : () => openThread(props.href);
  const content = (
    <>
      <MessagesSquareIcon />
      <ContextChipLabel>{title}</ContextChipLabel>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          open === undefined ? (
            <ContextChip aria-label={`Thread, ${title}`} kind="thread" tabIndex={0}>
              {content}
            </ContextChip>
          ) : (
            <ContextChip
              aria-label={`Thread, ${title}`}
              kind="thread"
              onClick={open}
              render={<button type="button" />}
            >
              {content}
            </ContextChip>
          )
        }
      />
      <TooltipPopup side="top">
        {open === undefined ? "Thread no longer available" : "Open thread"}
      </TooltipPopup>
    </Tooltip>
  );
}

/** T3's TerminalContextInlineChip: pressed, the captured lines with the terminal's name. */
function TerminalContextChip(props: { readonly record: TerminalContextRecord }) {
  const { record } = props;
  if (record.text.length === 0) {
    return (
      <ContextChipShell
        aria-label={`Terminal excerpt, ${record.label}, expired`}
        data-terminal-context-expired="true"
        icon={<TerminalIcon />}
        kind="terminal"
        label={record.label}
        state="invalid"
        tooltip={`Terminal context expired. Remove and re-add ${record.label} to include it in your message.`}
      />
    );
  }
  return (
    <ContextChipPopover
      accessibleLabel={`Terminal excerpt, ${record.label}`}
      icon={<TerminalIcon />}
      kind="terminal"
      label={record.label}
    >
      <div className="overflow-hidden rounded-md border border-border/70 bg-background/80">
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <TerminalIcon aria-hidden className="size-4 shrink-0 text-success" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {record.terminalLabel}
          </span>
          <span className="ml-auto shrink-0 text-xs text-secondary-label">
            {record.lineStart === record.lineEnd
              ? `Line ${record.lineStart}`
              : `Lines ${record.lineStart}–${record.lineEnd}`}
          </span>
        </div>
        <pre
          aria-label="Captured terminal output"
          className="max-h-80 overflow-auto bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre text-foreground outline-none [tab-size:4] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          tabIndex={0}
        >
          {record.text}
        </pre>
      </div>
    </ContextChipPopover>
  );
}

/** A comment's patch, highlighted as T3's ReadOnlySourcePreview shows it: a chunk of its own. */
const PatchPreview = lazyChunk(
  () => import("./attachment-source.tsx").then((module) => module.ReadOnlySourcePreview),
  {
    loading: () => null,
    failed: (props) => (
      <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs whitespace-pre">
        {props.text}
      </pre>
    ),
  },
);

/**
 * T3's ComposerReviewCommentDetails: the file, "section · range", the comment's text and its
 * patch.
 */
function ReviewCommentDetails(props: { readonly comment: ReviewCommentContextRecord }) {
  const { comment } = props;
  return (
    <div className="space-y-2 overflow-hidden rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="truncate text-xs font-medium text-foreground">{comment.filePath}</div>
        <div className="text-2xs text-secondary-label">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.trim() ? <ChatMarkdown text={comment.text.trim()} /> : null}
      {comment.diff.trim() ? (
        <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <PatchPreview name="review.diff" text={comment.diff} wordWrap={false} />
        </div>
      ) : null}
    </div>
  );
}

/** T3's UnresolvedChip: a reference whose record is gone. */
function UnresolvedChip(props: { readonly label: string; readonly tooltip: string }) {
  return (
    <ContextChipShell
      aria-label={`Unavailable context, ${props.label}`}
      icon={<CircleDashedIcon />}
      label={props.label}
      state="unresolved"
      tooltip={props.tooltip}
    />
  );
}

/** The chip of a `jhin-context://` reference: its record's, or unavailable without one. */
export function ContextRecordChip(props: {
  readonly record: MessageContextRecord | undefined;
  readonly label: string;
  readonly href: string;
  readonly actions: ContextChipActions;
  /** T3's wording differs: the composer can still remove or attach it again. */
  readonly unavailable: string;
}) {
  const { record } = props;
  if (record?.kind === "review-comment" && "sectionId" in record) {
    const comment = record as ReviewCommentContextRecord;
    if (comment.pullRequest !== undefined) {
      return <PullRequestChip actions={props.actions} record={comment} />;
    }
    return (
      <ContextChipPopover
        accessibleLabel={`Review comment, ${comment.label}`}
        icon={comment.filePath.startsWith("PR #") ? <GitPullRequestIcon /> : <MessageCircleIcon />}
        kind="review-comment"
        label={comment.label}
      >
        <ReviewCommentDetails comment={comment} />
      </ContextChipPopover>
    );
  }
  if (record?.kind === "thread" && "threadId" in record) {
    return (
      <ThreadChip
        actions={props.actions}
        href={`jhin://${(record as ThreadContextRecord).nodeId}/threads/${(record as ThreadContextRecord).threadId}`}
        record={record as ThreadContextRecord}
      />
    );
  }
  if (record?.kind === "terminal" && "terminalLabel" in record) {
    return <TerminalContextChip record={record as TerminalContextRecord} />;
  }
  return <UnresolvedChip label={props.label} tooltip={props.unavailable} />;
}
