// The composer's design follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ChatComposer.tsx, ComposerPrimaryActions.tsx,
// ComposerPendingApprovalPanel.tsx, ComposerPendingApprovalActions.tsx,
// ComposerPendingUserInputPanel.tsx, QueuedRunsControl.tsx, ProviderModelPicker.tsx,
// ContextWindowMeter.tsx and runtimeModeConfig.ts. A plain textarea replaces the rich editor.
import type { AgentResponse, TokenUsage, TurnAttachment, UserQuestion } from "@jhin/agent-api";
import type { AgentInfo, ChatComposerContextProps, NodeTarget } from "@jhin/client-api";
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Select,
  SelectItem,
  SelectPopup,
  SelectValue,
  Slot,
  Spinner,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  ListOrderedIcon,
  LockIcon,
  LockOpenIcon,
  PaperclipIcon,
  PenLineIcon,
  PencilRulerIcon,
  SearchIcon,
  ShieldIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import {
  fitAttachments,
  readImage,
  stepPromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryPosition,
} from "../../lib/composer.ts";
import { formatTokens } from "../../lib/format.ts";
import { CHAT_SECTION, ChatSettings, useSection } from "../../lib/settings.ts";
import { isMacPlatform, currentPlatform } from "../../lib/keybindings.ts";
import type { RequestItem } from "../../lib/timeline.ts";
import { ComposerBanner } from "./banner.tsx";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "../../lib/composer-control.tsx";
import type { QueuedMessage, QueuePause } from "./follow-ups.ts";
import { useAgents, useChat } from "./services.ts";
import { ComposerSurface } from "./surface.tsx";

/** What the next turn runs with. */
export interface Selection {
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
}

const RUNTIME_MODES: Record<string, { label: string; description: string; icon: LucideIcon }> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export interface ComposerHandleApi {
  focus(): void;
  toggleModelPicker(): void;
  cycleRuntimeMode(): void;
  togglePlanMode(): void;
}

