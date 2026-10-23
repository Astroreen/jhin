// The composer's design follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ChatComposer.tsx, ComposerPrimaryActions.tsx, ProviderModelPicker.tsx,
// ContextWindowMeter.tsx and runtimeModeConfig.ts. The prompt is T3's tiptap editor (prompt-editor.tsx).
import {
  applicableModelOptions,
  referencedContext,
  serializeAssistantCitation,
} from "@jhin/agent-api";
import type {
  AgentGoal,
  AgentResponse,
  AgentUsageLimits,
  AssistantCitation,
  MessageContext,
  MessageContextRecord,
  ModelOptionDescriptor,
  ModelOptionSelection,
  TokenUsage,
  TurnAttachment,
  UserQuestion,
} from "@jhin/agent-api";
import type { AgentInfo, ChatComposerContextProps, NodeTarget } from "@jhin/client-api";
import {
  Badge,
  Button,
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
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
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ListOrderedIcon,
  LockIcon,
  LockOpenIcon,
  PaperclipIcon,
  PenLineIcon,
  PencilRulerIcon,
  SearchIcon,
  CornerUpRightIcon,
  PlayIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from "react";

import {
  appendToDraft,
  nodeDraftKey,
  stepPromptHistory,
  type ComposerDraft,
  type PromptHistoryEntry,
  type PromptHistoryPosition,
} from "../../lib/composer.ts";
import {
  consumeArmedPasteAsText,
  formatAttachmentSize,
  isPasteAsTextShortcut,
  pastedTextDisposition,
  pastedTextFile,
  shouldHandleAttachmentPaste,
} from "../../lib/attachment-files.ts";
import {
  composerSuggestionOptionId,
  menuContextRecord,
  menuInsertion,
  type ComposerMenuItem,
} from "../../lib/composer-menu.ts";
import {
  detectComposerTrigger,
  parseStandaloneComposerSlashCommand,
  serializeComposerFileLink,
} from "../../lib/composer-trigger.ts";
import { formatTokens } from "../../lib/format.ts";
import { isUsageLimitsCommand } from "../../lib/usage-limits.ts";
import { useCatalog } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import {
  currentOptionValue,
  selectedTraits,
  traitSelectChange,
  traitsTriggerLabel,
  withOptionValue,
} from "../../lib/model-options.ts";
import {
  CHAT_SECTION,
  ChatSettings,
  readSection,
  SYNC_SECTION,
  SyncSettings,
  useSection,
} from "../../lib/settings.ts";
import { isMacPlatform, currentPlatform } from "../../lib/keybindings.ts";
import type { RequestItem, ThreadQueue } from "../../lib/timeline.ts";
import type { PromptEditorHandle } from "./prompt-editor.tsx";

/** tiptap loads with the first composer, not with the page (D440's entry budget). */
const PromptEditor = lazy(() =>
  import("./prompt-editor.tsx").then((module) => ({ default: module.PromptEditor })),
);
import { useComposerMenu } from "./use-composer-menu.ts";
import { type PutAside, usePutAside } from "./put-aside.ts";
import {
  contextRemovalRanges,
  knownRecordsById,
  planContextInsertion,
  withContexts,
} from "../../lib/composer-context.ts";
import { ComposerChipsContext, useComposerChipActions } from "./composer-chips.tsx";
import { useAttachmentLoader } from "./attachment-media.tsx";
import {
  ComposerAttachments,
  attachmentItems,
  draftAttachments,
  useComposerAttachments,
  type ComposerAttachment,
} from "./composer-attachments.tsx";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "../../lib/composer-control.tsx";
import { dispatchMode } from "./send.ts";
import { type ContextInsertion, useAgents, useChat } from "./services.ts";
import { ComposerSurface } from "./surface.tsx";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import type { LimitRecoveryState } from "./composer-banners.tsx";

/**
 * What shows above the composer only on occasion is a chunk of its own (D440,
 * D1041), fetched once the first composer is up. Until it is in, the place
 * stays empty; if it fails, a request or the queue says so with "Try again",
 * and a trigger's menu stays out (its keys still pick from it).
 */
const bannersChunk = () => import("./composer-banners.tsx");
const quiet = { loading: () => null, failed: () => null };
const said = (what: string) => ({
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load {what}.</ChunkFailed>
  ),
});
const CommandMenuBanner = lazyChunk(
  () => bannersChunk().then((module) => module.CommandMenuBanner),
  quiet,
);
const ApprovalBanner = lazyChunk(
  () => bannersChunk().then((module) => module.ApprovalBanner),
  said("this approval"),
);
const QuestionsBanner = lazyChunk(
  () => bannersChunk().then((module) => module.QuestionsBanner),
  said("these questions"),
);
const QueueBanner = lazyChunk(
  () => bannersChunk().then((module) => module.QueueBanner),
  said("the queue"),
);
const PlanFollowUpBanner = lazyChunk(
  () => bannersChunk().then((module) => module.PlanFollowUpBanner),
  quiet,
);
const GoalBanner = lazyChunk(() => bannersChunk().then((module) => module.GoalBanner), quiet);
const LimitRecoveryBanner = lazyChunk(
  () => bannersChunk().then((module) => module.LimitRecoveryBanner),
  quiet,
);
const UsageLimitsBanner = lazyChunk(
  () => bannersChunk().then((module) => module.UsageLimitsBanner),
  said("the usage limits"),
);

