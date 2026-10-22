// What shows above the composer only on occasion (D440, D1041): T3's
// ComposerPendingApprovalPanel.tsx, ComposerPendingApprovalActions.tsx,
// ComposerPendingUserInputPanel.tsx, ComposerPlanFollowUpBanner and QueuedRunsControl.tsx and
// ComposerUsageLimits.tsx (MIT, see THIRD_PARTY_NOTICES.md), and the menu of a `/`, `@` or `$`
// trigger.
// A chunk of its own, loaded with the first of them to show.
import type {
  AgentResponse,
  ApprovalDecision,
  AgentUsageLimits,
  AgentUsageWindow,
  UserQuestion,
} from "@jhin/agent-api";
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  CheckIcon,
  CornerUpRightIcon,
  EllipsisIcon,
  GaugeIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  ShieldIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import { Fragment, useId, useRef, useState, type ComponentProps } from "react";

import type { TimestampFormat } from "../../lib/format.ts";
import {
  elapsedShare,
  formatResetsIn,
  formatUpcomingTimestamp,
  limitsNotice,
  paceOf,
  remainingPercent,
  type LimitPace,
} from "../../lib/usage-limits.ts";
import type { RequestItem, ThreadQueue } from "../../lib/timeline.ts";
import { useAttachmentUrl, type AttachmentLoader } from "./attachment-media.tsx";
import { ComposerBanner } from "./banner.tsx";
import { ComposerCommandMenu } from "./command-menu.tsx";
import type { QueueActions } from "./composer.tsx";

/** The menu of a `/`, `@` or `$` trigger, attached above the composer. */
export function CommandMenuBanner(props: ComponentProps<typeof ComposerCommandMenu>) {
  return (
    <ComposerBanner.Attachment>
      <ComposerCommandMenu {...props} />
    </ComposerBanner.Attachment>
  );
}

const APPROVAL_LABELS: Record<string, string> = {
  command: "Command approval",
  file_read: "File read approval",
  file_change: "File change approval",
};

