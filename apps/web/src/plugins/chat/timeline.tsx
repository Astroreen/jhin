// The timeline's design follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/MessagesTimeline.tsx, WorkLog.tsx, TimelineSystemDivider.tsx,
// MessageCopyButton.tsx and ProposedPlanCard.tsx.
import {
  type AssistantCitation,
  contextReferencesAsLabels,
  type MessageContext,
  type TurnAttachment,
} from "@jhin/agent-api";
import type { ChatMessageActionProps, MeshMembership, NodeTarget } from "@jhin/client-api";
import { Badge, Button, Slot, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CopyIcon,
  EyeIcon,
  GitForkIcon,
  GitMergeIcon,
  GlobeIcon,
  HammerIcon,
  ListTodoIcon,
  MessageCircleIcon,
  RotateCcwIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Suspense,
  createContext,
  lazy,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  formatDayAwareTimestamp,
  formatDuration,
  formatFullTimestamp,
  formatWorkingTimer,
  type TimestampFormat,
} from "../../lib/format.ts";
import { revealAssistantCitation } from "../../lib/assistant-text-selection.ts";
import { citationSource, knownRecordsById, threadLinks } from "../../lib/composer-context.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { useCopy, useNow } from "../../lib/hooks.ts";
import {
  adjacentExtensions,
  answerPreview,
  foldsBeforeFinal,
  summarizeWork,
  turnBlocks,
  workEntryLabel,
  type ExtensionItem,
  type MessageItem,
  type PlanItem,
  type Timeline,
  type TimelineTurn,
  type WorkEntry,
} from "../../lib/timeline.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import { usageLimitFailureLabel } from "../../lib/usage-limits.ts";
import {
  type MessageContextChips,
  MessageContextChipsContext,
  type MessageFileChips,
} from "./message-context.ts";
import { ChatContext } from "./services.ts";
import { THREAD_FIND_UNFOLD_EVENT } from "./thread-find.tsx";
import { splitPromptIntoSegments } from "../../lib/composer-trigger.ts";
import { MessageText } from "./message-text.tsx";
import type { SavePlan } from "./proposed-plan-card.tsx";

/** The plan card loads with the first proposed plan, not with the page (D440). */
const ProposedPlanCard = lazy(() =>
  import("./proposed-plan-card.tsx").then((module) => ({ default: module.ProposedPlanCard })),
);

export function MessageCopyButton({
  text,
  label = "Copy message",
}: {
  text: string;
  label?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={copied}
            onClick={() => copy(text)}
            size="xs"
            variant="ghost-muted"
          />
        }
      >
        {copied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{copied ? "Copied" : label}</TooltipPopup>
    </Tooltip>
  );
}

/** Where the timeline's messages live, for the `chat.message.actions` slot. */
const MessageActionsContext = createContext<
  { target: NodeTarget; threadId: string; running: boolean } | undefined
>(undefined);

/**
 * The hover row's buttons of a message: the `chat.message.actions` slot, or
 * only the copy button where the timeline is shown without a thread.
 */
function MessageActions(props: {
  turnId: string;
  role: "user" | "assistant";
  text: string;
  latest: boolean;
}) {
  const where = useContext(MessageActionsContext);
  if (where === undefined) {
    return props.text === "" ? null : <MessageCopyButton text={props.text} />;
  }
  return (
    <Slot
      name="chat.message.actions"
      props={{ ...where, ...props } satisfies ChatMessageActionProps}
    />
  );
}

/** The thread view's file preview and its agent's skills, for a message's chips (D1341). */
const FileChipsContext = createContext<MessageFileChips | undefined>(undefined);

/**
 * A user message's context records for its chips (D1007): a thread opens when this node has it,
 * a pull request in the browser.
 */