/** What the next turn runs with. */
export interface Selection {
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  /** Values chosen for the model's options (D297). */
  readonly modelOptions?: readonly ModelOptionSelection[];
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
  /** Puts a sent message back after what is typed. */
  restore(draft: ComposerDraft): void;
  /** What is typed and attached now. */
  draft(): ComposerDraft;
  focus(): void;
  /** Puts text at the cursor (after the prompt when the field is not focused), then focuses. */
  insert(text: string): void;
  /**
   * Puts a context record beside the prompt and its reference at the cursor (T3's
   * addTerminalContext, D1009), or why it cannot.
   */
  insertContext(record: MessageContextRecord): ContextInsertion;
  /**
   * Takes a record's chips out of the prompt, and the record with them (T3's
   * removeReviewComment, D1286); false when the prompt names no such record.
   */
  removeContext(contextId: string): boolean;
  /** Puts a quote of an agent's message at the cursor as its chip (T3's onCite, D1012). */
  insertCitation(citation: AssistantCitation): ContextInsertion;
  toggleModelPicker(): void;
  cycleRuntimeMode(): void;
  togglePlanMode(): void;
  /** Sends the message the other way while a turn runs: queued instead of steered, or back. */
  sendAlternate(): Promise<boolean>;
  /** Steers the first queued message into the running turn; false when it cannot. */
  steerNext(): boolean;
  /** Edits the last queued message in the composer; false when it cannot (T3's editLatest). */
  editLatest(): boolean;
  /** Resumes a stopped turn or a held queue (D800); false when there is nothing to resume. */
  resume(): boolean;
}