function SendIcon() {
  return (
    <svg fill="none" height="14" viewBox="0 0 14 14" width="14">
      <path
        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

const SEND_BUTTON =
  "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover";
const STOP_BUTTON =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none sm:h-8 sm:w-8 [&_svg]:pointer-events-none";
const PILL_BUTTON =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action px-4 font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:h-7 sm:text-sm";

const APPROVAL_LABELS: Record<string, string> = {
  command: "Command approval",
  file_read: "File read approval",
  file_change: "File change approval",
};

function ApprovalBanner(props: {
  request: RequestItem;
  count: number;
  onRespond(response: AgentResponse): void;
  busy: boolean;
}) {
  if (props.request.request.kind !== "approval") return null;
  const { tool, reason } = props.request.request;
  const label = APPROVAL_LABELS[tool.kind] ?? "Permission approval";
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
                <span className="min-w-0 truncate">{tool.title}</span>
                {props.count > 1 ? (
                  <span className="ml-auto shrink-0 tabular-nums">1/{props.count}</span>
                ) : null}
              </span>
              <code
                className="block max-h-20 w-full min-w-0 overflow-auto font-mono text-xs whitespace-pre-wrap text-foreground [scrollbar-width:thin]"
                tabIndex={0}
              >
                {tool.detail ?? tool.name}
              </code>
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
                <MenuItem className="mb-1 last:mb-0" onClick={() => decide("accept-for-session")}>
                  Always allow this session
                </MenuItem>
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
function QuestionsBanner(props: {
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
function PlanFollowUpBanner({ planTitle }: { planTitle: string | null }) {
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

function QueueBanner(props: {
  queue: readonly QueuedMessage[];
  /** Why the queue waits for the user, if it does. */
  paused: QueuePause | undefined;
  /** The first message is on its way. */
  sending: boolean;
  onRemove(id: string): void;
  onResume(): void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        aria-label={`${props.queue.length} queued messages`}
        aria-live="polite"
        className="relative z-0"
        role="region"
      >
        <ComposerBanner.Row
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          render={<button type="button" />}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">Queued</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{props.queue.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {props.paused === undefined ? null : (
          <ComposerBanner.Row className="relative">
            <ComposerBanner.Icon />
            <ComposerBanner.Content>
              <span className="min-w-0 flex-1 truncate text-destructive-foreground" role="alert">
                {props.paused.kind === "failed"
                  ? `Not sent: ${props.paused.message}`
                  : `${props.paused.message}: the queue waits`}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <Button onClick={props.onResume} size="xs" variant="outline">
                {props.paused.kind === "failed" ? "Retry" : "Resume"}
              </Button>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        )}
        {expanded ? (
          <ComposerBanner.Scroll className="max-h-32">
            <ComposerBanner.Children render={<ol />}>
              {props.queue.map((message, index) => {
                // The first message on its way can no longer be taken back.
                const sending = props.sending && index === 0;
                return (
                  <ComposerBanner.Row
                    className="relative rounded-sm"
                    key={message.id}
                    render={<li />}
                  >
                    <ComposerBanner.Icon>
                      {sending ? <Spinner aria-label="Sending" size="sm" /> : null}
                    </ComposerBanner.Icon>
                    <ComposerBanner.Content className="text-foreground/80">
                      <span className="min-w-0 flex-1 truncate">
                        {message.text || `${message.attachments.length} image(s)`}
                      </span>
                    </ComposerBanner.Content>
                    <ComposerBanner.Actions>
                      {sending ? null : (
                        <ComposerBanner.Dismiss
                          aria-label="Remove queued message"
                          onClick={() => props.onRemove(message.id)}
                        />
                      )}
                    </ComposerBanner.Actions>
                  </ComposerBanner.Row>
                );
              })}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function ModelPicker(props: {
  agents: readonly AgentInfo[] | undefined;
  selection: Selection;
  onSelect(selection: Selection): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpened(): void;
}) {
  const { agents, selection } = props;
  const [query, setQuery] = useState("");
  const agent =
    agents?.find((candidate) => candidate.agentId === selection.agentId) ??
    agents?.find((candidate) => candidate.default) ??
    agents?.[0];
  const modelId = selection.model ?? agent?.defaultModel ?? agent?.models[0]?.id;
  const model = agent?.models.find((candidate) => candidate.id === modelId);
  const label = model?.name ?? agent?.name ?? "Choose model";
  const normalized = query.trim().toLowerCase();
  const groups = (agents ?? []).map((candidate) => ({
    agent: candidate,
    models: (candidate.models.length > 0
      ? candidate.models
      : [{ id: "", name: candidate.name }]
    ).filter(
      (item) =>
        normalized === "" ||
        item.name.toLowerCase().includes(normalized) ||
        candidate.name.toLowerCase().includes(normalized),
    ),
  }));

  return (
    <Popover
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (open) {
          setQuery("");
          props.onOpened();
        }
      }}
      open={props.open}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  aria-label="Model"
                  className="-ms-2.5 min-w-13 min-w-0 shrink justify-between whitespace-nowrap"
                  data-chat-provider-model-picker
                />
              }
            />
          }
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <BotIcon className="size-4" />
            <span className="min-w-0 flex-1 overflow-hidden truncate">{label}</span>
            {agent !== undefined && !agent.available ? (
              <span className="rounded border border-border px-1 text-3xs text-muted-foreground">
                Unavailable
              </span>
            ) : null}
          </span>
          <span aria-hidden className="flex items-center">
            <ComposerControlChevron />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {agent === undefined ? label : `${agent.name} · ${label}`}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="before:hidden">
        <div
          className="flex max-h-86.5 w-screen max-w-90 flex-col overflow-hidden"
          data-model-picker-content
        >
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
            <SearchIcon className="size-4 shrink-0 text-icon-muted" />
            <input
              aria-label="Search models"
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models..."
              value={query}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {agents === undefined ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <Spinner size="sm" />
                Loading agents…
              </div>
            ) : groups.every((group) => group.models.length === 0) ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No models found</p>
            ) : (
              groups.map(({ agent: candidate, models }) =>
                models.length === 0 ? null : (
                  <div key={candidate.agentId} role="group" aria-label={candidate.name}>
                    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                      <BotIcon className="size-3.5" />
                      {candidate.name}
                      {!candidate.available ? (
                        <span className="ms-auto font-normal text-2xs text-muted-foreground/70">
                          {candidate.message ?? "Unavailable"}
                        </span>
                      ) : null}
                    </div>
                    {models.map((item) => {
                      const active =
                        candidate.agentId === agent?.agentId &&
                        (item.id === "" || item.id === modelId);
                      return (
                        <button
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                            active && "bg-accent/60",
                          )}
                          disabled={!candidate.available}
                          key={`${candidate.agentId}:${item.id}`}
                          onClick={() => {
                            const { model: _model, ...rest } = selection;
                            props.onSelect({
                              ...rest,
                              agentId: candidate.agentId,
                              ...(item.id === "" ? {} : { model: item.id }),
                            });
                            props.onOpenChange(false);
                          }}
                          type="button"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block min-w-0 truncate text-xs font-medium leading-snug">
                              {item.name}
                            </span>
                            {"description" in item && item.description !== undefined ? (
                              <span className="block truncate text-xs text-muted-foreground/70">
                                {item.description}
                              </span>
                            ) : null}
                          </span>
                          {active ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ),
              )
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ContextMeter({ usage }: { usage: TokenUsage }) {
  if (
    usage.contextWindow === undefined ||
    usage.contextTokens === undefined ||
    usage.contextWindow <= 0
  ) {
    return null;
  }
  const percent = Math.min(100, (usage.contextTokens / usage.contextWindow) * 100);
  const label =
    percent < 10 ? `${percent.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(percent)}%`;
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  return (
    <Popover>
      <PopoverTrigger
        delay={150}
        openOnHover
        render={
          <Button
            aria-label={`Context window ${label} used`}
            className="size-7"
            size="icon-sm"
            variant="ghost-muted"
          />
        }
      >
        <span className="relative flex size-5 items-center justify-center">
          <svg
            className="absolute inset-0 mx-0! size-full -rotate-90 transform-gpu"
            viewBox="0 0 24 24"
          >
            <circle
              className="stroke-muted-foreground/24"
              cx="12"
              cy="12"
              fill="none"
              r={radius}
              strokeWidth="3"
            />
            <circle
              className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
              cx="12"
              cy="12"
              fill="none"
              r={radius}
              stroke={
                percent > 90
                  ? "var(--color-error)"
                  : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)"
              }
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - percent / 100)}
              strokeLinecap="round"
              strokeWidth="3"
            />
          </svg>
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end" side="top">
        <div className="flex w-56 flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground text-xs">Context Window</span>
            <span className="text-2xs text-secondary-label tabular-nums">
              {label} · {formatTokens(usage.contextTokens)}/{formatTokens(usage.contextWindow)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
            <div
              className="h-full rounded-full bg-foreground/50"
              style={{ width: `${percent}%` }}
            />
          </div>
          {usage.costUsd === undefined ? null : (
            <span className="text-2xs text-muted-foreground">Cost ${usage.costUsd.toFixed(4)}</span>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export interface ComposerProps {
  readonly target: NodeTarget;
  /** What the strip under the composer (`chat.composer.context`) is about. */
  readonly context?: ChatComposerContextProps;
  /** Where the draft is kept: a thread, or a project for a new thread. */
  readonly draftKey: string;
  readonly selection: Selection;
  onSelectionChange(selection: Selection): void;
  readonly running: boolean;
  /** Open requests of the running turn, oldest first. */
  readonly requests: readonly RequestItem[];
  readonly history: readonly PromptHistoryEntry[];
  readonly usage?: TokenUsage | undefined;
  readonly queue: readonly QueuedMessage[];
  /** Why the queue waits for the user, if it does. */
  readonly queuePaused?: QueuePause | undefined;
  /** The queue's first message is on its way. */
  readonly queueSending?: boolean;
  onDequeue(id: string): void;
  onResumeQueue?(): void;
  /** Why sending is not possible now (a disconnected node), if it is not. */
  readonly unavailable?: string | undefined;
  /** False when sending failed: the draft is restored. */
  onSend(text: string, attachments: readonly TurnAttachment[]): Promise<boolean>;
  onStop(): void;
  /** False when the answer was not delivered: what was typed stays. */
  onRespond(requestId: string, response: AgentResponse): Promise<boolean>;
  readonly handleRef?: Ref<ComposerHandleApi>;
  /**
   * A proposed plan the user can act on (D306): an empty prompt implements it,
   * typed text refines it. False when it was not sent.
   */
  readonly planFollowUp?: {
    readonly title: string | null;
    onImplement(newThread: boolean): Promise<boolean>;
  };
}

export function Composer(props: ComposerProps) {
  const chat = useChat();
  const { drafts, keybindings, toasts } = chat;
  const agents = useAgents(props.target);
  const settings = useSection(chat.context, CHAT_SECTION, ChatSettings);
  const initial = drafts.get(props.draftKey);
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [attachments, setAttachments] = useState<readonly TurnAttachment[]>(
    initial?.attachments ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  /** The question an option was just picked on: the next one shows shortly after. */
  const [picked, setPicked] = useState<number | undefined>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const historyPosition = useRef<PromptHistoryPosition | null>(null);

  useEffect(
    () => drafts.set(props.draftKey, { prompt, attachments }),
    [drafts, props.draftKey, prompt, attachments],
  );

  const agent =
    agents?.find((candidate) => candidate.agentId === props.selection.agentId) ??
    agents?.find((candidate) => candidate.default) ??
    agents?.[0];
  const runtimeModes = agent?.runtimeModes ?? [];
  const runtimeMode = props.selection.runtimeMode ?? "full-access";
  const planSupported = agent?.interactionModes.includes("plan") === true;
  const planMode = props.selection.interactionMode === "plan";
  const approval = props.requests.find((request) => request.request.kind === "approval");
  const question = props.requests.find((request) => request.request.kind === "user-input");
  const questions = question?.request.kind === "user-input" ? question.request.questions : [];
  const mod = isMacPlatform(currentPlatform()) ? "⌘" : "Ctrl+";

  useEffect(() => {
    setAnswers({});
    setQuestionIndex(0);
    setPicked(undefined);
  }, [question?.requestId]);
  useEffect(() => {
    if (picked === undefined) return;
    const timer = setTimeout(() => {
      setPicked(undefined);
      setQuestionIndex((index) => (index === picked ? index + 1 : index));
    }, 200);
    return () => clearTimeout(timer);
  }, [picked]);

  const focus = () => textarea.current?.focus();
  const cycleRuntimeMode = () => {
    if (runtimeModes.length < 2) return;
    const next = runtimeModes[(runtimeModes.indexOf(runtimeMode) + 1) % runtimeModes.length]!;
    props.onSelectionChange({ ...props.selection, runtimeMode: next });
    toasts?.show({
      id: "runtime-mode",
      title: `Access: ${RUNTIME_MODES[next]?.label ?? next}`,
      timeout: 1500,
    });
  };
  const togglePlanMode = () => {
    if (!planSupported) return;
    props.onSelectionChange({ ...props.selection, interactionMode: planMode ? "default" : "plan" });
  };
  useImperativeHandle(props.handleRef, () => ({
    focus,
    toggleModelPicker: () => setPickerOpen((open) => !open),
    cycleRuntimeMode,
    togglePlanMode,
  }));

  // Context keys for shortcuts: whether the composer has focus and a turn runs.
  const [focused, setFocused] = useState(false);
  // A disabled field may lose focus without a blur event.
  useEffect(() => {
    if (approval !== undefined) setFocused(false);
  }, [approval?.requestId]);
  useEffect(() => {
    if (keybindings === undefined || !focused) return;
    const subscription = keybindings.setContext("composerFocus", true);
    return () => subscription.dispose();
  }, [keybindings, focused]);
  useEffect(() => {
    if (keybindings === undefined || !props.running) return;
    const subscription = keybindings.setContext("turnRunning", true);
    return () => subscription.dispose();
  }, [keybindings, props.running]);

  const addFiles = async (files: readonly File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      if (files.length > 0) toasts?.show({ type: "warning", title: "Only images can be attached" });
      return;
    }
    const read = await Promise.allSettled(images.map(readImage));
    const added: TurnAttachment[] = [];
    for (const result of read) {
      if (result.status === "fulfilled") added.push(result.value);
      else
        toasts?.show({
          type: "error",
          title: "Image not attached",
          description: String(result.reason?.message ?? result.reason),
        });
    }
    // What fits in one message (the node takes no more); the state is updated
    // from its latest value, the warning from the one this drop started with.
    const { dropped } = fitAttachments(attachments, added);
    setAttachments((current) => fitAttachments(current, added).kept);
    if (dropped.length > 0) {
      toasts?.show({
        type: "warning",
        title:
          dropped.length === 1
            ? "An image was not attached"
            : `${dropped.length} images were not attached`,
        description: "A message takes up to 10 images, 20 MB together.",
      });
    }
  };

  const hasContent = prompt.trim() !== "" || attachments.length > 0;
  // T3 shows the follow-up only while the composer holds no attachments.
  const planFollowUp =
    question === undefined && approval === undefined && attachments.length === 0
      ? props.planFollowUp
      : undefined;
  const implement = async (newThread: boolean) => {
    if (planFollowUp === undefined || busy || props.unavailable !== undefined) return;
    setBusy(true);
    try {
      await planFollowUp.onImplement(newThread);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (busy || props.unavailable !== undefined || approval !== undefined) return;
    if (question !== undefined) {
      await submitAnswers();
      return;
    }
    if (planFollowUp !== undefined && !hasContent) {
      await implement(false);
      return;
    }
    if (!hasContent) return;
    const text = prompt;
    const images = attachments;
    // Cleared first, restored if sending fails (as T3 Code does).
    setPrompt("");
    setAttachments([]);
    historyPosition.current = null;
    setBusy(true);
    try {
      const sent = await props.onSend(text, images);
      if (!sent) {
        setPrompt(text);
        setAttachments(images);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleAnswer = (questionId: string, label: string, multi: boolean) => {
    setAnswers((current) => {
      const chosen = current[questionId] ?? [];
      const next = multi
        ? chosen.includes(label)
          ? chosen.filter((item) => item !== label)
          : [...chosen, label]
        : [label];
      return { ...current, [questionId]: next };
    });
    if (!multi && questionIndex < questions.length - 1) setPicked(questionIndex);
  };
  const currentQuestion = questions[questionIndex];
  const custom = prompt.trim();
  /** A question's answer with the typed one: added to a multi-select's options, else instead. */
  const withCustom = (item: UserQuestion): readonly string[] => {
    const chosen = answers[item.id] ?? [];
    if (item.id !== currentQuestion?.id || custom === "") return chosen;
    if (item.multiSelect !== true) return [custom];
    return chosen.includes(custom) ? chosen : [...chosen, custom];
  };
  const canAdvance =
    currentQuestion !== undefined &&
    (custom !== "" || (answers[currentQuestion.id] ?? []).length > 0);
  const submitAnswers = async () => {
    if (question === undefined || currentQuestion === undefined || !canAdvance) return;
    if (questionIndex < questions.length - 1) {
      if (custom !== "") {
        setAnswers((current) => ({
          ...current,
          [currentQuestion.id]: withCustom(currentQuestion),
        }));
        setPrompt("");
      }
      setQuestionIndex(questionIndex + 1);
      return;
    }
    const final: Record<string, string | readonly string[]> = {};
    for (const item of questions) {
      const chosen = withCustom(item);
      final[item.id] = item.multiSelect === true ? chosen : (chosen[0] ?? "");
    }
    setBusy(true);
    try {
      const answered = await props.onRespond(question.requestId, {
        kind: "user-input",
        answers: final,
      });
      if (answered) setPrompt("");
    } finally {
      setBusy(false);
    }
  };

  // Number keys pick an option while the questions show and focus is not in a field.
  useEffect(() => {
    if (currentQuestion === undefined) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      const index = Number(event.key) - 1;
      const option = currentQuestion.options[index];
      if (!Number.isInteger(index) || option === undefined) return;
      event.preventDefault();
      toggleAnswer(currentQuestion.id, option.label, currentQuestion.multiSelect === true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Tab" && event.shiftKey && planSupported) {
      event.preventDefault();
      togglePlanMode();
      return;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      attachments.length === 0 &&
      props.requests.length === 0
    ) {
      const element = event.currentTarget;
      const atStart =
        element.selectionStart === 0 ||
        !element.value.slice(0, element.selectionStart).includes("\n");
      const atEnd = !element.value.slice(element.selectionEnd).includes("\n");
      if ((event.key === "ArrowUp" && atStart) || (event.key === "ArrowDown" && atEnd)) {
        const step = stepPromptHistory({
          direction: event.key === "ArrowUp" ? "backward" : "forward",
          entries: props.history,
          position: historyPosition.current,
          currentPrompt: prompt,
        });
        if (step !== null) {
          event.preventDefault();
          historyPosition.current = step.position;
          setPrompt(step.prompt);
          requestAnimationFrame(() => {
            const length = textarea.current?.value.length ?? 0;
            textarea.current?.setSelectionRange(length, length);
          });
        }
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    if (settings.sendShortcut === "mod-enter" && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    void send();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    if (
      files.some((file) => file.type.startsWith("image/")) ||
      event.clipboardData.getData("text") === ""
    ) {
      event.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const placeholder =
    approval !== undefined
      ? "Resolve this approval request to continue"
      : question !== undefined
        ? "Type your own answer, or leave this blank to use the selected option"
        : props.unavailable !== undefined
          ? props.unavailable
          : "Ask anything, or attach images";
  const disabled = approval !== undefined;
  const mode = RUNTIME_MODES[runtimeMode] ?? RUNTIME_MODES["full-access"]!;

  return (
    <div className="relative z-10">
      <ComposerSurface.Shell>
        {approval !== undefined ? (
          <ApprovalBanner
            busy={busy}
            count={props.requests.filter((request) => request.request.kind === "approval").length}
            onRespond={(response) => {
              setBusy(true);
              void props.onRespond(approval.requestId, response).finally(() => setBusy(false));
            }}
            request={approval}
          />
        ) : question !== undefined ? (
          <QuestionsBanner
            index={questionIndex}
            onToggle={toggleAnswer}
            questions={questions}
            selected={answers}
          />
        ) : props.queue.length > 0 ? (
          <QueueBanner
            onRemove={props.onDequeue}
            onResume={() => props.onResumeQueue?.()}
            paused={props.queuePaused}
            queue={props.queue}
            sending={props.queueSending === true}
          />
        ) : planFollowUp !== undefined ? (
          <PlanFollowUpBanner planTitle={planFollowUp.title} />
        ) : null}
        <ComposerSurface.Host>
          <div className="relative z-10">
            <form
              aria-label="Composer"
              className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
              data-chat-composer-form="true"
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes("Files")) {
                  event.preventDefault();
                  setDragging(true);
                }
              }}
              onDrop={onDrop}
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <ComposerSurface.Main>
                <div
                  className={cn(
                    "rounded-3xl transition-[background-color] duration-200",
                    dragging && "bg-accent/45 ring-1 ring-inset ring-primary/70",
                  )}
                  data-chat-composer-surface
                >
                  <div
                    className={cn(
                      "relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4",
                      approval !== undefined && "pb-3 sm:pb-4",
                    )}
                  >
                    {attachments.length > 0 ? (
                      <div className="mb-3 flex max-w-full flex-wrap gap-2">
                        {attachments.map((attachment, index) => (
                          <div
                            className="group/attachment relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-background"
                            key={`${attachment.name}-${index}`}
                          >
                            <img
                              alt={attachment.name}
                              className="h-full w-full object-cover"
                              src={attachment.dataUrl}
                            />
                            <span className="absolute top-1 right-1 flex">
                              <Button
                                aria-label={`Remove ${attachment.name}`}
                                onClick={() =>
                                  setAttachments((current) => current.filter((_, i) => i !== index))
                                }
                                size="icon-xs"
                                variant="media-close"
                              >
                                <XIcon />
                              </Button>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="relative flow-root text-sm max-sm:pointer-coarse:text-[16px]">
                      <textarea
                        aria-label="Message"
                        className={cn(
                          "-m-1 block max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1 leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground outline-none placeholder:text-placeholder/75 [field-sizing:content]",
                          approval !== undefined && "min-h-10",
                        )}
                        disabled={disabled}
                        onBlur={() => setFocused(false)}
                        readOnly={busy && question === undefined}
                        onChange={(event) => {
                          setPrompt(event.target.value);
                        }}
                        onFocus={() => setFocused(true)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        placeholder={placeholder}
                        ref={textarea}
                        rows={3}
                        value={approval !== undefined ? "" : prompt}
                      />
                    </div>
                  </div>
                  {approval === undefined ? (
                    <div
                      className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
                      data-chat-composer-footer
                    >
                      <div
                        className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        data-chat-composer-controls="left"
                      >
                        <ModelPicker
                          agents={agents}
                          onOpenChange={setPickerOpen}
                          onOpened={() => chat.agents.refresh(props.target)}
                          onSelect={props.onSelectionChange}
                          open={pickerOpen}
                          selection={props.selection}
                        />
                        {runtimeModes.length > 1 ? (
                          <>
                            <ComposerControlSeparator />
                            <Tooltip>
                              <Select
                                onValueChange={(value) =>
                                  props.onSelectionChange({
                                    ...props.selection,
                                    runtimeMode: String(value),
                                  })
                                }
                                value={runtimeMode}
                              >
                                <TooltipTrigger
                                  render={<ComposerSelectControl aria-label="Runtime mode" />}
                                >
                                  <ComposerControlIcon icon={mode.icon} />
                                  <SelectValue>{mode.label}</SelectValue>
                                </TooltipTrigger>
                                <SelectPopup alignItemWithTrigger={false}>
                                  {runtimeModes.map((value) => {
                                    const option = RUNTIME_MODES[value];
                                    if (option === undefined) return null;
                                    const OptionIcon = option.icon;
                                    return (
                                      <SelectItem
                                        className="min-w-64"
                                        hideIndicator
                                        key={value}
                                        value={value}
                                      >
                                        <div className="flex min-w-0 items-center gap-3">
                                          <div className="grid min-w-0 flex-1 gap-0.5">
                                            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                                              <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                              {option.label}
                                            </span>
                                            <span className="text-muted-foreground text-xs leading-4">
                                              {option.description}
                                            </span>
                                          </div>
                                        </div>
                                      </SelectItem>
                                    );
                                  })}
                                </SelectPopup>
                              </Select>
                              <TooltipPopup side="top">{mode.description}</TooltipPopup>
                            </Tooltip>
                          </>
                        ) : null}
                        {planSupported ? (
                          <>
                            <ComposerControlSeparator />
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <ComposerControl
                                    aria-label={planMode ? "Plan mode" : "Build mode"}
                                    aria-pressed={planMode}
                                    className="shrink-0 whitespace-nowrap"
                                    onClick={togglePlanMode}
                                  />
                                }
                              >
                                {planMode ? (
                                  <ComposerControlIcon
                                    className="text-current opacity-100"
                                    icon={PencilRulerIcon}
                                  />
                                ) : (
                                  <ComposerControlIcon icon={BotIcon} opticalSize="large" />
                                )}
                                <span
                                  className="sr-only sm:not-sr-only"
                                  data-composer-control-label
                                >
                                  {planMode ? "Plan" : "Build"}
                                </span>
                              </TooltipTrigger>
                              <TooltipPopup side="top">
                                {planMode
                                  ? "Plan mode — click to return to normal build mode"
                                  : "Default mode — click to enter plan mode"}
                              </TooltipPopup>
                            </Tooltip>
                          </>
                        ) : null}
                      </div>
                      <div
                        className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                        data-chat-composer-actions="right"
                      >
                        <input
                          accept="image/png,image/jpeg,image/gif,image/webp"
                          className="hidden"
                          multiple
                          onChange={(event) => {
                            void addFiles(Array.from(event.target.files ?? []));
                            event.target.value = "";
                          }}
                          ref={fileInput}
                          type="file"
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                aria-label="Attach images"
                                onClick={() => fileInput.current?.click()}
                                onPointerDown={(event) => event.preventDefault()}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              />
                            }
                          >
                            <PaperclipIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Attach images</TooltipPopup>
                        </Tooltip>
                        {props.usage === undefined ? null : <ContextMeter usage={props.usage} />}
                        {question !== undefined ? (
                          <button
                            className={PILL_BUTTON}
                            disabled={!canAdvance || busy}
                            type="submit"
                          >
                            {busy
                              ? "Submitting..."
                              : questionIndex < questions.length - 1
                                ? "Next question"
                                : questions.length > 1
                                  ? "Submit answers"
                                  : "Submit answer"}
                          </button>
                        ) : planFollowUp !== undefined && !props.running ? (
                          hasContent ? (
                            <button
                              className={PILL_BUTTON}
                              disabled={busy || props.unavailable !== undefined}
                              type="submit"
                            >
                              {busy ? "Sending..." : "Refine"}
                            </button>
                          ) : (
                            <div
                              className="flex items-center justify-end"
                              data-chat-composer-implement-actions="true"
                            >
                              <button
                                className={cn(PILL_BUTTON, "rounded-r-none")}
                                disabled={busy || props.unavailable !== undefined}
                                type="submit"
                              >
                                {busy ? "Sending..." : "Implement"}
                              </button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <button
                                      aria-label="Implementation actions"
                                      className={cn(
                                        PILL_BUTTON,
                                        "rounded-l-none border-l border-message-action-foreground/20 px-2",
                                      )}
                                      disabled={busy || props.unavailable !== undefined}
                                      type="button"
                                    />
                                  }
                                >
                                  <ChevronDownIcon className="size-3.5" />
                                </MenuTrigger>
                                <MenuPopup align="end" side="top">
                                  <MenuItem
                                    disabled={busy || props.unavailable !== undefined}
                                    onClick={() => void implement(true)}
                                  >
                                    Implement in a new thread
                                  </MenuItem>
                                </MenuPopup>
                              </Menu>
                            </div>
                          )
                        ) : props.running && !hasContent ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  aria-label="Stop generation"
                                  className={STOP_BUTTON}
                                  onClick={props.onStop}
                                  type="button"
                                />
                              }
                            >
                              <svg fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
                                <rect height="8" rx="1.5" width="8" x="2" y="2" />
                              </svg>
                            </TooltipTrigger>
                            <TooltipPopup side="top">Interrupt</TooltipPopup>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex" />}>
                              <button
                                aria-label={props.running ? "Queue message" : "Send message"}
                                className={SEND_BUTTON}
                                disabled={busy || !hasContent || props.unavailable !== undefined}
                                type="submit"
                              >
                                {busy ? (
                                  <Spinner size="sm" />
                                ) : props.running ? (
                                  <ListOrderedIcon className="size-4" />
                                ) : (
                                  <SendIcon />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              {props.unavailable ??
                                (props.running
                                  ? "Queue message: it is sent when this turn ends"
                                  : `Send (${settings.sendShortcut === "mod-enter" ? `${mod}Enter` : "Enter"})`)}
                            </TooltipPopup>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </ComposerSurface.Main>
            </form>
          </div>
        </ComposerSurface.Host>
        {props.context === undefined ? null : (
          <ComposerSurface.ContextStrip className="text-xs font-normal text-muted-foreground/70">
            <Slot name="chat.composer.context" props={props.context} />
          </ComposerSurface.ContextStrip>
        )}
      </ComposerSurface.Shell>
      <div
        aria-hidden
        className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
      />
    </div>
  );
}