function useMessageContextChips(
  context: MessageContext | undefined,
  text: string,
): MessageContextChips | undefined {
  const where = useContext(MessageActionsContext);
  const chat = useContext(ChatContext);
  const files = useContext(FileChipsContext);
  // A file link or a `$name` is a chip too (D1341).
  const fileOrSkill = useMemo(
    () =>
      // A legacy `@path` stays text in a message: only links and `$name`s become chips.
      splitPromptIntoSegments(text).some(
        (segment) =>
          (segment.type === "mention" && segment.source.startsWith("[")) ||
          segment.type === "skill",
      ),
    [text],
  );
  // The mesh's members, to reach a thread chip's node: followed only for a message with one.
  const threads = context?.records.some((record) => record.kind === "thread") === true;
  // A message with quotes needs the chips too, records or not (D1011).
  const citations = text.includes("](jhin-citation:");
  // Without the chat there is no connection to follow, and the mesh is never read.
  const members = useMeshMembers(
    chat?.mesh as MeshMembership,
    (threads || citations) && chat !== undefined ? where?.target.node : undefined,
  );
  const selfNodeId = members?.find((member) => member.self)?.nodeId;
  return useMemo(() => {
    if (context === undefined && !citations && !fileOrSkill) return undefined;
    const links =
      where === undefined || chat === undefined
        ? undefined
        : threadLinks(
            {
              target: where.target,
              nodeId: where.target.remote ?? selfNodeId,
              selfNodeId,
            },
            (at) => chat.threads.catalog(at),
            (route) => chat.navigation.navigate(route),
          );
    return {
      skills: files?.skills,
      previewFile: files?.previewFile,
      records: knownRecordsById(context?.records),
      actions: {
        ...links,
        showCitationSource:
          links === undefined
            ? (citation: AssistantCitation) => void revealAssistantCitation(document, citation)
            : citationSource(links, (citation) => revealAssistantCitation(document, citation)),
        openUrl: (url: string) => {
          if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
        },
      },
    };
  }, [context, citations, fileOrSkill, files, where, chat, selfNodeId]);
}

/** Whether the thread's find bar is open: folded work is then there to be found (D1351). */
const FindOpenContext = createContext(false);

/** The clock of the timeline: "today" and "yesterday" labels roll over with it. */
const NowContext = createContext(Date.now());

function Timestamp({
  at,
  format,
  className,
}: {
  at: string;
  format: TimestampFormat;
  className?: string;
}) {
  const now = useContext(NowContext);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<p className={cn("text-muted-foreground text-xs tabular-nums", className)} />}
      >
        {formatDayAwareTimestamp(at, format, now)}
      </TooltipTrigger>
      <TooltipPopup side="top">{formatFullTimestamp(at, format)}</TooltipPopup>
    </Tooltip>
  );
}

/** T3's attachments of a sent message, a chunk of its own loaded with the first one (D440). */
const MessageAttachmentsView = lazyChunk(
  () => import("./attachment-views.tsx").then((module) => module.MessageAttachments),
  { loading: () => null, failed: () => null },
);

function MessageAttachments({ attachments }: { attachments: readonly TurnAttachment[] }) {
  return attachments.length === 0 ? null : <MessageAttachmentsView attachments={attachments} />;
}

/** Long messages fold to a few lines (over 600 characters or 8 lines). */
const isLong = (text: string) => text.length > 600 || text.split("\n").length > 8;