/** What can be done to the thread's queue on its node (D201–D205); true when it was done. */
export interface QueueActions {
  remove(messageId: string): Promise<boolean>;
  resume(): Promise<boolean>;
  steer(messageId: string): Promise<boolean>;
  /** Moves a message before another one, or to the end (`null`). */
  reorder(messageId: string, beforeMessageId: string | null): Promise<boolean>;
  edit(
    messageId: string,
    text: string,
    attachments: readonly TurnAttachment[],
    context?: MessageContext,
  ): Promise<boolean>;
  /** A queued message with its images and context records, for editing. */
  load(messageId: string): Promise<
    | {
        text: string;
        attachments: readonly TurnAttachment[];
        context?: MessageContext | undefined;
      }
    | undefined
  >;
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

function ModelPicker(props: {
  agents: readonly AgentInfo[] | undefined;
  selection: Selection;
  /** The options last chosen for a model on this device. */
  remembered(agentId: string, model: string): readonly ModelOptionSelection[] | undefined;
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
                            const { model: _model, modelOptions: _options, ...rest } = selection;
                            const remembered =
                              item.id === ""
                                ? undefined
                                : props.remembered(candidate.agentId, item.id);
                            props.onSelect({
                              ...rest,
                              agentId: candidate.agentId,
                              ...(item.id === "" ? {} : { model: item.id }),
                              ...(remembered === undefined ? {} : { modelOptions: remembered }),
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

/** T3's TraitsPicker: the chosen model's options (D299), after the model picker. */
function TraitsPicker(props: {
  descriptors: readonly ModelOptionDescriptor[];
  selections: readonly ModelOptionSelection[] | undefined;
  prompt: string;
  onPromptChange(prompt: string): void;
  onChange(selections: ModelOptionSelection[]): void;
}) {
  const { descriptors, selections, prompt } = props;
  const [open, setOpen] = useState(false);
  if (descriptors.length === 0) return null;
  const {
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  } = selectedTraits(descriptors, prompt);
  const label = traitsTriggerLabel(descriptors, selections, prompt);
  return (
    <Menu onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  aria-label={label}
                  className="shrink-0 whitespace-nowrap"
                  data-composer-shortcut="composer.effort"
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={BrainIcon} />
          <span data-composer-control-label>{label}</span>
          <ComposerControlChevron />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start">
        {selectDescriptors.map((descriptor, index) => {
          const primary = descriptor.id === primarySelectDescriptor?.id;
          const value =
            ultrathinkPromptControlled && primary
              ? "ultrathink"
              : String(currentOptionValue(descriptor, selections) ?? "");
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                {ultrathinkInBodyText && primary ? (
                  <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                    Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change
                    this option.
                  </div>
                ) : null}
                <MenuRadioGroup
                  onValueChange={(next) => {
                    const change = traitSelectChange(
                      descriptors,
                      selections,
                      descriptor,
                      prompt,
                      String(next),
                    );
                    if (change === null) return;
                    if (change.prompt !== prompt) props.onPromptChange(change.prompt);
                    if (change.modelOptions !== undefined) props.onChange(change.modelOptions);
                  }}
                  value={value}
                >
                  {descriptor.options.map((option) => (
                    <MenuRadioItem
                      closeOnClick
                      disabled={ultrathinkInBodyText && primary}
                      hideIndicator
                      key={option.id}
                      value={option.id}
                    >
                      <span className="flex w-full min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="min-w-0 truncate">{option.label}</span>
                          {option.isDefault ? (
                            <Badge className="min-w-0" size="sm" variant="outline">
                              Default
                            </Badge>
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </div>
          );
        })}
        {booleanDescriptors.map((descriptor, index) => (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuSeparator /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                onValueChange={(next) =>
                  props.onChange(
                    withOptionValue(descriptors, selections, descriptor.id, next === "on"),
                  )
                }
                value={currentOptionValue(descriptor, selections) === true ? "on" : "off"}
              >
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem closeOnClick hideIndicator key={value} value={value}>
                    <span>{value === "on" ? "On" : "Off"}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        ))}
      </MenuPopup>
    </Menu>
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
  /** The thread's queue on its node (D201); absent for a thread not created yet. */
  readonly queue?: ThreadQueue | undefined;
  readonly queueActions?: QueueActions;
  /** The running turn takes steers (D204). */
  readonly canSteer?: boolean;
  /** Why sending is not possible now (a disconnected node), if it is not. */
  readonly unavailable?: string | undefined;
  /**
   * False when sending failed: the draft is restored. `alternate` sends it the
   * other way than the "Follow-up behavior" setting while a turn runs.
   */
  onSend(
    text: string,
    attachments: readonly TurnAttachment[],
    alternate?: boolean,
    /** The context records the text names (D1006). */
    context?: MessageContext,
  ): Promise<boolean>;
  onStop(): void;
  /** The thread's goal (Codex's `/goal`, providers.md D1150), shown above the composer. */
  readonly goal?: AgentGoal | undefined;
  /**
   * Present when the thread can be resumed (D800): its latest turn was
   * stopped, or its queue is held. An empty composer offers "Resume thread".
   */
  onResume?: (() => Promise<void>) | undefined;
  /** The latest turn stopped on a usage limit: T3's recovery banner (t3-parity.md D1312). */
  limitRecovery?: LimitRecoveryState | undefined;
  /** False when the answer was not delivered: what was typed stays. */
  onRespond(requestId: string, response: AgentResponse): Promise<boolean>;
  readonly handleRef?: Ref<ComposerHandleApi>;
  /**
   * A new thread's composer: a model without chosen options starts with the
   * ones last chosen for it on this device (D299, T3's sticky options).
   */
  readonly seedModelOptions?: boolean;
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
  // Fetched after the first paint, so a banner or a trigger's menu rarely waits for it.
  useEffect(() => void bannersChunk().catch(() => undefined), []);
  const initial = drafts.get(props.draftKey);
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  /** The context records picks put beside the prompt (D1006), which its references name. */
  const [contexts, setContexts] = useState<readonly MessageContextRecord[]>(
    initial?.contexts ?? [],
  );
  /** The records as the latest render or insert left them, for inserts between renders. */
  const contextsNow = useRef(contexts);
  contextsNow.current = contexts;
  /** Where the caret is in the prompt (a markdown string): the menus read the trigger there. */
  const [cursor, setCursor] = useState(prompt.length);
  const uploads = useComposerAttachments({
    call: (method, params) => chat.threads.call(props.target, method, params),
    toasts,
    initial: initial?.attachments,
  });
  const attachments = uploads.items;
  const attachmentLoader = useAttachmentLoader(props.target);
  /** Ctrl/⌘+Shift+V was pressed: the next paste stays text, however large (T3). */
  const pasteAsText = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  /** The question an option was just picked on: the next one shows shortly after. */
  const [picked, setPicked] = useState<number | undefined>();
  const editor = useRef<PromptEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const historyPosition = useRef<PromptHistoryPosition | null>(null);

  /**
   * The queued message the composer edits (D210), with the draft it put
   * aside: saving or cancelling brings the draft back.
   */
  const [editing, setEditing] = useState<
    | {
        readonly id: string;
        readonly draft: {
          prompt: string;
          attachments: readonly ComposerAttachment[];
          contexts: readonly MessageContextRecord[];
        };
      }
    | undefined
  >();

  /** Whether the user is in the composer: another device's text never replaces what is typed. */
  const typingHere = useRef(false);
  /** Set once the questions are known, further down: a remote draft may come before. */
  const putAsideNow = useRef<PutAside | undefined>(undefined);
  // Another device's text for this draft (D486): read from the node when the
  // composer opens, and taken while the composer is not in use.
  useEffect(() => {
    const key = props.draftKey;
    const stop = drafts.follow(key, (draft) => {
      if (typingHere.current || editing !== undefined) return;
      // While a prefilled answer shows, the draft that arrives is the one kept aside.
      if (putAsideNow.current?.takeRemote(draft.prompt) !== true) setPrompt(draft.prompt);
    });
    const node = nodeDraftKey(key);
    if (node !== undefined && readSection(chat.context, SYNC_SECTION, SyncSettings).drafts) {
      void chat.threads
        .call<{ prompt: string; at: number } | null>(node.target, "threads.draft.get", {
          key: node.key,
        })
        .then((kept) => {
          if (kept !== null) drafts.take(key, kept.prompt, kept.at);
        })
        // An older node keeps no drafts: this device's stays.
        .catch(() => undefined);
    }
    return stop;
  }, [drafts, props.draftKey, editing]);

  const queued = props.queue?.messages ?? [];
  /** The queue as the latest render had it, for checks after an await. */
  const queuedNow = useRef(queued);
  queuedNow.current = queued;
  // Sent or removed meanwhile: what was typed stays, as a new message.
  const editedGone = editing !== undefined && !queued.some((item) => item.id === editing.id);
  // Runs when the edited message disappears (false → true); `editing` is read
  // as it is at that moment, which is the edit that lost its message.
  useEffect(() => {
    if (!editedGone || editing === undefined) return;
    // What was typed stays, as a new message, and the draft set aside comes
    // back after it, so neither is lost.
    const { draft } = editing;
    if (draft.prompt.trim() !== "" || draft.attachments.length > 0) {
      setPrompt((typed) => (draft.prompt.trim() === "" ? typed : `${typed}\n\n${draft.prompt}`));
      uploads.replace([...uploads.items, ...draft.attachments]);
      setContexts((current) => withContexts(current, draft.contexts));
    }
    setEditing(undefined);
  }, [editedGone]);

  // The draft as typed now, for an edit that starts after a network call: what
  // is typed while the queued message loads is what comes back after the edit.
  const typedNow = useRef({ prompt, attachments, contexts });
  typedNow.current = { prompt, attachments, contexts };
  /** An edit or a steer from a shortcut is on its way: one at a time. */
  const queueBusy = useRef(false);
  const startEdit = async (messageId: string) => {
    if (props.queueActions === undefined || editing !== undefined || queueBusy.current) return;
    queueBusy.current = true;
    try {
      const message = await props.queueActions.load(messageId);
      // Sent or removed while it loaded: there is nothing left to edit.
      if (message === undefined || !queuedNow.current.some((item) => item.id === messageId)) {
        return;
      }
      setEditing({ id: messageId, draft: typedNow.current });
      setPrompt(message.text);
      uploads.replace(attachmentItems(message.attachments));
      setContexts(message.context?.records ?? []);
      editor.current?.focus();
    } finally {
      queueBusy.current = false;
    }
  };
  const cancelEdit = () => {
    if (editing === undefined) return;
    setPrompt(editing.draft.prompt);
    uploads.replace(editing.draft.attachments);
    setContexts(editing.draft.contexts);
    setEditing(undefined);
  };

  const agent =
    agents?.find((candidate) => candidate.agentId === props.selection.agentId) ??
    agents?.find((candidate) => candidate.default) ??
    agents?.[0];
  const runtimeModes = agent?.runtimeModes ?? [];
  const modelId = props.selection.model ?? agent?.defaultModel ?? agent?.models[0]?.id;
  const modelOptions = agent?.models.find((model) => model.id === modelId)?.options ?? [];
  const agentId = agent?.agentId;
  useEffect(() => {
    if (props.seedModelOptions !== true || props.selection.modelOptions !== undefined) return;
    if (agentId === undefined || modelId === undefined) return;
    // Only what the model still declares; the selection is this render's, so a
    // change that landed with the model's is kept.
    const remembered = applicableModelOptions(
      agent?.models.find((model) => model.id === modelId)?.options,
      chat.modelOptions.get(agentId, modelId),
    );
    if (remembered.length > 0) {
      props.onSelectionChange({ ...props.selection, modelOptions: remembered });
    }
  }, [agentId, modelId, props.seedModelOptions, props.selection]);
  // `/usage-limits` (D1144): the agent's limits as read when it was sent. Only the open moment
  // is kept, for the thread and agent it was opened on; a new turn spends quota and closes it.
  const [usagePanel, setUsagePanel] = useState<{
    key: string;
    agentName: string;
    limits: AgentUsageLimits;
    now: number;
  }>();
  const usageKey = `${props.context?.thread?.id ?? ""}|${agentId ?? ""}`;
  if (usagePanel !== undefined && usagePanel.key !== usageKey) setUsagePanel(undefined);
  useEffect(() => {
    if (props.running) setUsagePanel(undefined);
  }, [props.running]);
  /** Opens the banner; false when there is nothing to show (the prompt then stays). */
  const openUsageLimits = async (key: string, offered: AgentInfo): Promise<boolean> => {
    let usageLimits: AgentUsageLimits | null;
    try {
      ({ usageLimits } = await chat.threads.call<{ usageLimits: AgentUsageLimits | null }>(
        props.target,
        "agents.usage-limits",
        { agentId: offered.agentId },
      ));
    } catch (error) {
      toasts?.show({
        type: "error",
        title: "Could not read usage limits",
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (usageLimits === null) {
      setUsagePanel(undefined);
      toasts?.show({ type: "info", title: "Usage limits are unavailable for this provider" });
      return false;
    }
    setUsagePanel({ key, agentName: offered.name, limits: usageLimits, now: Date.now() });
    return true;
  };
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

  const focus = () => editor.current?.focus();
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
  /** Puts text into the prompt (Add to chat): at the caret while the editor has focus, else at the end. */
  const insert = (text: string) => {
    // A prefilled answer is taken as typed: Add to chat leaves it alone, as T3's does.
    if (literalAnswer) return;
    const at = focused ? Math.min(cursor, prompt.length) : prompt.length;
    const before = prompt.slice(0, at);
    const gap = before.length > 0 && !/\s$/.test(before) ? "\n\n" : "";
    editor.current?.replaceRange(at, at, `${gap}${text}`);
    editor.current?.focus();
  };
  const insertContext = (record: MessageContextRecord): ContextInsertion => {
    if (literalAnswer || approval !== undefined) return "not-now";
    // What the editor and the records hold now: two inserts in one tick see each other's.
    const plan = planContextInsertion({
      prompt: editor.current?.value() ?? prompt,
      caret: focused ? (editor.current?.cursor() ?? cursor) : undefined,
      records: contextsNow.current,
      record,
    });
    if (plan.kind === "full") return "full";
    contextsNow.current = plan.records;
    setContexts(plan.records);
    editor.current?.replaceRange(plan.at, plan.at, plan.text);
    editor.current?.focus();
    return "inserted";
  };
  const removeContext = (contextId: string): boolean => {
    // Without the editor the chips cannot go, so neither does the record.
    const prompted = editor.current;
    if (prompted === undefined || prompted === null) return false;
    const ranges = contextRemovalRanges(prompted.value(), contextId);
    if (ranges.length === 0) return false;
    for (const { start, end } of ranges) prompted.replaceRange(start, end, "");
    // An editor not ready yet edits nothing: the record stays with its chips.
    if (contextRemovalRanges(prompted.value(), contextId).length > 0) return false;
    contextsNow.current = contextsNow.current.filter((record) => record.contextId !== contextId);
    setContexts(contextsNow.current);
    return true;
  };
  const insertCitation = (citation: AssistantCitation): ContextInsertion => {
    if (literalAnswer || approval !== undefined) return "not-now";
    const at = focused ? Math.min(cursor, prompt.length) : prompt.length;
    const before = prompt.slice(0, at);
    const gap = before.length > 0 && !/\s$/.test(before) ? " " : "";
    editor.current?.replaceRange(at, at, `${gap}${serializeAssistantCitation(citation)} `);
    editor.current?.focus();
    return "inserted";
  };
  const menuListId = useId();
  // `@` offers the node's other threads, linked by their address (D24): the node's own id.
  // They are followed only while `@` is typed, as T3's useThreadShells(isPathTrigger).
  const pathTrigger = detectComposerTrigger(prompt, cursor)?.kind === "path";
  const catalog = useCatalog(chat.threads, pathTrigger ? props.target : undefined);
  // A thread chip opens its thread wherever in the mesh it is: the members are followed then too.
  const threadChip = prompt.includes("](jhin://") || prompt.includes("](jhin-context://v1/thread/");
  const members = useMeshMembers(
    chat.mesh,
    pathTrigger || threadChip ? props.target.node : undefined,
  );
  const selfNodeId = members?.find((member) => member.self)?.nodeId ?? undefined;
  const nodeId = props.target.remote ?? selfNodeId;
  const menu = useComposerMenu({
    call: (method, params) => chat.threads.call(props.target, method, params),
    projectId: props.context?.project?.id,
    agentId: agent?.agentId,
    prompt,
    cursor,
    planMode: planSupported,
    showSkillsInSlashMenu: settings.showSkillsInSlashMenu,
    enabled: approval === undefined && question === undefined,
    threadId: props.context?.thread?.id,
    threads: catalog?.threads ?? [],
    threadAddress: (threadId) =>
      nodeId === undefined ? undefined : `jhin://${nodeId}/threads/${threadId}`,
  });
  const chips = useComposerChipActions({
    target: props.target,
    projectId: props.context?.project?.id,
    threadId: props.context?.thread?.id,
    agentId: agent?.agentId,
    nodeId,
    selfNodeId,
    skills: menu.skills,
    records: knownRecordsById(contexts),
  });
  /**
   * T3's onSelectComposerItem: inserts the command, skill, file, pull request or thread, or
   * runs a built-in.
   */
  const pickMenuItem = (item: ComposerMenuItem) => {
    const trigger = menu.trigger;
    if (trigger === null) return;
    const insertion = menuInsertion(item, serializeComposerFileLink);
    // A pull request or a thread goes in as a record its reference names (D1006).
    const record = menuContextRecord(item);
    if (record !== undefined) setContexts((current) => withContexts(current, [record]));
    editor.current?.replaceRange(trigger.rangeStart, trigger.rangeEnd, insertion ?? "");
    if (item.type !== "slash-command") return;
    if (item.command === "model") setPickerOpen(true);
    else if (planSupported) {
      props.onSelectionChange({ ...props.selection, interactionMode: item.command });
    }
  };
  /** T3's "Resume thread" stands in for the send button while nothing is typed (D800). */
  // A proposed plan's Implement comes first, as the button it would replace.
  const canResume = (text = prompt) =>
    props.onResume !== undefined &&
    planFollowUp === undefined &&
    !props.running &&
    editing === undefined &&
    question === undefined &&
    approval === undefined &&
    text.trim() === "" &&
    attachments.length === 0;
  const resume = async () => {
    if (busy || props.unavailable !== undefined || props.onResume === undefined) return;
    setBusy(true);
    try {
      await props.onResume();
    } finally {
      setBusy(false);
    }
  };
  useImperativeHandle(props.handleRef, () => ({
    restore(draft) {
      const restored = appendToDraft(
        { prompt, attachments: draftAttachments(attachments), contexts },
        draft,
      );
      setContexts(restored.contexts ?? []);
      setPrompt(restored.prompt);
      uploads.replace(restored.attachments.map((item) => attachmentItems([item])[0]!));
      historyPosition.current = null;
      focus();
    },
    draft: () => ({ prompt, attachments: draftAttachments(attachments), contexts }),
    focus,
    insert,
    insertContext,
    removeContext,
    insertCitation,
    toggleModelPicker: () => setPickerOpen((open) => !open),
    cycleRuntimeMode,
    togglePlanMode,
    // True once the message went: not for an edit, an answer, or nothing to send.
    sendAlternate: () => send(true),
    steerNext() {
      const next = queued[0];
      const actions = props.queueActions;
      if (
        next === undefined ||
        editing !== undefined ||
        !props.running ||
        props.canSteer !== true ||
        actions === undefined
      ) {
        return false;
      }
      // One at a time, as the banner's buttons are; a failure shows as a toast.
      if (!queueBusy.current) {
        queueBusy.current = true;
        void actions.steer(next.id).finally(() => {
          queueBusy.current = false;
        });
      }
      return true;
    },
    // Declines while a queued message is edited, or with text before the caret
    // (as in T3); the shortcut is bound only while something is queued and
    // nothing edited (`queuedMessages`).
    editLatest() {
      const latest = queued.at(-1);
      const caret = editor.current?.cursor() ?? 0;
      if (latest === undefined || editing !== undefined || caret !== 0) return false;
      void startEdit(latest.id);
      return true;
    },
    resume() {
      // What the editor holds now, as `send` reads it.
      if (busy || props.unavailable !== undefined) return false;
      if (!canResume(editor.current?.value() ?? prompt)) return false;
      void resume();
      return true;
    },
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
  // The queue's shortcuts apply only with something queued and nothing edited,
  // so otherwise their keys keep their usual meaning (Alt+↑ moves the caret).
  /** The caret is at the composer's start: Alt+↑ edits the last queued message there, as in T3. */
  const [caretAtStart, setCaretAtStart] = useState(true);
  const queueShortcuts = queued.length > 0 && editing === undefined;
  useEffect(() => {
    if (keybindings === undefined || !queueShortcuts || !caretAtStart) return;
    const subscription = keybindings.setContext("composerCaretAtStart", true);
    return () => subscription.dispose();
  }, [keybindings, queueShortcuts, caretAtStart]);
  useEffect(() => {
    if (keybindings === undefined || !queueShortcuts) return;
    const subscription = keybindings.setContext("queuedMessages", true);
    return () => subscription.dispose();
  }, [keybindings, queueShortcuts]);
  // Typed text owns ⌘/Ctrl+Shift+Enter (the other send when ⌘/Ctrl+Enter
  // sends): the steer-next shortcut gives way to it.
  const typed = prompt.trim() !== "" || attachments.length > 0;
  useEffect(() => {
    if (keybindings === undefined || !typed) return;
    const subscription = keybindings.setContext("composerHasText", true);
    return () => subscription.dispose();
  }, [keybindings, typed]);

  const addFiles = (files: readonly File[]) => uploads.add(files);

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
  /** What sending does now: starts a turn, or queues or steers while one runs (D209). */
  const followUp =
    editing !== undefined || !props.running
      ? undefined
      : dispatchMode(settings.followUpBehavior, false, props.canSteer === true);
  const sendLabel =
    editing !== undefined
      ? "Save queued message"
      : followUp === "queue"
        ? "Queue message"
        : followUp === "steer"
          ? "Steer message"
          : "Send message";
  /** Sends what is typed; true once it went as a message (not an edit, an answer or a mode switch). */
  const send = async (alternate = false): Promise<boolean> => {
    if (busy || props.unavailable !== undefined || approval !== undefined) return false;
    if (question !== undefined) {
      await submitAnswers();
      return false;
    }
    // What the editor holds now: a key can come before the render of what was
    // just typed (or cleared), so the state may still be the text before it.
    const typed = editor.current?.value() ?? prompt;
    const hasTyped = typed.trim() !== "" || attachments.length > 0;
    if (planFollowUp !== undefined && !hasTyped) {
      await implement(false);
      return false;
    }
    if (!hasTyped) return false;
    // `/usage-limits` sent alone is answered here when the agent has limits (T3); otherwise it
    // goes to the agent untouched.
    if (attachments.length === 0 && isUsageLimitsCommand(typed) && agent?.usageLimits === true) {
      // T3 clears the prompt once the panel opened; what was typed stays otherwise. Busy while
      // it asks, so a second Enter asks nothing more, and text typed meanwhile is kept.
      setBusy(true);
      try {
        if (
          (await openUsageLimits(usageKey, agent)) &&
          isUsageLimitsCommand(editor.current?.value() ?? "")
        ) {
          setPrompt("");
          setCursor(0);
        }
      } finally {
        setBusy(false);
      }
      return false;
    }
    // `/plan` or `/default` sent alone switch the mode instead (T3).
    const standalone = attachments.length === 0 ? parseStandaloneComposerSlashCommand(typed) : null;
    if (standalone !== null && planSupported) {
      props.onSelectionChange({ ...props.selection, interactionMode: standalone });
      setPrompt("");
      setCursor(0);
      return false;
    }
    const ready = uploads.forMessage();
    if (!ready.ok) {
      toasts?.show({ type: "error", title: ready.message });
      return false;
    }
    const text = typed;
    if (editing !== undefined) {
      // An edit is saved, never sent as a new message beside the queued one.
      if (props.queueActions === undefined) return false;
      setBusy(true);
      try {
        const edited = referencedContext(text, contexts) ?? { version: 1, records: [] };
        if (await props.queueActions.edit(editing.id, text, ready.attachments, edited)) {
          setPrompt(editing.draft.prompt);
          uploads.replace(editing.draft.attachments);
          setContexts(editing.draft.contexts);
          setEditing(undefined);
        }
      } finally {
        setBusy(false);
      }
      return false;
    }
    // Only the records the text still names go with it (T3's buildMessageContext).
    const context = referencedContext(text, contexts);
    const kept = contexts;
    // Cleared first, restored if sending fails (as T3 Code does).
    setPrompt("");
    setCursor(0);
    setContexts([]);
    const taken = uploads.take();
    historyPosition.current = null;
    setBusy(true);
    try {
      const sent = await props.onSend(text, ready.attachments, alternate, context);
      if (!sent) {
        setPrompt(text);
        setContexts(kept);
        taken.restore();
      } else {
        taken.sent();
      }
      return sent;
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
  /**
   * A question with a prefilled answer is edited as literal text (T3's `isLiteralPendingAnswer`,
   * D1001): no chips, no styling, and the answer goes back exactly as typed.
   */
  const literalAnswer =
    currentQuestion?.initialAnswer !== undefined && currentQuestion.allowCustomAnswer !== false;
  // The draft waits aside while an answer to edit shows (D1001).
  const putAside = usePutAside({
    draftKey: props.draftKey,
    seed:
      literalAnswer && question !== undefined && currentQuestion?.initialAnswer !== undefined
        ? {
            key: `${question.requestId}:${currentQuestion.id}`,
            text: currentQuestion.initialAnswer,
          }
        : undefined,
    asking: question !== undefined,
    prompt,
    setPrompt: (value) => {
      setPrompt(value);
      setCursor(value.length);
    },
  });
  putAsideNow.current = putAside;
  useEffect(() => {
    // A queued message being edited is not the thread's draft, nor is a prefilled answer.
    if (editing === undefined && !putAside.active) {
      const kept = referencedContext(prompt, contexts)?.records;
      drafts.set(props.draftKey, {
        prompt,
        attachments: draftAttachments(attachments),
        ...(kept === undefined ? {} : { contexts: kept }),
      });
    }
  }, [drafts, props.draftKey, prompt, attachments, contexts, editing, putAside.active]);
  const custom = literalAnswer ? prompt : prompt.trim();
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

  /** Keys the composer takes before the editor: menus, history, plan mode. True when taken. */
  const onKeyDown = (event: globalThis.KeyboardEvent): boolean => {
    if (event.isComposing || event.keyCode === 229) return false;
    if (menu.onKeyDown(event, pickMenuItem)) {
      event.preventDefault();
      return true;
    }
    // T3's ⌘/Ctrl+Shift+V: the paste it starts stays inline, however large.
    if (isPasteAsTextShortcut(event, isMacPlatform(currentPlatform()))) {
      pasteAsText.current = true;
      return false;
    }
    if (event.key === "Tab" && event.shiftKey && planSupported) {
      event.preventDefault();
      togglePlanMode();
      return true;
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
      const atStart = editor.current?.caretOnFirstLine() ?? true;
      const atEnd = editor.current?.caretOnLastLine() ?? true;
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
          // The editor takes a prompt set from outside with the caret at its end.
          setPrompt(step.prompt);
          setCursor(step.prompt.length);
        }
        return true;
      }
    }
    // A shortcut took the key already (the dispatcher runs first): nothing more.
    if (event.defaultPrevented) return true;
    // While a turn runs the send key with ⌘/Ctrl (and Shift when ⌘/Ctrl sends)
    // does the opposite of "Follow-up behavior" (T3's composer.sendAlternate);
    // the editor sends on its own send key.
    if (event.key === "Enter" && !event.altKey && props.running && editing === undefined) {
      const withMod = event.metaKey || event.ctrlKey;
      if (
        settings.sendShortcut === "enter" ? withMod && !event.shiftKey : withMod && event.shiftKey
      ) {
        event.preventDefault();
        void send(true);
        return true;
      }
    }
    return false;
  };

  /** Files and large pastes become attachments; true when the paste was taken. */
  const onPaste = (event: globalThis.ClipboardEvent): boolean => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const plainText = event.clipboardData?.getData("text/plain") ?? "";
    // Both are spent by this paste, whichever armed it.
    const armed = consumeArmedPasteAsText();
    const bypass = pasteAsText.current || armed;
    pasteAsText.current = false;
    if (files.length > 0 && shouldHandleAttachmentPaste({ files, plainText })) {
      event.preventDefault();
      void addFiles(files);
      return true;
    }
    // A large paste becomes a file, as T3 attaches it (D295).
    if (
      pastedTextDisposition({ text: plainText, canAttach: true, bypassAutoAttachment: bypass }) ===
      "attachment"
    ) {
      event.preventDefault();
      const file = pastedTextFile(
        plainText,
        attachments.map((item) => item.name),
      );
      void addFiles([file]);
      toasts?.show({
        type: "info",
        title: `Large paste attached as ${file.name}`,
        description: `${formatAttachmentSize(file.size)} · Use ${
          isMacPlatform(currentPlatform()) ? "⌘⇧V" : "Ctrl+Shift+V"
        } to keep a large paste inline.`,
      });
      return true;
    }
    return false;
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
          : "Ask anything, @tag files/folders, $use skills, or / for commands";
  const disabled = approval !== undefined;
  const mode = RUNTIME_MODES[runtimeMode] ?? RUNTIME_MODES["full-access"]!;
  // The menu is the editor's list while it shows; its highlighted item the active option (D1348).
  const menuShown = menu.trigger !== null && approval === undefined && question === undefined;
  const menuActive =
    menuShown && menu.activeId !== null && menu.items.some((item) => item.id === menu.activeId)
      ? composerSuggestionOptionId(menuListId, menu.activeId)
      : undefined;

  return (
    <div
      className="relative z-10"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          typingHere.current = false;
      }}
      onFocusCapture={() => {
        typingHere.current = true;
      }}
    >
      <ComposerSurface.Shell>
        {menuShown && menu.trigger !== null ? (
          <CommandMenuBanner
            activeItemId={menu.activeId}
            emptyStateText={menu.emptyState}
            isLoading={menu.isLoading}
            items={menu.items}
            listId={menuListId}
            onHighlight={menu.setActiveId}
            onSelect={pickMenuItem}
            trigger={menu.trigger.kind}
          />
        ) : approval !== undefined ? (
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
        ) : props.queue !== undefined &&
          props.queue.messages.length > 0 &&
          props.queueActions !== undefined ? (
          <QueueBanner
            actions={props.queueActions}
            loader={attachmentLoader}
            canSteer={props.canSteer === true}
            editing={editing?.id}
            onCancelEdit={cancelEdit}
            onEdit={(messageId) => void startEdit(messageId)}
            queue={props.queue}
            running={props.running}
            steerShortcut={`${mod}Shift+Enter`}
          />
        ) : planFollowUp !== undefined ? (
          <PlanFollowUpBanner planTitle={planFollowUp.title} />
        ) : props.limitRecovery !== undefined ? (
          <LimitRecoveryBanner state={props.limitRecovery} />
        ) : usagePanel !== undefined ? (
          <UsageLimitsBanner
            agentName={usagePanel.agentName}
            format={settings.timestampFormat}
            limits={usagePanel.limits}
            now={usagePanel.now}
            onDismiss={() => setUsagePanel(undefined)}
          />
        ) : props.goal !== undefined ? (
          <GoalBanner
            busy={busy}
            goal={props.goal}
            onCommand={(command) => {
              setBusy(true);
              void props.onSend(command, []).finally(() => setBusy(false));
            }}
            working={props.running}
          />
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
                    <ComposerAttachments
                      fileOf={uploads.fileOf}
                      items={attachments}
                      loader={attachmentLoader}
                      onRemove={uploads.remove}
                      onRetry={uploads.retry}
                    />
                    <div className="relative flow-root text-sm max-sm:pointer-coarse:text-[16px]">
                      <Suspense
                        fallback={
                          <div
                            aria-busy="true"
                            className="-m-1 block min-h-19.5 w-[calc(100%+0.5rem)] p-1 leading-relaxed text-placeholder/75"
                          >
                            {placeholder}
                          </div>
                        }
                      >
                        <ComposerChipsContext value={chips.actions}>
                          <PromptEditor
                            className={cn(
                              "-m-1 block max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] overflow-y-auto bg-transparent p-1 leading-relaxed wrap-break-word text-foreground outline-none",
                              approval !== undefined && "min-h-10",
                            )}
                            disabled={disabled}
                            handleRef={editor}
                            onBlur={() => setFocused(false)}
                            onChange={(value, caret) => {
                              if (value !== prompt) setPrompt(value);
                              setCursor(caret);
                              setCaretAtStart(caret === 0);
                            }}
                            onFocus={() => setFocused(true)}
                            onKeyDown={onKeyDown}
                            onPaste={onPaste}
                            onSubmit={() => void send()}
                            placeholder={placeholder}
                            {...(menuShown
                              ? {
                                  suggestionListId: menuListId,
                                  activeSuggestionId: menuActive,
                                }
                              : {})}
                            readOnly={busy && question === undefined}
                            literalText={literalAnswer}
                            richText={settings.composerRichTextEnabled}
                            sendShortcut={
                              settings.sendShortcut === "mod-enter" ? "mod-enter" : "enter"
                            }
                            value={approval !== undefined ? "" : prompt}
                          />
                        </ComposerChipsContext>
                      </Suspense>
                      {chips.dialog}
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
                          remembered={chat.modelOptions.get}
                          onOpenChange={setPickerOpen}
                          onOpened={() => chat.agents.refresh(props.target)}
                          onSelect={props.onSelectionChange}
                          open={pickerOpen}
                          selection={props.selection}
                        />
                        {modelOptions.length > 0 ? (
                          <>
                            <ComposerControlSeparator />
                            <TraitsPicker
                              descriptors={modelOptions}
                              onChange={(next) => {
                                if (agent !== undefined && modelId !== undefined) {
                                  chat.modelOptions.set(agent.agentId, modelId, next);
                                }
                                props.onSelectionChange({ ...props.selection, modelOptions: next });
                              }}
                              onPromptChange={setPrompt}
                              prompt={prompt}
                              selections={props.selection.modelOptions}
                            />
                          </>
                        ) : null}
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
                                aria-label="Attach files"
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
                          <TooltipPopup side="top">Attach files</TooltipPopup>
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
                        ) : props.running && !hasContent && editing === undefined ? (
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
                        ) : canResume() ? (
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex" />}>
                              <button
                                aria-label="Resume thread"
                                className={SEND_BUTTON}
                                disabled={busy || props.unavailable !== undefined}
                                onClick={() => void resume()}
                                type="button"
                              >
                                {busy ? (
                                  <Spinner size="sm" />
                                ) : (
                                  <PlayIcon className="size-4 fill-current" />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              {props.unavailable ?? "Resume thread"}
                            </TooltipPopup>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex" />}>
                              <button
                                aria-label={sendLabel}
                                className={SEND_BUTTON}
                                disabled={busy || !hasContent || props.unavailable !== undefined}
                                type="submit"
                              >
                                {busy ? (
                                  <Spinner size="sm" />
                                ) : followUp === "queue" ? (
                                  <ListOrderedIcon className="size-4" />
                                ) : followUp === "steer" ? (
                                  <CornerUpRightIcon className="size-4" />
                                ) : (
                                  <SendIcon />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              {props.unavailable ??
                                (editing !== undefined
                                  ? "Save the queued message"
                                  : followUp === "queue"
                                    ? "Queue message: it is sent when this turn ends"
                                    : followUp === "steer"
                                      ? "Steer: the running turn takes this message now"
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