export function ApprovalBanner(props: {
  request: RequestItem;
  count: number;
  onRespond(response: AgentResponse): void;
  busy: boolean;
}) {
  if (props.request.request.kind !== "approval") return null;
  const { tool, reason, access, decisions } = props.request.request;
  // An app asking for access is T3's MCP elicitation (providers.md D1146).
  const label =
    access !== undefined
      ? "App access approval"
      : (APPROVAL_LABELS[tool.kind] ?? "Permission approval");
  const offers = (decision: ApprovalDecision) =>
    decisions === undefined || decisions.includes(decision);
  const decide = (decision: "accept" | "accept-for-session" | "decline" | "cancel") =>
    props.onRespond({ kind: "approval", decision });
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="spacious" variant="warning">
        <ComposerBanner.Row layout="approval">
          <ComposerBanner.Icon>
            <ShieldIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span
              aria-label={label}
              className="flex min-w-0 flex-1 flex-col items-start gap-1"
              role="group"
            >
              <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
                <span className="shrink-0 font-medium text-warning">{label}</span>
                <span className="min-w-0 truncate">{access?.app ?? tool.title}</span>
                {props.count > 1 ? (
                  <span className="ml-auto shrink-0 tabular-nums">1/{props.count}</span>
                ) : null}
              </span>
              {access !== undefined ? (
                <span
                  aria-label="App access request"
                  className="block max-h-20 w-full min-w-0 overflow-auto font-sans text-xs whitespace-pre-wrap wrap-break-word text-foreground [scrollbar-width:thin]"
                  tabIndex={0}
                >
                  {tool.detail ?? label}
                </span>
              ) : (
                <code
                  className="block max-h-20 w-full min-w-0 overflow-auto font-mono text-xs whitespace-pre-wrap text-foreground [scrollbar-width:thin]"
                  tabIndex={0}
                >
                  {tool.detail ?? tool.name}
                </code>
              )}
              {reason === undefined ? null : (
                <span className="text-2xs text-muted-foreground">{reason}</span>
              )}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              disabled={props.busy}
              onClick={() => decide("decline")}
              size="xs"
              variant="outline"
            >
              <span className="max-w-40 truncate">Decline</span>
            </Button>
            <Button
              disabled={props.busy}
              onClick={() => decide("accept")}
              size="xs"
              variant="default"
            >
              <span className="max-w-40 truncate">Approve</span>
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label="More approval options"
                    disabled={props.busy}
                    size="icon-xs"
                    variant="outline"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" side="top">
                {offers("accept-for-session") ? (
                  <MenuItem className="mb-1 last:mb-0" onClick={() => decide("accept-for-session")}>
                    Always allow this session
                  </MenuItem>
                ) : null}
                <MenuItem className="mb-1 last:mb-0" onClick={() => decide("cancel")}>
                  Cancel
                </MenuItem>
              </MenuPopup>
            </Menu>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

/** The agent's questions: options to pick, the composer's text as a custom answer. */
export function QuestionsBanner(props: {
  questions: readonly UserQuestion[];
  index: number;
  selected: Readonly<Record<string, readonly string[]>>;
  onToggle(questionId: string, label: string, multi: boolean): void;
}) {
  const question = props.questions[props.index];
  if (question === undefined) return null;
  const chosen = props.selected[question.id] ?? [];
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant="info">
        <ComposerBanner.Row>
          <ComposerBanner.Icon />
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">{question.header}</span>
          </ComposerBanner.Content>
          {props.questions.length > 1 ? (
            <ComposerBanner.Actions>
              <span className="text-3xs font-medium text-muted-foreground tabular-nums">
                {props.index + 1}/{props.questions.length}
              </span>
            </ComposerBanner.Actions>
          ) : null}
        </ComposerBanner.Row>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            <p className="text-sm text-foreground/85">{question.question}</p>
            {question.multiSelect === true ? (
              <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
            ) : null}
            <div aria-label={question.question} className="mt-2 space-y-0.5" role="group">
              {question.options.map((option, optionIndex) => {
                const isSelected = chosen.includes(option.label);
                return (
                  <button
                    aria-pressed={isSelected}
                    className={cn(
                      "group flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                      isSelected
                        ? "bg-muted/55 text-foreground"
                        : "bg-transparent text-foreground/85 hover:bg-muted/30",
                    )}
                    key={option.label}
                    onClick={() =>
                      props.onToggle(question.id, option.label, question.multiSelect === true)
                    }
                    type="button"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.description === undefined ? null : (
                        <span className="text-secondary-label text-2xs">{option.description}</span>
                      )}
                    </div>
                    {isSelected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                    ) : optionIndex < 9 ? (
                      <kbd className="flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums">
                        {optionIndex + 1}
                      </kbd>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

/** T3's ComposerPlanFollowUpBanner: a plan-mode turn proposed a plan that can be implemented. */
export function PlanFollowUpBanner({ planTitle }: { planTitle: string | null }) {
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root aria-label="Plan ready" className="relative z-0" role="region">
        <ComposerBanner.Row>
          <ComposerBanner.Icon />
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">Plan ready</span>
            {planTitle ? (
              <span className="min-w-0 flex-1 truncate text-foreground/85">{planTitle}</span>
            ) : null}
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

const QUEUED_MESSAGE_DRAG_TYPE = "application/x-jhin-queued-message";

/**
 * Where a queued message dropped at `insertIndex` (the gap before that row,
 * the end at `ids.length`) goes: the message it goes before, `null` for the
 * end, or `undefined` when it stays where it is (T3's completeDrag).
 */
export function dropTarget(
  ids: readonly string[],
  messageId: string,
  insertIndex: number | null,
): string | null | undefined {
  const from = ids.indexOf(messageId);
  if (insertIndex === null || from === -1) return undefined;
  if (insertIndex === from || insertIndex === from + 1) return undefined;
  return ids[insertIndex] ?? null;
}

/** Why a held queue waits, in T3's words. */
function heldText(held: NonNullable<ThreadQueue["held"]>): string {
  if (held.reason === "refused") return `Not sent: ${held.error ?? "the node refused it"}`;
  return `${held.reason === "interrupted" ? "The turn was stopped" : "The turn failed"}: the queue waits`;
}

/** A queued image as T3 shows it: a small thumbnail, read from the node by its id. */
function QueuedThumbnail(props: {
  attachment: ThreadQueue["messages"][number]["attachments"][number];
  loader: AttachmentLoader;
}) {
  const { attachment } = props;
  const stored =
    attachment.id === undefined || attachment.sizeBytes === undefined
      ? undefined
      : {
          kind: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
  // A data URL's image (D54) has its data in the queue's record only: a placeholder, as T3 shows while loading.
  const url = useAttachmentUrl(stored, props.loader);
  return (
    <span className="size-4 overflow-hidden rounded border border-border/70 bg-background">
      {url ? (
        <img alt={attachment.name} className="size-full object-cover" src={url} />
      ) : (
        <span aria-label={attachment.name} className="block size-full bg-muted/60" role="img" />
      )}
    </span>
  );
}

/** T3's QueuedRunsControl: the thread's queue on its node, above the composer. */
export function QueueBanner(props: {
  queue: ThreadQueue;
  /** The running turn takes steers. */
  canSteer: boolean;
  running: boolean;
  /** The message being edited in the composer. */
  editing: string | undefined;
  actions: QueueActions;
  /** Reads the queued images back for their thumbnails. */
  loader: AttachmentLoader;
  onEdit(messageId: string): void;
  onCancelEdit(): void;
  steerShortcut?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  /** The message an action is under way for: one at a time, as in T3. */
  const [busyId, setBusyId] = useState<string | undefined>();
  const [drag, setDrag] = useState<{ id: string; insertIndex: number | null } | undefined>();
  // Drags start from the grip, not from text dragged out of a row.
  const armed = useRef<string | undefined>(undefined);
  const { messages, held } = props.queue;
  const run = async (messageId: string, action: () => Promise<boolean>) => {
    setBusyId(messageId);
    try {
      await action();
    } finally {
      setBusyId(undefined);
    }
  };
  const move = (messageId: string, beforeMessageId: string | null) =>
    void run(messageId, () => props.actions.reorder(messageId, beforeMessageId));
  const drop = (messageId: string, insertIndex: number | null) => {
    setDrag(undefined);
    armed.current = undefined;
    if (busyId !== undefined) return;
    const target = dropTarget(
      messages.map((message) => message.id),
      messageId,
      insertIndex,
    );
    if (target !== undefined) move(messageId, target);
  };
  const count = messages.length;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        aria-label={`${count} queued message${count === 1 ? "" : "s"}`}
        aria-live="polite"
        className="relative z-0"
        role="region"
      >
        <ComposerBanner.Row
          aria-controls={listId}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          onClick={() => setExpanded(!expanded)}
          onPointerDown={(event) => event.preventDefault()}
          render={<button type="button" />}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">Queued</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{count}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {held === undefined ? null : (
          <ComposerBanner.Row className="relative">
            <ComposerBanner.Icon />
            <ComposerBanner.Content>
              <span className="min-w-0 flex-1 truncate text-destructive-foreground" role="alert">
                {heldText(held)}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <Button
                disabled={busyId !== undefined}
                onClick={() => void run("", props.actions.resume)}
                size="xs"
                variant="outline"
              >
                {held.reason === "refused" ? "Retry" : "Resume"}
              </Button>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        )}
        <ComposerBanner.Scroll className={cn("max-h-32", !expanded && "hidden")}>
          <ComposerBanner.Children id={listId} render={<ol />}>
            {messages.map((message, index) => {
              const editing = message.id === props.editing;
              const thumbnails = message.attachments.filter((item) => item.kind === "image");
              const images = message.attachments.length;
              // T3 shows the images as thumbnails, so a message of images alone has no text.
              const preview =
                message.text.trim() ||
                (thumbnails.length > 0 ? "" : `${images} image${images === 1 ? "" : "s"}`);
              return (
                <ComposerBanner.Row
                  aria-current={editing ? "true" : undefined}
                  className={cn(
                    "relative rounded-sm",
                    editing && "bg-accent text-accent-foreground",
                    drag?.id === message.id && "opacity-50",
                  )}
                  draggable={busyId === undefined}
                  key={message.id}
                  onDragEnd={() => {
                    armed.current = undefined;
                    setDrag(undefined);
                  }}
                  onDragOver={(event) => {
                    if (drag === undefined) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertIndex =
                      event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                    if (drag.insertIndex !== insertIndex) setDrag({ ...drag, insertIndex });
                  }}
                  onDragStart={(event) => {
                    if (armed.current !== message.id) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(QUEUED_MESSAGE_DRAG_TYPE, message.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDrag({ id: message.id, insertIndex: null });
                  }}
                  onDrop={(event) => {
                    if (drag === undefined) return;
                    event.preventDefault();
                    drop(drag.id, drag.insertIndex);
                  }}
                  render={<li />}
                >
                  {drag?.insertIndex === index ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  {index === count - 1 && drag?.insertIndex === count ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  <ComposerBanner.Icon aria-hidden={false}>
                    <Button
                      aria-label="Reorder queued message (drag, or press the arrow keys)"
                      // Kept focusable while a move goes, so ↑/↓ can be pressed again.
                      aria-disabled={busyId !== undefined}
                      className="cursor-grab active:cursor-grabbing aria-disabled:cursor-default"
                      onPointerCancel={() => {
                        if (drag === undefined) armed.current = undefined;
                      }}
                      onPointerUp={() => {
                        armed.current = undefined;
                      }}
                      onKeyDown={(event) => {
                        if (busyId !== undefined) return;
                        if (event.key === "ArrowUp" && index > 0) {
                          event.preventDefault();
                          move(message.id, messages[index - 1]!.id);
                        }
                        if (event.key === "ArrowDown" && index < count - 1) {
                          event.preventDefault();
                          move(message.id, messages[index + 2]?.id ?? null);
                        }
                      }}
                      onPointerDown={() => {
                        armed.current = message.id;
                      }}
                      size="icon-xs"
                      variant="ghost-muted"
                    >
                      <GripVerticalIcon />
                    </Button>
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground/80">
                    {editing ? <span className="sr-only">Editing queued message: </span> : null}
                    {thumbnails.length > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        {thumbnails.map((thumbnail, thumbnailIndex) => (
                          <QueuedThumbnail
                            attachment={thumbnail}
                            key={thumbnail.id ?? `${thumbnail.name}-${thumbnailIndex}`}
                            loader={props.loader}
                          />
                        ))}
                      </span>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                        {preview}
                      </TooltipTrigger>
                      <TooltipPopup className="max-w-96 break-words" side="top">
                        {preview}
                      </TooltipPopup>
                    </Tooltip>
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {editing ? (
                      <Button
                        aria-label="Cancel editing queued message"
                        onClick={props.onCancelEdit}
                        size="xs"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                aria-label="Edit queued message"
                                disabled={busyId !== undefined || props.editing !== undefined}
                                onClick={() => props.onEdit(message.id)}
                                size="icon-xs"
                                variant="ghost-muted"
                              />
                            }
                          >
                            <PencilIcon />
                          </TooltipTrigger>
                          <TooltipPopup>Edit in the composer</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<span className="flex shrink-0" />}>
                            <Button
                              disabled={busyId !== undefined || !props.canSteer}
                              onClick={() =>
                                void run(message.id, () => props.actions.steer(message.id))
                              }
                              size="xs"
                              variant="ghost-muted"
                            >
                              <CornerUpRightIcon />
                              Steer
                            </Button>
                          </TooltipTrigger>
                          <TooltipPopup>
                            {!props.running
                              ? "There is no active run to steer"
                              : !props.canSteer
                                ? "This agent takes no steering"
                                : `Send as a steer instead${index === 0 && props.steerShortcut !== undefined ? ` (${props.steerShortcut})` : ""}`}
                          </TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <ComposerBanner.Dismiss
                                aria-label="Remove queued message"
                                disabled={busyId !== undefined}
                                onClick={() =>
                                  void run(message.id, () => props.actions.remove(message.id))
                                }
                              />
                            }
                          />
                          <TooltipPopup>Remove from queue</TooltipPopup>
                        </Tooltip>
                      </>
                    )}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

// `/usage-limits` (providers.md D1144): T3's usageLimitsBannerItem (ComposerUsageLimits.tsx) and
// LimitWindows with its WindowBar and PaceIcon (components/usage/UsageLimits.tsx).
const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};
/** T3's bar colour for Codex; one colour for every agent, as the client knows no agent ids. */
const BAR_COLOR = "var(--contrast-foreground, var(--foreground))";

function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={PACE[pace].label}
            className="inline-flex text-muted-foreground"
            role="img"
          />
        }
      >
        <Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{PACE[pace].label}</TooltipPopup>
    </Tooltip>
  );
}

function WindowBar(props: {
  readonly window: AgentUsageWindow;
  readonly now: number;
  readonly format: TimestampFormat;
}) {
  const { window, now } = props;
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, props.format, now)
    : null;
  const summary = `${window.label}: ${remaining}% left${
    timeLeft === null ? "" : `, ${timeLeft}% of the window left`
  }${resetsIn ? `, ${resetsIn}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={summary}
            className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            role="img"
            tabIndex={0}
          />
        }
      >
        <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
        {remaining > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{ width: `${remaining}%`, backgroundColor: BAR_COLOR }}
          />
        ) : null}
        {timeLeft !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
            style={{ left: `${timeLeft}%` }}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {remaining}% left{timeLeft !== null ? ` · ${timeLeft}% of the window left` : ""}
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">The line is where even spending would be.</span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function LimitWindows(props: {
  readonly windows: readonly AgentUsageWindow[];
  readonly now: number;
  readonly format: TimestampFormat;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-0.5">
      {props.windows.map((window) => {
        const pace = paceOf(window, props.now);
        const resetsIn = formatResetsIn(window, props.now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {remainingPercent(window)}% left
              </span>
            </span>
            <WindowBar format={props.format} now={props.now} window={window} />
            <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{resetsIn ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** The agent's usage limits, opened by `/usage-limits` and read when it was sent. */
export function UsageLimitsBanner(props: {
  /** The agent's name, T3's account summary. */
  readonly agentName: string;
  readonly limits: AgentUsageLimits;
  /** When it was opened: the bars and reset times are as of then. */
  readonly now: number;
  readonly format: TimestampFormat;
  onDismiss(): void;
}) {
  const notice = limitsNotice(props.limits);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" role="alert" variant="info">
        <ComposerBanner.Row layout="wrap-actions">
          <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
            <GaugeIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="whitespace-nowrap">
            <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">
              Usage limits
            </span>
            <span className="min-w-0 truncate text-muted-foreground">{props.agentName}</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Dismiss aria-label="Dismiss usage limits" onClick={props.onDismiss} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Children>
          <ComposerBanner.Scroll>
            <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
              <div className="flex min-w-0 flex-col gap-1">
                {notice ? (
                  <span className="text-xs text-muted-foreground">{notice}</span>
                ) : (
                  <LimitWindows
                    format={props.format}
                    now={props.now}
                    windows={props.limits.windows}
                  />
                )}
              </div>
            </ComposerBanner.Body>
          </ComposerBanner.Scroll>
        </ComposerBanner.Children>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