/** A message of the user: the one a turn answers, or one steered into it (D205). */
function UserMessage({
  turn,
  format,
  latest = false,
}: {
  /** With its `turnId` when it is the message a turn answers: only that one is edited from here. */
  turn: Pick<TimelineTurn, "text" | "attachments" | "startedAt" | "context"> & {
    turnId?: string;
  };
  format: TimestampFormat;
  latest?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(turn.text);
  const chips = useMessageContextChips(turn.context, turn.text);
  // A copy reads the references by their labels, as the message shows them.
  const copied = contextReferencesAsLabels(turn.text);
  return (
    <div className="group flex flex-col items-end gap-1 pb-4">
      <article
        aria-label="You"
        className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
      >
        <MessageAttachments attachments={turn.attachments} />
        {turn.text === "" ? null : (
          <div
            className={cn(long && !expanded && "relative max-h-44 overflow-hidden")}
            style={
              long && !expanded
                ? {
                    maskImage:
                      "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)",
                  }
                : undefined
            }
          >
            <MessageContextChipsContext value={chips}>
              <MessageText className="text-foreground" lineBreaks text={turn.text} />
            </MessageContextChipsContext>
          </div>
        )}
      </article>
      {long ? (
        <div className="flex max-w-[80%] items-center justify-end">
          <Button
            className="-ml-1"
            onClick={() => setExpanded(!expanded)}
            size="xs"
            variant="ghost-muted"
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      ) : null}
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Timestamp at={turn.startedAt} format={format} />
          <div className="flex items-center gap-0.5">
            {turn.turnId === undefined ? (
              turn.text === "" ? null : (
                <MessageCopyButton text={copied} />
              )
            ) : (
              <MessageActions latest={latest} role="user" text={copied} turnId={turn.turnId} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantMessage(props: {
  item: MessageItem;
  turnId: string;
  latest: boolean;
  streaming: boolean;
  showMeta: boolean;
  format: TimestampFormat;
  paddingClass: string;
}) {
  const { item, streaming } = props;
  const where = useContext(MessageActionsContext);
  return (
    <div className={cn("group/assistant relative min-w-0 px-1 py-0.5", props.paddingClass)}>
      <article
        aria-busy={streaming}
        aria-label="Agent"
        // Where a quote of it is found (D1012): its item in its thread.
        data-assistant-citation-source={where === undefined ? undefined : item.itemId}
        data-assistant-citation-thread={where?.threadId}
      >
        <MessageText
          streaming={streaming}
          text={item.text || (streaming ? "" : "(empty response)")}
        />
      </article>
      {props.showMeta ? (
        <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100">
          <div className="flex items-center gap-0.5">
            <MessageActions
              latest={props.latest}
              role="assistant"
              text={item.text}
              turnId={props.turnId}
            />
          </div>
          <Timestamp at={item.at} format={props.format} />
        </div>
      ) : null}
    </div>
  );
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  command: TerminalIcon,
  file_change: SquarePenIcon,
  file_read: EyeIcon,
  search: SearchIcon,
  web: GlobeIcon,
  mcp: HammerIcon,
  agent: BotIcon,
  todo: ListTodoIcon,
  other: WrenchIcon,
};

function entryIcon(entry: WorkEntry): LucideIcon {
  if (entry.kind === "reasoning") return BrainIcon;
  if (entry.kind === "request") return MessageCircleIcon;
  return TOOL_ICONS[entry.tool.kind] ?? WrenchIcon;
}

/** One line of the work log: icon, label, chevron; T3 Code's WorkLogRow. */
function WorkLine(props: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?(): void;
  children?: ReactNode;
  className?: string;
}) {
  const interactive = props.expandable === true;
  return (
    <div
      className={cn(
        "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 py-0.5 text-left transition-colors",
        props.className,
      )}
    >
      {/* The toggle is the line itself; what it shows sits below it, outside the button. */}
      <div
        aria-expanded={interactive ? props.expanded : undefined}
        className={cn(
          "flex min-h-6 min-w-0 items-center gap-1.5 rounded-md text-sm leading-relaxed select-none [&_*]:select-none",
          interactive &&
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
        onClick={interactive ? props.onToggle : undefined}
        onKeyDown={
          interactive
            ? (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onToggle?.();
                }
              }
            : undefined
        }
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{props.icon}</span>
            </span>
          </span>
          <div className="min-w-0 flex-1 truncate text-secondary-label [&_*]:whitespace-nowrap">
            {props.label}
          </div>
        </div>
        {props.trailing}
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            !interactive && "invisible",
          )}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
              props.expanded === true && "rotate-90",
            )}
          />
        </span>
      </div>
      {props.children}
    </div>
  );
}

/** The expanded details of a work entry: output, input, answers. */
function entryDetails(entry: WorkEntry): string {
  if (entry.kind === "reasoning") return entry.text;
  if (entry.kind === "request") {
    if (entry.request.kind === "approval") {
      const tool = entry.request.tool;
      return [tool.title, tool.detail, entry.request.reason].filter(Boolean).join("\n\n");
    }
    return entry.request.questions
      .map((question) => `${question.question}\n  ${answerPreview(entry) || "(no answer)"}`)
      .join("\n\n");
  }
  const parts = [
    entry.tool.detail,
    entry.output.trimEnd(),
    entry.error === undefined ? undefined : `Error: ${entry.error}`,
  ];
  if (entry.output === "" && entry.tool.input !== undefined) {
    parts.push(`Tool input\n${JSON.stringify(entry.tool.input, null, 2)}`);
  }
  return parts.filter((part) => part !== undefined && part !== "").join("\n\n");
}

function WorkEntryRow({ entry, live }: { entry: WorkEntry; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = entryIcon(entry);
  const details = entryDetails(entry);
  const failed =
    entry.kind === "tool" && (entry.status === "failed" || entry.status === "declined");
  const running = entry.kind === "tool" && entry.status === "running";
  const label = workEntryLabel(entry);
  return (
    <WorkLine
      expandable={details !== "" && details !== label}
      expanded={expanded}
      icon={
        <span
          className={cn(
            "flex size-4 items-center justify-center",
            failed ? "text-tool-error-icon/40" : "text-icon-muted",
          )}
        >
          <Icon className="block size-4 shrink-0 stroke-2" />
        </span>
      }
      label={
        <span className={cn("block truncate", running && live && "live-tool-shine")}>
          {label}
          {entry.kind === "request" && entry.request.kind === "user-input" ? (
            <span className="ms-1.5 text-foreground">{answerPreview(entry)}</span>
          ) : null}
        </span>
      }
      onToggle={() => setExpanded(!expanded)}
    >
      {expanded ? (
        <div className="mt-0.5 mb-1.5 cursor-auto pb-2">
          {entry.kind === "reasoning" ? (
            <div className="ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
              <MessageText className="text-foreground" lineBreaks text={entry.text} />
            </div>
          ) : (
            <pre className="ms-7 max-h-64 cursor-text overflow-auto font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-secondary-label select-text">
              {details}
            </pre>
          )}
        </div>
      ) : null}
    </WorkLine>
  );
}

/** Consecutive work entries: one row each when alone, a summary that expands when several. */
function WorkGroup({ entries, live }: { entries: readonly WorkEntry[]; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 1) {
    return (
      <div className="pb-2">
        <WorkEntryRow entry={entries[0]!} live={live} />
      </div>
    );
  }
  const { summary, hasFailure } = summarizeWork(entries);
  const runningEntry = live
    ? entries.findLast((entry) => entry.kind === "tool" && entry.status === "running")
    : undefined;
  const reasoningOnly = entries.every((entry) => entry.kind === "reasoning");
  const HeaderIcon = reasoningOnly ? BrainIcon : hasFailure ? CircleAlertIcon : HammerIcon;
  return (
    <div className="pb-2">
      <WorkLine
        expandable
        expanded={expanded}
        icon={<HeaderIcon className="size-4 shrink-0 stroke-2 text-icon-muted" />}
        label={
          <span className={cn("block truncate", runningEntry !== undefined && "live-tool-shine")}>
            {runningEntry === undefined ? summary : workEntryLabel(runningEntry)}
          </span>
        }
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <div className="ms-3 border-l border-border/60 ps-1.5">
          {entries.map((entry, index) => (
            <WorkEntryRow
              entry={entry}
              key={"itemId" in entry ? entry.itemId : `${entry.requestId}-${index}`}
              live={live}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({ item }: { item: PlanItem }) {
  const done = item.steps.filter((step) => step.status === "completed").length;
  return (
    <div className="min-w-0 px-1 py-0.5 pb-4">
      <div className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary">Plan</Badge>
            <h3 className="truncate text-sm font-medium text-foreground">
              {done} of {item.steps.length} done
            </h3>
          </div>
        </div>
        <ol className="mt-4 flex flex-col gap-1.5" aria-label="Plan">
          {item.steps.map((step, index) => (
            <li className="flex items-start gap-2 text-sm" key={`${index}-${step.text}`}>
              {step.status === "completed" ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
              ) : step.status === "in_progress" ? (
                <CircleDashedIcon className="mt-0.5 size-4 shrink-0 animate-status-pulse text-info" />
              ) : (
                <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
              )}
              <span
                className={cn(
                  "min-w-0",
                  step.status === "completed"
                    ? "text-muted-foreground line-through"
                    : "text-foreground/85",
                )}
              >
                {step.text}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** "Working for 12s", ticking without re-rendering the timeline. */
function WorkingTimer({ startedAt }: { startedAt: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (ref.current !== null) ref.current.textContent = formatWorkingTimer(startedAt);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <span className="tabular-nums" ref={ref}>
      {formatWorkingTimer(startedAt)}
    </span>
  );
}

function SystemDivider(props: {
  label: string;
  detail?: string | undefined;
  tone?: "danger";
  icon?: LucideIcon;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const Icon = props.icon ?? XIcon;
  const content = (
    <>
      <Icon className="size-3 shrink-0" />
      <span className="font-medium">{props.label}</span>
      {props.detail === undefined ? null : (
        <span className="inline-flex min-w-0 max-w-80 items-center truncate opacity-70">
          · {props.detail}
        </span>
      )}
    </>
  );
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-2xs text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
      role="status"
    >
      <span aria-hidden className="h-px flex-1 bg-border/70" />
      {props.onAction === undefined ? (
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1">
          {content}
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label={props.actionLabel}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                onClick={props.onAction}
                type="button"
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.actionLabel}</TooltipPopup>
        </Tooltip>
      )}
      <span aria-hidden className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function TurnView(props: {
  turn: TimelineTurn;
  latest: boolean;
  format: TimestampFormat;
  onRetry?(): Promise<unknown>;
  projectPath?: string;
  onSavePlan?: SavePlan;
  /** What goes under the turn's message, before its work (the `chat.turn.header` slot). */
  header?: ReactNode;
  footer?: ReactNode;
  /** An event of another plugin in the turn (the `chat.turn.item` slot), with those beside it. */
  extension?:
    | ((event: ExtensionItem["event"], adjacent: readonly ExtensionItem["event"][]) => ReactNode)
    | undefined;
}) {
  const { turn, format } = props;
  const now = useContext(NowContext);
  const [unfolded, setUnfolded] = useState(false);
  /** One retry at a time: a second click while it goes would send the message twice. */
  const [retrying, setRetrying] = useState(false);
  const running = turn.state === "running";
  // T3 shows a usage limit as a warning with when to retry, not as an error (D1143).
  const limited = turn.failure?.class === "usage_limit";
  const blocks = turnBlocks(turn);
  const folds = foldsBeforeFinal(turn);
  const finalIndex = blocks.findIndex((block) => block.kind === "message" && block.final);
  // A proposed plan is never folded away (it is what the turn is for), nor a
  // message the user steered in.
  /** A block the finished turn folds away: before its answer, and none of what always shows. */
  const foldable = (block: (typeof blocks)[number], index: number) =>
    folds &&
    index < finalIndex &&
    block.kind !== "proposed-plan" &&
    block.kind !== "steer" &&
    // A compaction is a turn's quiet landmark, never folded away (D1271).
    block.kind !== "compaction" &&
    // What a plugin put into the turn (a rendered page) is part of the answer.
    block.kind !== "extension";
  const shownFolded = (block: (typeof blocks)[number], index: number) =>
    unfolded || !foldable(block, index);
  // While the find bar is open the folded work is there too, hidden, so its text is found; the
  // fold opens once the current match is in it (T3's find opens it, D1351).
  const findOpen = useContext(FindOpenContext);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const unfold = () => setUnfolded(true);
    element.addEventListener(THREAD_FIND_UNFOLD_EVENT, unfold);
    return () => element.removeEventListener(THREAD_FIND_UNFOLD_EVENT, unfold);
  }, []);
  const duration =
    turn.endedAt === undefined
      ? undefined
      : formatDuration(Date.parse(turn.endedAt) - Date.parse(turn.startedAt));
  const foldLabel =
    turn.state === "interrupted"
      ? duration === undefined
        ? "You stopped this response"
        : `You stopped after ${duration}`
      : duration === undefined
        ? "Worked"
        : `Worked for ${duration}`;
  const lastMessage = blocks.findLast((block) => block.kind === "message");
  // Not rebuilt on every tick of a running turn's clock.
  const adjacent = useMemo(() => adjacentExtensions(turnBlocks(turn)), [turn]);

  const renderBlock = (block: (typeof blocks)[number], index: number) => {
    if (block.kind === "work") {
      return <WorkGroup entries={block.entries} key={`work-${index}`} live={running} />;
    }
    if (block.kind === "plan") return <PlanCard item={block.item} key={`plan-${index}`} />;
    if (block.kind === "extension") {
      return (
        <Fragment key={`extension-${block.item.event.sequence}`}>
          {props.extension?.(
            block.item.event,
            adjacent.get(block.item.event.sequence) ?? [block.item.event],
          )}
        </Fragment>
      );
    }
    if (block.kind === "compaction") {
      return (
        <div
          className="flex items-center gap-3 px-1 pb-4 text-xs text-muted-foreground"
          key={`compaction-${block.item.sequence}`}
          role="separator"
          aria-label={
            block.item.trigger === undefined
              ? "Context compacted"
              : `Context compacted (${block.item.trigger === "auto" ? "automatic" : "manual"})`
          }
        >
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span>
            Context compacted
            {block.item.trigger === undefined
              ? ""
              : ` · ${block.item.trigger === "auto" ? "automatic" : "manual"}`}
          </span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      );
    }
    if (block.kind === "steer") {
      return (
        <UserMessage
          format={format}
          key={`steer-${block.item.messageId}`}
          turn={{
            text: block.item.text,
            attachments: block.item.attachments,
            ...(block.item.context === undefined ? {} : { context: block.item.context }),
            startedAt: block.item.at,
          }}
        />
      );
    }
    if (block.kind === "proposed-plan") {
      return (
        <div className="min-w-0 px-1 py-0.5 pb-4" key={block.item.itemId}>
          <Suspense fallback={null}>
            <ProposedPlanCard
              planMarkdown={block.item.markdown}
              {...(props.onSavePlan === undefined ? {} : { onSave: props.onSavePlan })}
              {...(props.projectPath === undefined ? {} : { workspaceRoot: props.projectPath })}
            />
          </Suspense>
        </div>
      );
    }
    const streaming = running && block.item === lastMessage?.item && !block.item.completed;
    return (
      <AssistantMessage
        format={format}
        item={block.item}
        latest={props.latest}
        turnId={turn.turnId}
        key={block.item.itemId}
        paddingClass={block.final ? "pb-4" : "pb-2"}
        showMeta={block.final}
        streaming={streaming}
      />
    );
  };
  return (
    <div className="flex flex-col" data-turn={turn.turnId} ref={root}>
      <UserMessage format={format} latest={props.latest} turn={turn} />
      {props.header}
      {running ? (
        <div className="pb-1.5">
          <div className="border-b border-border/60 pt-1 pb-2">
            <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
              <span className="relative shrink-0 overflow-hidden whitespace-nowrap" role="status">
                Working for <WorkingTimer startedAt={turn.startedAt} />
              </span>
            </div>
          </div>
        </div>
      ) : folds || turn.state === "interrupted" ? (
        <div className="pb-1.5">
          <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pt-1 pe-0.5 pb-2">
            <button
              aria-expanded={folds ? unfolded : undefined}
              className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:cursor-default"
              disabled={!folds}
              onClick={() => setUnfolded(!unfolded)}
              type="button"
            >
              <span>{foldLabel}</span>
              {folds ? (
                unfolded ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )
              ) : null}
            </button>
            <span className="ms-auto text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:opacity-100">
              {formatDayAwareTimestamp(turn.startedAt, format, now)}
            </span>
          </div>
        </div>
      ) : null}
      <div className="pt-2">
        {blocks.map((block, index) => {
          // What never folds renders as before; what can fold keeps one wrapper, open or not, so
          // opening the fold keeps the block (and the find's place in it) where it was.
          if (!foldable(block, index)) return renderBlock(block, index);
          const folded = !shownFolded(block, index);
          if (folded && !findOpen) return null;
          return (
            <div
              className={folded ? undefined : "contents"}
              data-thread-find-fold={folded ? "" : undefined}
              hidden={folded}
              key={`foldable-${index}`}
            >
              {renderBlock(block, index)}
            </div>
          );
        })}
      </div>
      {props.footer}
      {turn.state === "failed" ? (
        <div className="pb-4">
          <WorkLine
            icon={
              <CircleAlertIcon
                className={cn("size-4", limited ? "text-warning" : "text-destructive")}
              />
            }
            label={
              <span
                className={cn("text-sm font-medium", limited ? "text-warning" : "text-destructive")}
              >
                {limited
                  ? usageLimitFailureLabel(turn.failure?.resetAt, format, now)
                  : "Turn failed"}
              </span>
            }
          >
            {turn.error === undefined || limited ? null : (
              <p
                className="ms-7 py-1 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground/80"
                role="alert"
              >
                {turn.error}
              </p>
            )}
            {props.latest && props.onRetry !== undefined ? (
              <div className="ms-7 pb-1">
                <Button
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true);
                    void props.onRetry?.().finally(() => setRetrying(false));
                  }}
                  size="xs"
                  variant="outline"
                >
                  <RotateCcwIcon />
                  Retry
                </Button>
              </div>
            ) : null}
          </WorkLine>
        </div>
      ) : null}
      {turn.state === "interrupted" && props.latest ? (
        <SystemDivider detail={turn.error} label="Run interrupted" tone="danger" />
      ) : null}
    </div>
  );
}

/** Every turn of a thread, oldest first. */
export function TimelineView(props: {
  timeline: Timeline;
  format: TimestampFormat;
  /** The thread shown: its messages get the `chat.message.actions` slot. */
  thread?: { target: NodeTarget; threadId: string };
  /** The find bar is open: folded work renders hidden so its text is found (D1351). */
  findOpen?: boolean;
  /** What a user message's file and skill chips do (D1341); without it they only show. */
  fileChips?: MessageFileChips;
  /** Runs a failed turn's message again (D224). */
  onRetry?(turn: TimelineTurn): Promise<unknown>;
  /** The thread's project folder, where "Save to workspace" writes. */
  projectPath?: string;
  onSavePlan?: SavePlan;
  /** Opens another thread of the node: a fork's parent, a fork merged back. */
  onOpenThread?(threadId: string): void;
  /** A thread's title, where the node's catalog knows it. */
  titleOf?(threadId: string): string | undefined;
  /** What goes under a turn's message (the `chat.turn.header` slot). */
  header?: ((turn: TimelineTurn, first: boolean) => ReactNode) | undefined;
  /** What goes under a turn's answer (the `chat.turn.footer` slot). */
  footer?: ((turn: TimelineTurn, latest: boolean) => ReactNode) | undefined;
  /** Events of other plugins in a turn (the `chat.turn.item` slot), with those beside each. */
  extension?:
    | ((
        turn: TimelineTurn,
        event: ExtensionItem["event"],
        adjacent: readonly ExtensionItem["event"][],
      ) => ReactNode)
    | undefined;
}) {
  const { turns, forkedFrom } = props.timeline;
  const now = useNow();
  const running = turns.at(-1)?.state === "running";
  const where = useMemo(
    () => (props.thread === undefined ? undefined : { ...props.thread, running }),
    [props.thread?.target, props.thread?.threadId, running],
  );
  if (turns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }
  return (
    <NowContext.Provider value={now}>
      <FindOpenContext value={props.findOpen === true}>
        <FileChipsContext value={props.fileChips}>
          <MessageActionsContext.Provider value={where}>
            {turns.map((turn, index) => (
              <Fragment key={turn.turnId}>
                {turn.handoff === undefined ? null : (
                  <SystemDivider
                    detail={props.titleOf?.(turn.handoff.threadId)}
                    icon={GitMergeIcon}
                    label="Merged back from fork"
                    {...(props.onOpenThread === undefined
                      ? {}
                      : {
                          actionLabel: "Open fork",
                          onAction: () => props.onOpenThread!(turn.handoff!.threadId),
                        })}
                  />
                )}
                <TurnView
                  format={props.format}
                  latest={index === turns.length - 1}
                  turn={turn}
                  {...(props.projectPath === undefined ? {} : { projectPath: props.projectPath })}
                  {...(props.onSavePlan === undefined ? {} : { onSavePlan: props.onSavePlan })}
                  header={props.header?.(turn, index === 0)}
                  footer={props.footer?.(turn, index === turns.length - 1)}
                  extension={
                    props.extension === undefined
                      ? undefined
                      : (event, adjacent) => props.extension?.(turn, event, adjacent)
                  }
                  {...(props.onRetry === undefined ? {} : { onRetry: () => props.onRetry!(turn) })}
                />
                {forkedFrom?.turnId === turn.turnId ? (
                  <SystemDivider
                    icon={GitForkIcon}
                    label="Forked from conversation"
                    {...(props.onOpenThread === undefined
                      ? {}
                      : {
                          actionLabel: "Open source conversation",
                          onAction: () => props.onOpenThread!(forkedFrom.threadId),
                        })}
                  />
                ) : null}
              </Fragment>
            ))}
          </MessageActionsContext.Provider>
        </FileChipsContext>
      </FindOpenContext>
    </NowContext.Provider>
  );
}
