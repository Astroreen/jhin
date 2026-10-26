// The design follows T3 Code's sidebar (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/Sidebar.tsx (thread cards, pinned threads, the Snoozed and
// Settled shelves, dragging, settling and snoozing from a row, search results),
// Sidebar.drag.ts, sidebar/SidebarThreadHeader.tsx, sidebar/SidebarChrome.tsx,
// ThreadHoverCard.tsx, ui/collapsible-section-header.tsx, EnvironmentMachineIcon.tsx and,
// for the node alerts, LegacySidebar.tsx (LocalSecondaryStatus).
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  defaultAnimateLayoutChanges,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MACHINES_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREAD_DETAILS_SLOT,
  SIDEBAR_NOTICES_SLOT,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeConnection,
  type NodeMachines,
  type NodeTarget,
  THREAD_PARK_HOOK,
  type ThreadParkInput,
  type ThreadSection,
  type ThreadsCatalog,
  CHAT_DRAFTS_CAPABILITY,
  UNDO_CAPABILITY,
  VISITS_CAPABILITY,
  THREAD_WORK_CAPABILITY,
  workHoldsCompletion,
  type ThreadWork,
  lastVisitOf,
  visitKey,
  type ChatDrafts,
  type ThreadUndoService,
  type ThreadVisits,
  type NodeActionProps,
  type ThreadActionProps,
  type ThreadSelectionActionProps,
  type ThreadIndicatorProps,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Kbd,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  Skeleton,
  Slot,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  cn,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  MessageSquareDashedIcon,
  PencilIcon,
  PinIcon,
  MailOpenIcon,
  PinOffIcon,
  RefreshCwIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { AddProjectDialog, createAddProjectRequests } from "../lib/add-project.tsx";
import { AgentIcon } from "../lib/agent-icon.tsx";
import { builtin } from "../lib/builtin.ts";
import { createClock } from "../lib/clock.ts";
import { formatCompactRelativeTime } from "../lib/format.ts";
import { useExternal, useNow, useShortcutLabels } from "../lib/hooks.ts";
import { MachineIcon } from "../lib/machine-icon.tsx";
import { useMachineKind } from "../lib/machines.ts";
import { createShownNodes, showsHosts, type NodeWithCatalog } from "../lib/nodes.ts";
import { currentPlatform, holdsShortcutModifiers, isMacPlatform } from "../lib/keybindings.ts";
import { CHAT_SECTION, ChatSettings, readSection, useSection } from "../lib/settings.ts";
import { ProjectIcon } from "../lib/project-icon.tsx";
import {
  createSidebarCollisionDetection,
  DRAG_BOUNDARY_LABEL_CLASS,
  dropVerb,
  itemId,
  markerId,
  planDrop,
  resolveDropTarget,
  sidebarListItems,
  type DropSection,
  type DropVerb,
  type SidebarListItem,
  type SidebarListMarker,
} from "../lib/sidebar-drag.ts";
import {
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  canSnooze,
  formatWorkingDurationLabel,
  isUnread,
  isWoke,
  projectKey,
  projectScopes,
  rowLabel,
  searchSidebarThreads,
  shouldRecede,
  shownSettled,
  pendingSubagentRequests,
  sidebarThreadStatus,
  sidebarThreads,
  sidebarTopStatus,
  isUsageLimited,
  threadActivityAt,
  threadKey,
  wokeAt,
  type SidebarThread,
  type SidebarTopStatus,
} from "../lib/sidebar-order.ts";
import { snoozePresets, snoozeWakeLabel } from "../lib/snooze.ts";
import { threadActions } from "../lib/thread-actions.ts";
import { SearchMatchExcerpt } from "../lib/thread-search-match.tsx";
import {
  contentQuery,
  createContentSearch,
  emptySearchLabel,
  type ContentMatch,
} from "../lib/thread-search.ts";
import type { OrderAssignment } from "../lib/thread-order.ts";

type Entry = SidebarThread<NodeWithCatalog>;
/** A search result; `match` when its messages, not its title, matched. */
type SearchEntry = Entry & { readonly match?: ContentMatch };

const SETTLED_EXPANDED_STORAGE_KEY = "jhin.sidebar.settled-expanded";
const SNOOZED_EXPANDED_STORAGE_KEY = "jhin.sidebar.snoozed-expanded";
const WORKING_EXPANDED_STORAGE_KEY = "jhin.sidebar.working-expanded";
/** How long the jump modifiers are held before the rows show their numbers (T3's). */
const JUMP_HINT_DELAY_MS = 200;
/** How far a sweep or a drag moves before it is one (T3's SIDEBAR_DRAG_DISTANCE). */
const SWEEP_DISTANCE = 6;
/** A row drags once the pointer moved this far (T3's SIDEBAR_DRAG_DISTANCE); one object, as useSensor memoizes on it. */
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: SWEEP_DISTANCE } };
const PROJECT_SCOPE_STORAGE_KEY = "jhin.sidebar.project-scope";

/**
 * A value of the sidebar that its commands read too (the search, the shelf).
 * With a storage key it is kept on this device; a stored value that does not
 * parse, or is not of the value's type, gives way to the default.
 */
function createValue<T>(
  initial: T,
  stored?: { readonly key: string; readonly valid: (value: unknown) => value is T },
) {
  let value = initial;
  const storageKey = stored?.key;
  if (stored !== undefined) {
    try {
      const raw = localStorage.getItem(stored.key);
      const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
      if (stored.valid(parsed)) value = parsed;
    } catch {
      // Unreadable: the default.
    }
  }
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      if (storageKey !== undefined) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Not kept; still applied.
        }
      }
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

/** Without `chat.drafts`: no card shows a draft (D963). */
const NO_DRAFTS = { subscribe: () => ({ dispose: () => undefined }) };

/** Without `client.visits`: nothing was seen, so nothing shows as unread. */
const NO_VISITS: Pick<ThreadVisits, "snapshot" | "subscribe"> = {
  snapshot: () => NO_SEEN,
  subscribe: () => ({ dispose() {} }),
};
const NO_SEEN: Readonly<Record<string, string>> = {};

/** A node's machine icon (`client.machines`); a server's until the node says otherwise. */
function NodeIcon({
  machines,
  target,
  className,
}: {
  machines: NodeMachines | undefined;
  target: NodeTarget;
  className?: string;
}) {
  return <MachineIcon aria-hidden className={className} kind={useMachineKind(machines, target)} />;
}

/**
 * The node a row lives on, while the sidebar shows several: T3 Code marks a
 * thread's environment with its machine icon (EnvironmentMachineIcon).
 */
function HostIcon({
  label,
  className,
  ...node
}: {
  label: string;
  className?: string;
  machines: NodeMachines | undefined;
  target: NodeTarget;
}) {
  return (
    <span
      aria-label={`On ${label}`}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      data-host-indicator
      role="img"
    >
      <NodeIcon {...node} className="size-3.5" />
    </span>
  );
}

/** A connection's state as a dot (T3 Code's ConnectionStatusDot). */
function ConnectionDot({ state }: { state: NodeConnection["state"] }) {
  return (
    <span aria-hidden className="relative flex size-3 shrink-0 items-center justify-center">
      {state === "connecting" ? (
        <span className="absolute inline-flex size-2 animate-status-ping rounded-full bg-warning/60" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          state === "open"
            ? "bg-success"
            : state === "connecting"
              ? "bg-warning"
              : "bg-destructive",
        )}
      />
    </span>
  );
}

function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<ComponentProps<typeof SidebarMenuButton>, "children" | "className" | "aria-label">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            aria-label={label}
            size="icon"
            type="button"
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

const HEADER_TONES = {
  muted: { label: "text-sidebar-muted-foreground/60", line: "bg-sidebar-border/60" },
  info: { label: "text-blue-600 dark:text-blue-400", line: "bg-blue-500/20 dark:bg-blue-400/15" },
  emphasized: { label: "text-sidebar-foreground/80", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

/** T3's section header with a rule and a chevron (CollapsibleSectionHeader). */
function SectionHeaderButton(props: {
  label: string;
  expanded: boolean;
  tone: keyof typeof HEADER_TONES;
  onToggle(): void;
}) {
  const tone = HEADER_TONES[props.tone];
  return (
    <button
      aria-expanded={props.expanded}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        tone.label,
      )}
      onClick={props.onToggle}
      type="button"
    >
      <span className="shrink-0">{props.label}</span>
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tone.line)} />
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !props.expanded && "rotate-180")}
      />
    </button>
  );
}

const TOP_STATUS: Record<
  SidebarTopStatus,
  { label: string; className: string; icon: ComponentType<{ className?: string }> }
> = {
  working: { label: "Working", className: "text-info", icon: CircleDashedIcon },
  goal: { label: "Goal", className: "text-info", icon: CircleDashedIcon },
  waiting: { label: "Waiting", className: "text-muted-foreground", icon: CircleDotDashedIcon },
  approval: { label: "Approval", className: "text-warning-foreground", icon: ShieldQuestionIcon },
  input: {
    label: "Input",
    className: "text-indigo-600 dark:text-indigo-300",
    icon: MessageCircleQuestionIcon,
  },
  limited: { label: "Limited", className: "text-warning", icon: CircleAlertIcon },
  failed: { label: "Failed", className: "text-error", icon: CircleAlertIcon },
  woke: { label: "Woke", className: "text-warning", icon: AlarmClockIcon },
  done: { label: "Done", className: "text-success", icon: CircleCheckIcon },
};

/** What a drop does, on the dragged row (T3's dropVerbBadge). */
const DROP_VERB: Record<DropVerb, { label: string; icon: ComponentType<{ className?: string }> }> =
  {
    pin: { label: "Pin", icon: PinIcon },
    unpin: { label: "Unpin", icon: PinOffIcon },
    settle: { label: "Settle", icon: CircleCheckIcon },
    unsettle: { label: "Un-settle", icon: Undo2Icon },
    wake: { label: "Wake", icon: AlarmClockOffIcon },
  };

// Rows move while sorting only; otherwise a list change would animate every row (T3's).
const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

/** A dragged row's sortable state, for the row to place itself. */
type SortableBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

/** A row being dragged: where from, and over which section it would land. */
interface DragState {
  readonly key: string;
  readonly from: ThreadSection;
  readonly over: DropSection | null;
  /** Where the pointer was when the row started to drag (T3's activationY). */
  readonly activationY: number | null;
}

/** A drop shown in place until its node commands are done (T3's optimistic drop). */
interface OptimisticDrop {
  readonly key: string;
  readonly section: DropSection;
  /** The keys of the section's rows in their new order, for pinned and active. */
  readonly order: readonly string[] | undefined;
}

/** How long a turn has worked, ticking each second (T3's WorkingDuration). */
function WorkingDuration({ startedAt }: { startedAt: string }) {
  const now = useNow(1000);
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(now - started)}</span>;
}

export const sidebarPlugin = builtin(
  "jhin.sidebar",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: {
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [KEYBINDINGS_CAPABILITY]: "^1",
      [VISITS_CAPABILITY]: "^1",
      [MACHINES_CAPABILITY]: "^1",
      [CHAT_DRAFTS_CAPABILITY]: "^1",
      [UNDO_CAPABILITY]: "^1",
      [THREAD_WORK_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const work = context.services.tryGet<ThreadWork>(THREAD_WORK_CAPABILITY);
      /** Bumped when background work changes, so lists and rows read it again (D1131). */
      const workVersion = createValue(0);
      if (work !== undefined) {
        context.subscriptions.add(work.subscribe(() => workVersion.set(workVersion.get() + 1)));
      }
      const waitingOn = (target: NodeTarget, threadId: string) =>
        work !== undefined && workHoldsCompletion(work.tasks(target, threadId));
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const visits = context.services.tryGet<ThreadVisits>(VISITS_CAPABILITY);
      const drafts = context.services.tryGet<ChatDrafts>(CHAT_DRAFTS_CAPABILITY);
      const undo = context.services.tryGet<ThreadUndoService>(UNDO_CAPABILITY);
      const hasCommand = (name: string) =>
        context.commands.list().some((command) => command.name === name);
      const machines = context.services.tryGet<NodeMachines>(MACHINES_CAPABILITY);
      const search = createValue("");
      /** The threads the nodes find by their messages while a search is typed (D228). */
      const contentSearch = createContentSearch(threads);
      context.subscriptions.add({ dispose: contentSearch.dispose });
      const settledExpanded = createValue(false, {
        key: SETTLED_EXPANDED_STORAGE_KEY,
        valid: (value): value is boolean => typeof value === "boolean",
      });
      /** The project the list is narrowed to (a `projectKey`), or "" for all. */
      const scope = createValue("", {
        key: PROJECT_SCOPE_STORAGE_KEY,
        valid: (value): value is string => typeof value === "string",
      });
      const snoozedExpanded = createValue(false, {
        key: SNOOZED_EXPANDED_STORAGE_KEY,
        valid: (value): value is boolean => typeof value === "boolean",
      });
      /** Whether the rows show their jump shortcuts: the modifiers held for 200 ms (D453). */
      const jumpHints = createValue(false);
      let jumpHintTimer: ReturnType<typeof setTimeout> | undefined;
      const JUMP_COMMANDS = new Set(
        Array.from({ length: 9 }, (_, index) => `sidebar.thread.jump.${index + 1}`),
      );
      const hideJumpHints = () => {
        clearTimeout(jumpHintTimer);
        jumpHintTimer = undefined;
        jumpHints.set(false);
      };
      const syncJumpHints = (event: KeyboardEvent) => {
        // A terminal owns the keys while it has focus (T3 shows no hints then).
        const inTerminal = document.activeElement?.closest("[data-terminal-owner]") != null;
        if (
          inTerminal ||
          keybindings === undefined ||
          !holdsShortcutModifiers(event, keybindings.list(), JUMP_COMMANDS)
        ) {
          hideJumpHints();
          return;
        }
        if (jumpHints.get() || jumpHintTimer !== undefined) return;
        jumpHintTimer = setTimeout(() => {
          jumpHintTimer = undefined;
          jumpHints.set(true);
        }, JUMP_HINT_DELAY_MS);
      };
      window.addEventListener("keydown", syncJumpHints);
      window.addEventListener("keyup", syncJumpHints);
      window.addEventListener("blur", hideJumpHints);
      context.subscriptions.add({
        dispose() {
          hideJumpHints();
          window.removeEventListener("keydown", syncJumpHints);
          window.removeEventListener("keyup", syncJumpHints);
          window.removeEventListener("blur", hideJumpHints);
        },
      });
      /** T3's multi-select of rows (D454): the selected keys and the range's anchor. */
      const selection = createValue<{ readonly keys: readonly string[]; readonly anchor?: string }>(
        {
          keys: [],
        },
      );
      const clearSelection = () => {
        if (selection.get().keys.length > 0) selection.set({ keys: [] });
      };
      // Escape clears a selection (T3).
      const onSelectionKey = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          selection.get().keys.length > 0 &&
          // Escape that closes a menu or dialog, or leaves a field, is theirs.
          target?.closest("input, textarea, [contenteditable], [role=menu], [role=dialog]") == null
        ) {
          event.preventDefault();
          selection.set({ keys: [] });
        }
      };
      window.addEventListener("keydown", onSelectionKey);
      context.subscriptions.add({
        dispose: () => window.removeEventListener("keydown", onSelectionKey),
      });
      /**
       * A click on a row (T3's handleThreadClick): ⌘/Ctrl adds or removes it,
       * Shift adds the rows from the anchor to it, a plain click opens it and
       * clears the selection.
       */
      const clickRow = (
        event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
        key: string,
        open: () => void,
      ) => {
        const mod = isMacPlatform(currentPlatform()) ? event.metaKey : event.ctrlKey;
        const { keys, anchor } = selection.get();
        if (mod) {
          selection.set({
            keys: keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
            anchor: key,
          });
          return;
        }
        if (event.shiftKey) {
          const rows = orderedThreads().map((entry) => entry.key);
          const from = anchor === undefined ? -1 : rows.indexOf(anchor);
          const to = rows.indexOf(key);
          const range =
            from === -1 || to === -1
              ? [key]
              : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
          selection.set({
            keys: [...keys, ...range.filter((item) => !keys.includes(item))],
            ...(anchor === undefined ? { anchor: key } : { anchor }),
          });
          return;
        }
        selection.set({ keys: [], anchor: key });
        open();
      };
      /** The selected threads still listed. */
      const selected = (): Entry[] => {
        const every = everyThread();
        return selection.get().keys.flatMap((key) => {
          const entry = every.get(key);
          return entry === undefined ? [] : [entry];
        });
      };
      const refOf = (entry: Entry) => ({ ...entry.node.target, threadId: entry.thread.id });
      /** Runs a thread command for each selected thread, then clears the selection. */
      const forSelected = async (
        pick: (entry: Entry) => boolean,
        each: (entry: Entry) => Promise<unknown>,
        failure: (count: number) => string,
        chosen: readonly Entry[] = selected(),
      ) => {
        const entries = chosen.filter(pick);
        selection.set({ keys: [] });
        // What failed stays selected, as T3 keeps it, to try again.
        const failed: string[] = [];
        let reason = "";
        for (const entry of entries) {
          try {
            await each(entry);
          } catch (error) {
            failed.push(entry.key);
            reason = (error as Error).message;
          }
        }
        if (failed.length > 0) {
          selection.set({ keys: failed });
          toasts?.show({ type: "error", title: failure(failed.length), description: reason });
        }
        return {};
      };
      const SelectionInput = z.object({});
      context.commands.register({
        name: "sidebar.selection.settle",
        title: "Settle selected threads",
        description: 'Settles every thread selected in the sidebar (T3\'s "Settle (N)")',
        input: SelectionInput,
        output: z.object({}),
        handler: () =>
          forSelected(
            (entry) => entry.section !== "settled",
            (entry) => context.commands.execute("thread.settle", refOf(entry)),
            (count) => `Failed to settle ${count} thread${count === 1 ? "" : "s"}`,
          ),
      });
      context.commands.register({
        name: "sidebar.selection.unpin",
        title: "Unpin selected threads",
        description: 'Unpins every pinned thread selected in the sidebar (T3\'s "Unpin (N)")',
        input: SelectionInput,
        output: z.object({}),
        handler: () =>
          forSelected(
            (entry) => entry.thread.pinnedAt !== undefined,
            (entry) => context.commands.execute("thread.unpin", refOf(entry)),
            (count) => `Failed to unpin ${count} thread${count === 1 ? "" : "s"}`,
          ),
      });
      context.commands.register({
        name: "sidebar.selection.snooze",
        title: "Snooze selected threads",
        description:
          'Snoozes every thread selected in the sidebar until `until`, or a time asked for in the custom snooze dialog (T3\'s "Snooze (N)")',
        input: z.object({ until: z.iso.datetime({ offset: true }).optional() }),
        output: z.object({}),
        handler: async (input) => {
          // "Custom…" asks once for every selected thread (t3-parity.md D962),
          // and snoozes the threads chosen when it was asked.
          const chosen = selected();
          const until =
            input.until ??
            ((await context.commands.execute("thread.snooze.choose", {})) as { until?: string })
              .until;
          if (until === undefined) return {};
          return forSelected(
            () => true,
            (entry) => context.commands.execute("thread.snooze", { ...refOf(entry), until }),
            (count) => `Failed to snooze ${count} thread${count === 1 ? "" : "s"}`,
            chosen,
          );
        },
      });
      context.commands.register({
        name: "sidebar.selection.regenerate-titles",
        title: "Regenerate titles of selected threads",
        description:
          'Has an agent write a new title for every selected thread not being retitled already (T3\'s "Regenerate titles (N)")',
        input: SelectionInput,
        output: z.object({}),
        handler: async () => {
          // All at once: each title is written by its own agent turn on its node (D1176).
          const entries = selected().filter(
            (entry) => entry.thread.titleRegeneration === undefined,
          );
          selection.set({ keys: [] });
          const outcomes = await Promise.allSettled(
            entries.map((entry) =>
              threads.call(entry.node.target, "threads.title.regenerate", {
                threadId: entry.thread.id,
              }),
            ),
          );
          const failed = entries.filter((_, index) => outcomes[index]!.status === "rejected");
          if (failed.length > 0) {
            // What failed stays selected, as T3 keeps it, to try again.
            selection.set({ keys: failed.map((entry) => entry.key) });
            const reason = outcomes.find((outcome) => outcome.status === "rejected") as
              | PromiseRejectedResult
              | undefined;
            toasts?.show({
              type: "error",
              title: "Failed to regenerate thread titles",
              description: (reason?.reason as Error | undefined)?.message ?? "",
            });
          }
          return {};
        },
      });
      context.commands.register({
        name: "sidebar.selection.mark-unread",
        title: "Mark selected threads unread",
        description:
          'Marks every thread selected in the sidebar unread on this device (T3\'s "Mark unread (N)")',
        input: SelectionInput,
        output: z.object({}),
        handler: () =>
          forSelected(
            () => true,
            async (entry) => {
              if (visits === undefined) throw new Error("No visits plugin keeps what was read");
              visits.markUnread(entry.node.target, entry.thread.id);
            },
            (count) => `Failed to mark ${count} thread${count === 1 ? "" : "s"} unread`,
          ),
      });
      context.commands.register({
        name: "sidebar.selection.delete",
        title: "Delete selected threads",
        description:
          'Deletes every thread selected in the sidebar, after asking when the settings say so (T3\'s "Delete (N)")',
        input: SelectionInput,
        output: z.object({}),
        handler: async () => {
          const count = selected().length;
          if (count === 0) return {};
          if (
            readSection(context, CHAT_SECTION, ChatSettings).confirmDelete &&
            dialogs !== undefined &&
            !(await dialogs.confirm({
              title: `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              description: "This permanently clears conversation history for these threads.",
              confirmLabel: "Delete",
              variant: "destructive",
            }))
          )
            return {};
          return forSelected(
            () => true,
            (entry) =>
              threads.call(entry.node.target, "threads.delete", { threadId: entry.thread.id }),
            () => "Failed to delete threads",
          );
        },
      });
      context.commands.register({
        name: "sidebar.selection.clear",
        title: "Clear the selection",
        description: "Clears the threads selected in the sidebar",
        input: SelectionInput,
        output: z.object({}),
        handler: () => {
          clearSelection();
          return {};
        },
      });

      // T3's menu for a selection (handleMultiSelectContextMenu): the `thread.selection.actions`
      // slot, each item acting on every selected thread.
      const selectionItems: [string, number, ComponentType<ThreadSelectionActionProps>][] = [
        [
          "unpin",
          0,
          ({ threads: chosen }) => {
            const pinned = chosen.filter((item) => item.thread.pinnedAt !== undefined).length;
            return pinned === 0 ? null : (
              <MenuItem onClick={() => run("sidebar.selection.unpin", {})}>
                <PinOffIcon />
                Unpin ({pinned})
              </MenuItem>
            );
          },
        ],
        [
          "settle",
          10,
          ({ threads: chosen }) => (
            <MenuItem
              disabled={chosen.every((item) => item.section === "settled")}
              onClick={() => run("sidebar.selection.settle", {})}
            >
              <CircleCheckIcon />
              Settle ({chosen.length})
            </MenuItem>
          ),
        ],
        [
          "snooze",
          20,
          ({ threads: chosen }) =>
            chosen.every((item) => canSnooze(item.thread)) ? (
              <MenuSub>
                <MenuSubTrigger>
                  <ClockIcon />
                  Snooze ({chosen.length})
                </MenuSubTrigger>
                <MenuSubPopup>
                  {snoozePresets(new Date()).map((preset) => (
                    <MenuItem
                      key={preset.id}
                      onClick={() =>
                        run("sidebar.selection.snooze", { until: preset.snoozedUntil })
                      }
                    >
                      {preset.label} ({preset.whenLabel})
                    </MenuItem>
                  ))}
                  {/* The dialog is another plugin's command: no "Custom…" without it. */}
                  {hasCommand("thread.snooze.choose") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={() => run("sidebar.selection.snooze", {})}>
                        Custom…
                      </MenuItem>
                    </>
                  ) : null}
                </MenuSubPopup>
              </MenuSub>
            ) : null,
        ],
        [
          "regenerate-titles",
          25,
          ({ threads: chosen }) => {
            if (!hasCommand("thread.regenerate-title")) return null;
            const ready = chosen.filter((item) => item.thread.titleRegeneration === undefined);
            return (
              <MenuItem
                disabled={ready.length === 0}
                onClick={() => run("sidebar.selection.regenerate-titles", {})}
              >
                <RefreshCwIcon />
                {ready.length === 0
                  ? `Regenerating… (${chosen.length})`
                  : `Regenerate titles (${ready.length})`}
              </MenuItem>
            );
          },
        ],
        [
          "mark-unread",
          30,
          ({ threads: chosen }) =>
            visits === undefined ? null : (
              <MenuItem onClick={() => run("sidebar.selection.mark-unread", {})}>
                <MailOpenIcon />
                Mark unread ({chosen.length})
              </MenuItem>
            ),
        ],
        ["separator", 40, () => <MenuSeparator />],
        [
          "delete",
          50,
          ({ threads: chosen }) => (
            <MenuItem onClick={() => run("sidebar.selection.delete", {})} variant="destructive">
              <Trash2Icon />
              Delete ({chosen.length})
            </MenuItem>
          ),
        ],
      ];
      for (const [id, order, component] of selectionItems) {
        context.subscriptions.add(
          slots.contribute("thread.selection.actions", {
            id: `jhin.sidebar.selection.${id}`,
            order,
            component,
          }),
        );
      }
      function SelectionMenu() {
        const chosen = selected().map((entry) => ({
          target: entry.node.target,
          thread: entry.thread,
          section: entry.section,
        }));
        return (
          <Slot
            name="thread.selection.actions"
            props={{ threads: chosen } satisfies ThreadSelectionActionProps}
          />
        );
      }

      /** T3's Working section is collapsed until opened, kept per device (D452). */
      const workingExpanded = createValue(false, {
        key: WORKING_EXPANDED_STORAGE_KEY,
        valid: (value): value is boolean => typeof value === "boolean",
      });
      /** The time the list is drawn with, which its commands use too (one clock). */
      const clock = createClock();
      const dragState = createValue<DragState | undefined>(undefined);
      const optimistic = createValue<OptimisticDrop | undefined>(undefined);
      /** How many settled threads show; back to the first page when the scope changes. */
      const settledCount = createValue(SETTLED_TAIL_INITIAL_COUNT);
      context.subscriptions.add(
        scope.subscribe(() => settledCount.set(SETTLED_TAIL_INITIAL_COUNT)),
      );
      /** The highlighted search result. */
      const highlight = createValue(0);
      context.subscriptions.add(search.subscribe(() => highlight.set(0)));
      const addProjectRequests = createAddProjectRequests();
      const visitStore = visits ?? NO_VISITS;
      const nodeView = createShownNodes(connections, mesh, threads);

      const targetOf = (route: { node?: string; remote?: string }): NodeTarget | undefined =>
        route.node === undefined
          ? undefined
          : { node: route.node, ...(route.remote === undefined ? {} : { remote: route.remote }) };
      const routeThreadKey = (route: { node?: string; remote?: string; thread?: string }) => {
        const target = targetOf(route);
        return target === undefined || route.thread === undefined
          ? undefined
          : threadKey(target, route.thread);
      };

      /** Opens a new thread (a draft until its first message) in a project. */
      const newThread = (target: NodeTarget, projectId: string) =>
        navigation.navigate({
          node: target.node,
          ...(target.remote === undefined ? {} : { remote: target.remote }),
          project: projectId,
        });
      const openThread = (target: NodeTarget, threadId: string) =>
        navigation.navigate({
          node: target.node,
          ...(target.remote === undefined ? {} : { remote: target.remote }),
          thread: threadId,
        });

      /** Runs a command for the sidebar; what fails shows as a toast. */
      const run = (name: string, input: unknown) =>
        void context.commands.execute(name, input).catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Could not do that",
            description: (error as Error).message,
          }),
        );

      /** The sidebar's own state, read once per render or command and passed on (D63). */
      const stateNow = () => ({
        query: search.get(),
        content: contentSearch.get(),
        scoped: scope.get(),
        count: settledCount.get(),
        expanded: settledExpanded.get(),
        snoozedOpen: snoozedExpanded.get(),
        workingOpen: workingExpanded.get(),
        working: readSection(context, CHAT_SECTION, ChatSettings).workingSection,
        current: routeThreadKey(navigation.current()),
        drop: optimistic.get(),
      });

      /**
       * What the list shows: the threads of the scoped projects by section, a
       * drop under way where it was dropped, the rows of the shelves that show,
       * and the search's matches.
       */
      const listOf = (
        nodes: readonly NodeWithCatalog[],
        nowMs: number,
        state: ReturnType<typeof stateNow>,
      ) => {
        const scopes = projectScopes(nodes);
        // A project that went away no longer narrows the list.
        const scopeKey = scopes.some((item) => item.key === state.scoped)
          ? state.scoped
          : undefined;
        const sections = withDrop(
          sidebarThreads(nodes, {
            nowMs,
            scope: scopeKey,
            working: state.working,
            waiting: (node, thread) => waitingOn(node.target, thread.id),
          }),
          state.drop,
        );
        const { pinned, active, working, snoozed, settled } = sections;
        const current = state.current === undefined ? {} : { current: state.current };
        const { shown, hidden } = shownSettled(settled, {
          count: state.count,
          expanded: state.expanded,
          ...current,
        });
        const shownSnoozed = shownSettled(snoozed, {
          count: snoozed.length,
          expanded: state.snoozedOpen,
          ...current,
        }).shown;
        // Collapsed, the Working section still shows the open thread (T3's routeThreadOnly).
        const shownWorking = shownSettled(working, {
          count: working.length,
          expanded: state.workingOpen,
          ...current,
        }).shown;
        const all = [...pinned, ...active, ...working, ...snoozed, ...settled];
        // Title matches first, then the threads found only by their messages (T3's order).
        const titled: SearchEntry[] = searchSidebarThreads(all, state.query);
        const titledKeys = new Set(titled.map((entry) => entry.key));
        const listed = new Map(all.map((entry) => [entry.key, entry]));
        const byContent =
          state.content.query === contentQuery(state.query)
            ? state.content.matches.flatMap((match): SearchEntry[] => {
                const entry = listed.get(threadKey(match.target, match.threadId));
                return entry === undefined || titledKeys.has(entry.key)
                  ? []
                  : [{ ...entry, match }];
              })
            : [];
        const results = [...titled, ...byContent];
        return {
          scopes,
          scopeKey,
          pinned,
          active,
          working,
          snoozed,
          settled,
          shown,
          shownWorking,
          shownSnoozed,
          hidden,
          results,
          /** The rows in the list's order, as the shortcuts count them. */
          rows: [...pinned, ...active, ...shownWorking, ...shownSnoozed, ...shown],
        };
      };

      /** The sections with a drop under way already applied, as T3 shows a drop at once. */
      const withDrop = (
        sections: Record<ThreadSection, Entry[]>,
        drop: OptimisticDrop | undefined,
      ) => {
        if (drop === undefined) return sections;
        const all = [
          ...sections.pinned,
          ...sections.active,
          ...sections.working,
          ...sections.snoozed,
          ...sections.settled,
        ];
        const moved = all.find((entry) => entry.key === drop.key);
        if (moved === undefined) return sections;
        const without = (list: Entry[]) => list.filter((entry) => entry.key !== drop.key);
        const next = {
          pinned: without(sections.pinned),
          active: without(sections.active),
          working: without(sections.working),
          snoozed: without(sections.snoozed),
          settled: without(sections.settled),
        };
        const entry = { ...moved, section: drop.section };
        if (drop.section === "settled") {
          next.settled.unshift(entry);
          return next;
        }
        const list = [...next[drop.section], entry];
        const order = drop.order;
        next[drop.section] =
          order === undefined
            ? list
            : list.toSorted(
                (a, b) =>
                  (order.indexOf(a.key) + 1 || Number.MAX_SAFE_INTEGER) -
                  (order.indexOf(b.key) + 1 || Number.MAX_SAFE_INTEGER),
              );
        return next;
      };

      /** The details T3 shows when the pointer rests on a thread (SidebarThreadTooltip). */
      function ThreadDetails({
        entry,
        hosts,
        active,
      }: {
        entry: Entry;
        hosts: boolean;
        active: boolean;
      }) {
        const { thread, project, node } = entry;
        const agentId = thread.agentId ?? thread.lastTurn?.agentId;
        return (
          <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
            <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
              {thread.title}
            </div>
            <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
              {project === undefined ? null : (
                <div className="flex min-w-0 items-center gap-2">
                  <ProjectIcon className="size-3 shrink-0" project={project} />
                  <div className="min-w-0 truncate text-foreground/75">{project.name}</div>
                </div>
              )}
              {hosts ? (
                <div className="flex min-w-0 items-center gap-2">
                  <NodeIcon
                    className="size-3 shrink-0 stroke-muted-foreground"
                    machines={machines}
                    target={node.target}
                  />
                  <div className="min-w-0 truncate text-foreground/75">{node.label}</div>
                </div>
              ) : null}
              <Slot
                name={THREAD_DETAILS_SLOT}
                props={
                  {
                    target: node.target,
                    thread,
                    ...(project === undefined ? {} : { project }),
                    active,
                  } satisfies ThreadIndicatorProps
                }
              />
              {agentId === undefined ? null : (
                <div className="flex min-w-0 items-center gap-2">
                  <AgentIcon agentId={agentId} className="size-3 shrink-0 opacity-60 grayscale" />
                  <div className="min-w-0 truncate text-foreground/75">
                    {thread.model ?? agentId}
                  </div>
                </div>
              )}
              {thread.lastTurn?.status === "failed" ? (
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-2",
                    isUsageLimited(thread) ? "text-warning" : "text-error",
                  )}
                >
                  <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
                  <div className="min-w-0 truncate">
                    {isUsageLimited(thread) ? "Usage limit reached" : "Error occurred"}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        );
      }

      // T3's sweep (D455): pressing a row's Settle, Un-settle or Wake button and dragging over the
      // rows of its section does the same to each of them on release.
      type SweepAction = "settle" | "unsettle" | "unsnooze";
      const SWEEP_VERB: Record<SweepAction, DropVerb> = {
        settle: "settle",
        unsettle: "unsettle",
        unsnooze: "wake",
      };
      const SWEEP_COMMAND: Record<SweepAction, string> = {
        settle: "thread.settle",
        unsettle: "thread.unsettle",
        unsnooze: "thread.unsnooze",
      };
      const sweep = createValue<
        | {
            readonly action: SweepAction;
            readonly section: ThreadSection;
            readonly origin: string;
            readonly startY: number;
            /** Past the drag distance: a sweep, not a click. */
            readonly active: boolean;
            readonly keys: readonly string[];
          }
        | undefined
      >(undefined);
      /** The button's click after a sweep that ended on it does nothing more. */
      let sweptClick = false;
      const onSweepMove = (event: PointerEvent) => {
        const current = sweep.get();
        if (current === undefined) return;
        if (!current.active && Math.abs(event.clientY - current.startY) <= SWEEP_DISTANCE) return;
        const over = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest("[data-thread-item]")
          ?.getAttribute("data-thread-item");
        const rows = orderedThreads()
          .filter((entry) => entry.section === current.section)
          .map((entry) => entry.key);
        const from = rows.indexOf(current.origin);
        const to = over == null ? -1 : rows.indexOf(over);
        const keys =
          from === -1 || to === -1
            ? current.keys
            : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
        sweep.set({ ...current, active: true, keys });
      };
      const endSweep = () => {
        window.removeEventListener("pointermove", onSweepMove);
        window.removeEventListener("pointerup", onSweepUp);
        window.removeEventListener("pointercancel", cancelSweep);
      };
      const cancelSweep = () => {
        endSweep();
        sweep.set(undefined);
      };
      const onSweepUp = () => {
        const done = sweep.get();
        cancelSweep();
        if (done === undefined || !done.active) return;
        // The click that may follow this release on the button; none comes when it ended elsewhere.
        sweptClick = true;
        setTimeout(() => {
          sweptClick = false;
        }, 0);
        const every = everyThread();
        void (async () => {
          for (const key of done.keys) {
            const entry = every.get(key);
            if (entry === undefined) continue;
            await context.commands
              .execute(SWEEP_COMMAND[done.action], {
                ...entry.node.target,
                threadId: entry.thread.id,
              })
              .catch((error: unknown) =>
                toasts?.show({
                  type: "error",
                  title: "Could not do that",
                  description: (error as Error).message,
                }),
              );
          }
        })();
      };
      context.subscriptions.add({ dispose: cancelSweep });
      /** A row's Settle, Un-settle or Wake button: a click on its row, or the start of a sweep. */
      const sweepable = (entry: Entry, action: SweepAction, perform: () => void) => ({
        onClick: (event: { preventDefault(): void; stopPropagation(): void }) => {
          event.preventDefault();
          event.stopPropagation();
          if (sweptClick) {
            sweptClick = false;
            return;
          }
          perform();
        },
        onDoubleClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
        onPointerDown: (event: { stopPropagation(): void; clientY: number; button: number }) => {
          event.stopPropagation();
          if (event.button !== 0) return;
          sweptClick = false;
          cancelSweep();
          sweep.set({
            action,
            section: entry.section,
            origin: entry.key,
            startY: event.clientY,
            active: false,
            keys: [entry.key],
          });
          window.addEventListener("pointermove", onSweepMove);
          window.addEventListener("pointerup", onSweepUp);
          window.addEventListener("pointercancel", cancelSweep);
        },
      });

      /** Keeps a click on a row's button from opening, renaming or dragging the row. */
      const inRow = (action: () => void) => ({
        onClick: (event: { preventDefault(): void; stopPropagation(): void }) => {
          event.preventDefault();
          event.stopPropagation();
          action();
        },
        onDoubleClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
        onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
      });

      /** T3's snooze button on a card: its presets and "Custom…" (SnoozeMenuButton). */
      function SnoozeMenu(props: {
        target: NodeTarget;
        threadId: string;
        open: boolean;
        onOpenChange(open: boolean): void;
      }) {
        const ref = { ...props.target, threadId: props.threadId };
        const presets = props.open ? snoozePresets(new Date()) : [];
        return (
          <Menu onOpenChange={props.onOpenChange} open={props.open}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <button
                        aria-label="Snooze thread"
                        className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        type="button"
                      />
                    }
                  />
                }
              >
                <ClockIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup>Snooze thread</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" side="bottom">
              {presets.map((preset) => (
                <MenuItem
                  key={preset.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    run("thread.snooze", { ...ref, until: preset.snoozedUntil });
                  }}
                >
                  {preset.label}
                  <MenuShortcut>{preset.whenLabel}</MenuShortcut>
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  run("thread.snooze", ref);
                }}
              >
                Custom…
              </MenuItem>
            </MenuPopup>
          </Menu>
        );
      }

      /**
       * One thread: a card among the pinned and active threads, a slim row on
       * the Snoozed and Settled shelves (T3's SidebarThreadRow). A card offers
       * Snooze and Settle while the pointer rests on it; a slim row Wake or
       * Un-settle. Its context menu is the `thread.actions` slot; a double
       * click renames it in place; it can be dragged to another place or section.
       */
      function ThreadRow(props: {
        entry: Entry;
        active: boolean;
        /** Whether rows name their node: the sidebar shows several. */
        hosts: boolean;
        now: number;
        sortable?: SortableBag | undefined;
        /** While this row is dragged: what dropping it would do. */
        verb?: DropVerb | null | undefined;
        /** Dropped here, while the nodes are told: the row is busy until they have it. */
        busy?: boolean | undefined;
        /** The shortcut that opens this row, shown while its modifiers are held (D453). */
        jumpLabel?: string | undefined;
      }) {
        const { entry, active, hosts, now, sortable } = props;
        const { thread, project, node, section } = entry;
        const variant =
          section === "pinned" || section === "active" || section === "working" ? "card" : "slim";
        const target = node.target;
        const ref = { ...target, threadId: thread.id };
        const seen = useExternal(visitStore, visitStore.snapshot);
        const [renaming, setRenaming] = useState<string | undefined>();
        const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
        const committed = useRef(false);
        useExternal(workVersion, workVersion.get);
        const status = sidebarThreadStatus(
          thread,
          waitingOn(target, thread.id),
          pendingSubagentRequests(node.catalog.threads).get(thread.id),
        );
        // The node's record wins: it is what every device saw (D485).
        const lastVisit = lastVisitOf(thread, seen[visitKey(target, thread.id)]);
        const unread = isUnread(thread, lastVisit);
        const woke = isWoke(thread, lastVisit, now);
        const top = sidebarTopStatus(status, unread, woke, thread.goalStatus === "active");
        const isSelected = useExternal(selection, () => selection.get().keys.includes(entry.key));
        const swept = useExternal(sweep, () => {
          const current = sweep.get();
          return current?.active === true && current.keys.includes(entry.key)
            ? current.action
            : undefined;
        });
        // Threads that went away meanwhile do not count.
        const selectionSize = useExternal(selection, () => (isSelected ? selected().length : 0));
        // T3's unsent draft: kept by the chat plugin, never shown on the open thread (D963).
        const hasDraft = useExternal(
          drafts ?? NO_DRAFTS,
          () => !active && drafts?.hasThreadDraft(target, thread.id) === true,
        );
        const recede = shouldRecede({ status, unread, active, woke }) && !isSelected;
        const retitling = thread.titleRegeneration !== undefined;
        const settled = section === "settled";
        const snoozed = section === "snoozed";
        const dragging = sortable?.isDragging === true;
        const agentId = thread.agentId ?? thread.lastTurn?.agentId;
        // T3 names a scratch thread's machine on its last line instead of a branch.
        const showsScratchNode = hosts && project?.scratch === true;
        const label = rowLabel(
          [thread.title, top === null ? null : TOP_STATUS[top].label, project?.name],
          hosts ? node.label : undefined,
        );
        const showSnooze = variant === "card" && canSnooze(thread);
        // A menu stays open only while its button shows.
        const menuOpen = snoozeMenuOpen && showSnooze;

        const startRename = () => {
          committed.current = false;
          setRenaming(thread.title);
        };
        const commit = () => {
          if (renaming === undefined) return;
          const title = renaming;
          setRenaming(undefined);
          if (title.trim() !== thread.title) {
            run("thread.rename", { ...target, threadId: thread.id, title });
          }
        };
        const onKeyDown = (event: ReactKeyboardEvent) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openThread(target, thread.id);
          } else if (event.key === "F2") {
            event.preventDefault();
            startRename();
          }
        };
        /** Clears "Woke" by visiting the thread as of when it woke (T3's acknowledge). */
        const acknowledgeWoke = () => {
          const at = wokeAt(thread, now);
          if (at !== undefined) visits?.visit(target, thread.id, at);
        };

        const title =
          renaming !== undefined ? (
            <input
              aria-label="Thread title"
              autoFocus
              className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
              onBlur={() => {
                if (!committed.current) commit();
              }}
              onChange={(event) => setRenaming(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  committed.current = true;
                  commit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  committed.current = true;
                  setRenaming(undefined);
                }
              }}
              value={renaming}
            />
          ) : (
            <span
              aria-hidden
              className={cn(
                "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
                recede ? "font-normal" : "font-medium",
                variant === "card"
                  ? cn(
                      "truncate",
                      recede
                        ? "text-secondary-label"
                        : unread || woke || status === "input"
                          ? "text-foreground"
                          : status === "failed" || status === "limited"
                            ? "text-foreground/95"
                            : "text-foreground/90",
                    )
                  : cn(
                      "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                      recede
                        ? "text-secondary-label/70"
                        : active || woke || status === "input"
                          ? "text-foreground"
                          : unread
                            ? "text-muted-foreground"
                            : "text-secondary-label/70",
                    ),
                // T3's faded title while an agent writes a new one (D1176).
                retitling && "opacity-55",
              )}
              data-thread-title
            >
              {thread.title}
            </span>
          );

        const rowClassName = cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          settled && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
          active || dragging
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : isSelected || swept !== undefined
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : hasDraft
                ? "bg-warning/4 text-sidebar-foreground hover:bg-warning/8"
                : recede
                  ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          dragging && "shadow-lg ring-1 ring-sidebar-border",
          recede &&
            status === "working" &&
            "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
          variant === "slim" && "flex h-9 items-center gap-2.5 px-2.5",
        );

        /** What dropping the dragged row, or a sweep over it, would do, in place of its time. */
        const shownVerb = dragging
          ? props.verb
          : swept === undefined
            ? undefined
            : SWEEP_VERB[swept];
        const destination =
          shownVerb !== null && shownVerb !== undefined
            ? (() => {
                const { label: verbLabel, icon: Icon } = DROP_VERB[shownVerb];
                return (
                  <span
                    className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
                    role="status"
                  >
                    <Icon aria-hidden className="size-3" />
                    {verbLabel}
                  </span>
                );
              })()
            : null;

        // T3 hides the pin while the row is dragged elsewhere.
        const pin =
          thread.pinnedAt === undefined || (dragging && props.verb !== null) ? null : dragging ? (
            <PinIcon
              aria-label="Pinned"
              className="size-3 shrink-0 text-muted-foreground/65"
              role="img"
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="Unpin thread"
                    className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    {...inRow(() => run("thread.unpin", ref))}
                  />
                }
              >
                <PinIcon
                  aria-hidden
                  className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
                />
                <PinOffIcon
                  aria-hidden
                  className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
                />
              </TooltipTrigger>
              <TooltipPopup>Unpin thread</TooltipPopup>
            </Tooltip>
          );

        /** "Woke", a button that dismisses it (T3's Dismiss Woke notification). */
        const wokeStatus = (className: string, iconClassName: string) =>
          visits === undefined ? (
            <TopStatus kind="woke" startedAt={undefined} />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="Dismiss Woke notification"
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      className,
                    )}
                    type="button"
                    {...inRow(acknowledgeWoke)}
                  />
                }
              >
                <AlarmClockIcon aria-hidden className={iconClassName} />
                <span role="status">Woke</span>
              </TooltipTrigger>
              <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
            </Tooltip>
          );

        /** A slim row's action at its right end, shown while the pointer rests on the row. */
        const slimAction = (
          labelText: string,
          icon: ReactNode,
          action: () => void,
          sweepAction: SweepAction,
        ) => (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={labelText}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                    woke && "group-any-hover/sidebar-row:static",
                  )}
                  type="button"
                  {...sweepable(entry, sweepAction, action)}
                />
              }
            >
              {icon}
            </TooltipTrigger>
            <TooltipPopup side="top">{labelText}</TooltipPopup>
          </Tooltip>
        );

        const draftIndicator = hasDraft ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label="Unsent draft"
                  className="inline-flex shrink-0 items-center"
                  role="img"
                />
              }
            >
              <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
            </TooltipTrigger>
            <TooltipPopup side="top">Unsent draft</TooltipPopup>
          </Tooltip>
        ) : null;

        const body =
          variant === "slim" ? (
            <>
              <span className="sr-only">{thread.title}</span>
              {retitling ? (
                <span className="sr-only" role="status">
                  Regenerating title
                </span>
              ) : null}
              <span
                className={cn(
                  "flex shrink-0 items-center transition-opacity",
                  (!active || settled) &&
                    "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
                )}
              >
                {project === undefined ? null : (
                  <ProjectIcon className="size-4" project={project} />
                )}
              </span>
              {draftIndicator}
              {title}
              {pin}
              {dragging || swept !== undefined ? (
                destination
              ) : (
                <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end gap-1">
                  <span
                    className={cn(
                      "inline-flex justify-end text-secondary-label tabular-nums transition-opacity",
                      !woke && "group-any-hover/sidebar-row:opacity-0",
                    )}
                  >
                    {snoozed && thread.snoozedUntil !== undefined ? (
                      <span className="text-xs text-info-foreground tabular-nums">
                        {snoozeWakeLabel(thread.snoozedUntil, now)}
                      </span>
                    ) : woke ? (
                      wokeStatus("text-xs text-warning-foreground", "size-3")
                    ) : (
                      <span className="text-xs">
                        {formatCompactRelativeTime(
                          entry.settledAt ?? threadActivityAt(thread),
                          now,
                        )}
                      </span>
                    )}
                  </span>
                  {snoozed
                    ? slimAction(
                        "Wake thread now",
                        <AlarmClockOffIcon className="mb-px size-3" />,
                        () => run("thread.unsnooze", ref),
                        "unsnooze",
                      )
                    : settled
                      ? slimAction(
                          "Un-settle thread",
                          <Undo2Icon className="mb-px size-3.5" />,
                          () => run("thread.unsettle", ref),
                          "unsettle",
                        )
                      : null}
                  {hosts ? (
                    <HostIcon
                      className="text-sidebar-muted-foreground/70 [&>svg]:size-3"
                      label={node.label}
                      machines={machines}
                      target={node.target}
                    />
                  ) : null}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="sr-only">{thread.title}</span>
              {retitling ? (
                <span className="sr-only" role="status">
                  Regenerating title
                </span>
              ) : null}
              <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
                <div className="flex h-5 min-w-0 items-center gap-1.5">
                  {draftIndicator}
                  {project === undefined ? null : (
                    <ProjectIcon className="size-4 shrink-0" project={project} />
                  )}
                  {project === undefined ? (
                    <span className="flex-1" />
                  ) : (
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-secondary-label text-xs",
                        recede ? "font-normal" : "font-medium",
                      )}
                    >
                      {project.name}
                    </span>
                  )}
                  {pin}
                  {dragging || swept !== undefined ? (
                    destination
                  ) : (
                    <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
                      <span
                        className={cn(
                          top === "woke"
                            ? "pointer-events-auto"
                            : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                          "flex items-center self-center justify-self-end text-secondary-label tabular-nums transition-opacity",
                          menuOpen && "pointer-events-none absolute right-0 opacity-0",
                        )}
                      >
                        {top === null ? (
                          formatCompactRelativeTime(threadActivityAt(thread), now)
                        ) : top === "woke" ? (
                          wokeStatus(TOP_STATUS.woke.className, "size-4 shrink-0")
                        ) : (
                          <TopStatus kind={top} startedAt={thread.lastTurn?.at} />
                        )}
                      </span>
                      <span
                        className={cn(
                          // focus-visible, not focus-within: a clicked Settle keeps focus,
                          // and the controls would stay over the status once the pointer left.
                          "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
                          menuOpen && "pointer-events-auto static opacity-100",
                        )}
                      >
                        {hasDraft ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  aria-label="Discard draft"
                                  className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    run("chat.draft.discard", { ...target, threadId: thread.id });
                                  }}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  type="button"
                                />
                              }
                            >
                              <XIcon className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipPopup side="top">Discard draft</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        {showSnooze ? (
                          <SnoozeMenu
                            onOpenChange={setSnoozeMenuOpen}
                            open={menuOpen}
                            target={target}
                            threadId={thread.id}
                          />
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                aria-label="Settle thread"
                                className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                type="button"
                                {...sweepable(entry, "settle", () => run("thread.settle", ref))}
                              />
                            }
                          >
                            <CheckIcon className="size-3.5" />
                            Settle
                          </TooltipTrigger>
                          <TooltipPopup>Settle thread</TooltipPopup>
                        </Tooltip>
                      </span>
                    </span>
                  )}
                </div>
                <div className="mt-1 flex min-w-0">{title}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
                  {/* T3's branch, terminal, pull request and diff: contributions, right-aligned
                      unless one of them (the branch) takes the free width. */}
                  <span
                    className="flex min-w-0 flex-1 items-center justify-end gap-1.5"
                    data-thread-indicators
                  >
                    {showsScratchNode ? (
                      <>
                        <NodeIcon
                          className="size-3 shrink-0 text-muted-foreground/40"
                          machines={machines}
                          target={node.target}
                        />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
                          {node.label}
                        </span>
                      </>
                    ) : null}
                    <Slot
                      name="sidebar.thread.indicators"
                      props={
                        {
                          target,
                          thread,
                          ...(project === undefined ? {} : { project }),
                          active,
                        } satisfies ThreadIndicatorProps
                      }
                    />
                  </span>
                  <span className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1">
                    {hosts ? (
                      <HostIcon
                        className={cn(
                          "text-sidebar-muted-foreground/70",
                          // Named on the line already: the icon stays for finding it.
                          showsScratchNode && "sr-only",
                        )}
                        label={node.label}
                        machines={machines}
                        target={node.target}
                      />
                    ) : null}
                    {agentId === undefined ? null : (
                      <span aria-hidden className="inline-flex shrink-0 items-center">
                        <AgentIcon agentId={agentId} className="size-3.5 opacity-60" />
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </>
          );

        return (
          <li
            className={cn(
              "list-none",
              variant === "card" &&
                "py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
              variant === "slim" && "[content-visibility:auto] [contain-intrinsic-size:auto_36px]",
              dragging && "relative z-20",
            )}
            data-thread-item={entry.key}
            ref={sortable?.setNodeRef}
            style={
              sortable === undefined
                ? undefined
                : {
                    transform: CSS.Translate.toString(sortable.transform),
                    transition: sortable.transition,
                  }
            }
            {...sortable?.listeners}
          >
            <ContextMenu>
              <Tooltip disabled={dragging || menuOpen}>
                <TooltipTrigger
                  render={
                    <ContextMenuTrigger
                      render={
                        <div
                          aria-busy={props.busy === true || retitling ? true : undefined}
                          aria-current={active ? "page" : undefined}
                          aria-label={label}
                          className={rowClassName}
                          data-active={active}
                          data-section={section}
                          data-selected={isSelected ? "" : undefined}
                          data-testid={variant === "card" ? "sidebar-row-card" : "sidebar-row-slim"}
                          onClick={(event) => {
                            if (renaming === undefined)
                              clickRow(event, entry.key, () => openThread(target, thread.id));
                          }}
                          onDoubleClick={(event) => {
                            if (
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey ||
                              renaming !== undefined
                            ) {
                              return;
                            }
                            event.preventDefault();
                            startRename();
                          }}
                          onKeyDown={onKeyDown}
                          role="button"
                          tabIndex={0}
                        />
                      }
                    />
                  }
                >
                  {props.jumpLabel === undefined ? null : (
                    // T3's JumpHintBadge.
                    <span
                      aria-hidden
                      className="pointer-events-none absolute top-1/2 right-1.5 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
                      data-jump-hint
                    >
                      {props.jumpLabel}
                    </span>
                  )}
                  {body}
                </TooltipTrigger>
                <TooltipPopup
                  align="start"
                  className="max-w-80 text-left whitespace-normal"
                  side="right"
                  sideOffset={4}
                  variant="glass"
                >
                  <ThreadDetails active={active} entry={entry} hosts={hosts} />
                </TooltipPopup>
              </Tooltip>
              <ContextMenuPopup>
                {isSelected && selectionSize > 1 ? (
                  <SelectionMenu />
                ) : (
                  <Slot
                    name="thread.actions"
                    props={
                      {
                        target,
                        thread,
                        ...(project === undefined ? {} : { project }),
                        rename: startRename,
                        section,
                      } satisfies ThreadActionProps
                    }
                  />
                )}
              </ContextMenuPopup>
            </ContextMenu>
          </li>
        );
      }

      /** A row that can be dragged to another place or section (T3's SortableThreadRow). */
      function SortableThreadRow(props: {
        entry: Entry;
        active: boolean;
        hosts: boolean;
        now: number;
        disabled: boolean;
        busy: boolean;
        jumpLabel?: string | undefined;
      }) {
        const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
          id: props.entry.key,
          // Working rows stay where their turn put them (T3): dragging moves nothing there.
          disabled: props.disabled || props.entry.section === "working",
          animateLayoutChanges,
        });
        const drag = useExternal(dragState, dragState.get);
        const verb = drag?.key === props.entry.key ? dropVerb(drag.from, drag.over) : undefined;
        return (
          <ThreadRow
            active={props.active}
            busy={props.busy}
            entry={props.entry}
            jumpLabel={props.jumpLabel}
            hosts={props.hosts}
            // Keyed by variant, so a card that becomes a slim row is a new row.
            key={
              props.entry.section === "pinned" ||
              props.entry.section === "active" ||
              props.entry.section === "working"
                ? "card"
                : "slim"
            }
            now={props.now}
            sortable={{ listeners, setNodeRef, transform, transition, isDragging }}
            verb={verb}
          />
        );
      }

      /** A marker between the sections, in place while rows move (T3's SortableSidebarMarker). */
      function SortableMarker(props: {
        marker: SidebarListMarker;
        className?: string;
        children?: ReactNode;
      }) {
        const { setNodeRef, transform, transition } = useSortable({
          id: markerId(props.marker),
          disabled: { draggable: true },
          animateLayoutChanges,
        });
        return (
          <li
            className={cn("list-none", props.className)}
            data-testid={`sidebar-${props.marker}`}
            ref={setNodeRef}
            style={{
              transform: CSS.Translate.toString(transform),
              transition: props.marker.endsWith("-placeholder") ? "none" : transition,
            }}
          >
            {props.children}
          </li>
        );
      }

      function TopStatus({
        kind,
        startedAt,
      }: {
        kind: SidebarTopStatus;
        startedAt: string | undefined;
      }) {
        const { label, className, icon: Icon } = TOP_STATUS[kind];
        return (
          <span className={cn("inline-flex items-center gap-1 font-medium", className)}>
            <Icon className="size-4 shrink-0" />
            {/* The label alone is the live region, not the ticking duration. */}
            <span role="status">{label}</span>
            {(kind === "working" || kind === "goal") && startedAt !== undefined ? (
              <span aria-hidden>
                <WorkingDuration startedAt={startedAt} />
              </span>
            ) : null}
          </span>
        );
      }

      /** The new thread being written, before its first message (T3's SidebarDraftRow). */
      function DraftRow({
        node,
        projectId,
        hosts,
      }: {
        node: NodeWithCatalog;
        projectId: string;
        hosts: boolean;
      }) {
        const project = node.catalog.projects.find((item) => item.id === projectId);
        return (
          <li className="list-none py-0.5">
            <div
              aria-current="page"
              aria-label={rowLabel(
                ["New thread", "Unsent draft", project?.name],
                hosts ? node.label : undefined,
              )}
              className="group/sidebar-row relative w-full overflow-hidden rounded-md bg-sidebar-row-active text-left text-sidebar-foreground select-none"
              data-testid="sidebar-draft-row"
              role="button"
              tabIndex={0}
            >
              <span className="sr-only">New thread</span>
              <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
                <div className="flex h-5 min-w-0 items-center gap-1.5">
                  <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
                  {project === undefined ? null : (
                    <ProjectIcon className="size-4 shrink-0" project={project} />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
                    {project?.name}
                  </span>
                  {/* T3's discard button, shown while the pointer rests on the card (D451). */}
                  <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            aria-label="Discard draft"
                            className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                            onKeyDown={(event) => event.stopPropagation()}
                            type="button"
                            {...inRow(() =>
                              run("chat.draft.discard", { ...node.target, projectId }),
                            )}
                          />
                        }
                      >
                        <XIcon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Discard draft</TooltipPopup>
                    </Tooltip>
                  </span>
                </div>
                <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
                  New thread
                </div>
              </div>
            </div>
          </li>
        );
      }

      /** One search result (T3's SidebarSearchResultRow). */
      function SearchResult(props: {
        entry: SearchEntry;
        query: string;
        index: number;
        highlighted: boolean;
        active: boolean;
        now: number;
        hosts: boolean;
      }) {
        const { entry, highlighted, active, now } = props;
        const settled = entry.settledAt !== undefined;
        return (
          <li className="list-none" role="presentation">
            <button
              aria-current={active ? "page" : undefined}
              aria-label={rowLabel(
                [entry.thread.title, entry.project?.name],
                props.hosts ? entry.node.label : undefined,
              )}
              aria-selected={highlighted}
              className={cn(
                "group/sidebar-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                highlighted || active
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
              id={`sidebar-thread-search-result-${props.index}`}
              onClick={() => {
                search.set("");
                openThread(entry.node.target, entry.thread.id);
              }}
              onMouseMove={() => highlight.set(props.index)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              {entry.project === undefined ? null : (
                <ProjectIcon
                  className={cn(
                    "size-4 shrink-0 transition-opacity",
                    settled &&
                      !active &&
                      !highlighted &&
                      "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
                  )}
                  project={entry.project}
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      settled
                        ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                        : "font-medium text-foreground",
                      (highlighted || active) && "text-foreground",
                    )}
                  >
                    {entry.thread.title}
                  </span>
                  <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                    {formatCompactRelativeTime(threadActivityAt(entry.thread), now)}
                  </span>
                </span>
                {entry.match === undefined ? null : (
                  <SearchMatchExcerpt match={entry.match} query={props.query} />
                )}
              </span>
            </button>
          </li>
        );
      }

      /**
       * Connections that are not open and nodes whose catalog failed, above the
       * threads: T3 Code's LocalSecondaryStatus (LegacySidebar.tsx) for every node.
       */
      function NodeStatus({ nodes }: { nodes: readonly NodeWithCatalog[] }) {
        const connecting = nodes.filter((node) => node.state === "connecting");
        const closed = nodes.filter((node) => node.state === "closed");
        const failed = nodes.filter(
          (node) => node.state === "open" && node.catalog.status === "error",
        );
        if (connecting.length + closed.length + failed.length === 0) return null;
        const labels = (list: readonly NodeWithCatalog[]) =>
          list.map((node) => node.label).join(", ");
        return (
          <SidebarGroup aria-label="Nodes" className="gap-1.5 py-0" role="group">
            {connecting.length > 0 ? (
              <Alert variant="sidebar">
                <ConnectionDot state="connecting" />
                <AlertTitle>Connecting {labels(connecting)}</AlertTitle>
              </Alert>
            ) : null}
            {closed.length > 0 ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>Couldn't connect {labels(closed)}</AlertTitle>
                <AlertDescription>The node didn't answer.</AlertDescription>
              </Alert>
            ) : null}
            {failed.length > 0 ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>Couldn't load {labels(failed)}</AlertTitle>
                <AlertDescription>
                  {failed.map((node) => node.catalog.error ?? "Cannot reach this node").join("; ")}
                </AlertDescription>
              </Alert>
            ) : null}
          </SidebarGroup>
        );
      }

      /** The project filter of the header (T3's project scope combobox). */
      function ProjectScope({
        nodes,
        hosts,
      }: {
        nodes: readonly NodeWithCatalog[];
        hosts: boolean;
      }) {
        const scoped = useExternal(scope, scope.get);
        const scopes = projectScopes(nodes);
        const items = [
          { value: "", label: "All projects" },
          ...scopes.map((item) => ({ value: item.key, label: item.project.name })),
        ];
        const current = scopes.find((item) => item.key === scoped);
        return (
          <Combobox
            autoHighlight
            isItemEqualToValue={(a, b) => a.value === b.value}
            itemToStringLabel={(item) => item.label}
            items={items}
            onValueChange={(item) => {
              if (item !== null) scope.set(item.value);
            }}
            value={items.find((item) => item.value === (current?.key ?? "")) ?? items[0]!}
          >
            <ComboboxTrigger
              render={
                <SidebarHeaderIconButton
                  label={
                    current === undefined
                      ? "Filter threads by project"
                      : `Filter threads by project: ${rowLabel([current.project.name], hosts ? current.node.label : undefined)}`
                  }
                />
              }
            >
              {current === undefined ? (
                <ListFilterIcon className="size-4" />
              ) : (
                <span className="flex shrink-0">
                  <ProjectIcon className="size-4" project={current.project} />
                </span>
              )}
            </ComboboxTrigger>
            <ComboboxPopup
              align="start"
              className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
            >
              <ComboboxSearchInput aria-label="Search projects" placeholder="Search projects..." />
              <ComboboxEmpty>No matching projects.</ComboboxEmpty>
              <ComboboxList>
                {(item: (typeof items)[number]) => {
                  const choice = scopes.find((entry) => entry.key === item.value);
                  return (
                    <ComboboxItem hideIndicator key={item.value} value={item}>
                      {choice === undefined ? (
                        <FolderIcon className="size-4 shrink-0" />
                      ) : (
                        <ProjectIcon className="size-4 shrink-0" project={choice.project} />
                      )}
                      <span className="ml-2 min-w-0 flex-1 truncate text-sm">{item.label}</span>
                      {/* T3 marks a project of another environment; here its node is named. */}
                      {choice !== undefined && hosts ? (
                        <span className="ml-2 inline-flex max-w-28 shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <NodeIcon
                            className="size-3 shrink-0"
                            machines={machines}
                            target={choice.node.target}
                          />
                          <span className="truncate">{choice.node.label}</span>
                        </span>
                      ) : null}
                    </ComboboxItem>
                  );
                }}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
        );
      }

      // The node menu's own items (settings → Nodes renders the menu): what the node's
      // sidebar section offered, then the connections plugin's `node.*` commands.
      const nodeItems: [string, number, ComponentType<NodeActionProps>][] = [
        [
          "new-thread",
          1,
          ({ connection }) => (
            <MenuItem
              disabled={connection.state !== "open"}
              onClick={() => run("chat.new-without-project", { node: connection.id })}
            >
              <MessageSquareDashedIcon />
              New thread without a project
            </MenuItem>
          ),
        ],
        [
          "add-project",
          2,
          ({ connection }) => (
            <MenuItem
              disabled={connection.state !== "open"}
              onClick={() => run("project.add", { node: connection.id })}
            >
              <FolderPlusIcon />
              Add project
            </MenuItem>
          ),
        ],
        ["separator-new", 5, () => <MenuSeparator />],
        [
          "rename",
          10,
          ({ connection }) => (
            <MenuItem
              onClick={() =>
                void dialogs
                  ?.prompt({
                    title: "Rename node",
                    description: "The name this device shows for the node.",
                    label: "Node name",
                    value: connection.label,
                    confirmLabel: "Rename",
                    validate: (value) => (value.trim() === "" ? "A node needs a name" : undefined),
                  })
                  .then((label) => {
                    if (label !== undefined) run("node.rename", { node: connection.id, label });
                  })
              }
            >
              <PencilIcon />
              Rename on this device
            </MenuItem>
          ),
        ],
        [
          "copy-address",
          20,
          ({ connection }) => (
            <MenuItem
              onClick={() =>
                void context.commands.execute("node.copy-address", { node: connection.id }).then(
                  () => toasts?.show({ type: "success", title: "Address copied", timeout: 1500 }),
                  (error: unknown) =>
                    toasts?.show({
                      type: "error",
                      title: "Could not copy",
                      description: (error as Error).message,
                    }),
                )
              }
            >
              <CopyIcon />
              Copy address
            </MenuItem>
          ),
        ],
        ["separator", 30, () => <MenuSeparator />],
        [
          "disconnect",
          40,
          ({ connection }) => (
            <MenuItem
              onClick={() =>
                void (
                  dialogs === undefined
                    ? Promise.resolve(true)
                    : dialogs.confirm({
                        title: `Disconnect ${connection.label}?`,
                        description:
                          "This device forgets the node and its token. The node keeps running.",
                        confirmLabel: "Disconnect",
                        variant: "destructive",
                      })
                ).then((confirmed) => {
                  if (!confirmed) return;
                  const { node, panel, section } = navigation.current();
                  run("node.disconnect", { node: connection.id });
                  // Away from the node's thread; the open panel (settings) stays.
                  if (node === connection.id)
                    navigation.navigate({
                      ...(panel === undefined ? {} : { panel }),
                      ...(section === undefined ? {} : { section }),
                    });
                })
              }
              variant="destructive"
            >
              <XIcon />
              Disconnect
            </MenuItem>
          ),
        ],
      ];
      for (const [id, order, component] of nodeItems) {
        context.subscriptions.add(
          slots.contribute("node.actions", { id: `jhin.sidebar.node.${id}`, order, component }),
        );
      }

      /** The current place's node and project, for "New thread" and "Add project". */
      const currentPlace = (): { target: NodeTarget; projectId?: string } | undefined => {
        const route = navigation.current();
        const target = targetOf(route);
        const nodes = connections.list();
        if (target !== undefined && nodes.some((node) => node.id === target.node)) {
          if (route.project !== undefined) return { target, projectId: route.project };
          if (route.thread !== undefined) {
            const thread = threads.catalog(target).threads.find((item) => item.id === route.thread);
            return { target, ...(thread === undefined ? {} : { projectId: thread.projectId }) };
          }
          return { target };
        }
        const first = nodes.find((node) => node.state === "open") ?? nodes[0];
        return first === undefined ? undefined : { target: { node: first.id } };
      };
      /** The scratch project of a node, once its catalog is loaded. */
      const scratchIn = (target: NodeTarget) =>
        threads.catalog(target).projects.find((project) => project.scratch)?.id;
      /** Waits of "New thread" for a catalog; they end, empty-handed, with the plugin. */
      const waits = new Set<() => void>();
      context.subscriptions.add({
        dispose: () => {
          for (const end of Array.from(waits)) end();
        },
      });
      /**
       * The scratch project of a node, waiting for its catalog while it loads: "New thread"
       * right after the connection opens starts the draft once the projects are there.
       */
      const scratchOnceLoaded = (target: NodeTarget) =>
        new Promise<string | undefined>((resolve) => {
          if (threads.catalog(target).status !== "loading") {
            resolve(scratchIn(target));
            return;
          }
          const end = (projectId?: string) => {
            waits.delete(end);
            subscription.dispose();
            resolve(projectId);
          };
          const subscription = threads.subscribe(target, () => {
            if (threads.catalog(target).status !== "loading") end(scratchIn(target));
          });
          waits.add(end);
        });

      const failure = (message: string, code: string) =>
        Object.assign(new Error(message), { code });

      /** A connection that is open, or a reachable member of an open connection's mesh. */
      const isOpen = (target: NodeTarget): boolean => {
        if (connections.get(target.node)?.state !== "open") return false;
        return (
          target.remote === undefined ||
          (mesh.members(target.node) ?? []).some(
            (member) => !member.self && member.reachable && member.nodeId === target.remote,
          )
        );
      };

      /**
       * Where a command's `{ node?, remote? }` points: the named node, which must
       * be shown and open, else an error says why; without a node, the current
       * place when its node is open, else nothing (the command does nothing).
       */
      const placeOf = (input: {
        node?: string | undefined;
        remote?: string | undefined;
      }): { target: NodeTarget; projectId?: string } | undefined => {
        if (input.node === undefined) {
          const place = currentPlace();
          return place !== undefined && isOpen(place.target) ? place : undefined;
        }
        const target: NodeTarget = {
          node: input.node,
          ...(input.remote === undefined ? {} : { remote: input.remote }),
        };
        if (connections.get(input.node) === undefined) {
          throw failure(`Not connected to ${input.node}`, "NODE_NOT_FOUND");
        }
        if (!isOpen(target)) {
          throw failure(
            input.remote === undefined
              ? `${input.node} is not connected now`
              : `${input.remote} is not reachable through ${input.node}`,
            "NODE_UNAVAILABLE",
          );
        }
        return { target };
      };

      /** A node named by a command: `remote` is a member of `node`'s mesh, so it needs `node`. */
      const NodeInput = z
        .object({ node: z.string().optional(), remote: z.string().optional() })
        .refine((input) => input.remote === undefined || input.node !== undefined, {
          message: "remote needs node: the connection whose mesh reaches it",
          path: ["remote"],
        });

      /** The thread list, or the search's results while a search is typed (T3's sidebar body). */
      function ThreadList({ nodes, hosts }: { nodes: readonly NodeWithCatalog[]; hosts: boolean }) {
        const route = useExternal(navigation, navigation.current);
        const query = useExternal(search, search.get);
        const expanded = useExternal(settledExpanded, settledExpanded.get);
        const snoozedOpen = useExternal(snoozedExpanded, snoozedExpanded.get);
        const workingOpen = useExternal(workingExpanded, workingExpanded.get);
        const hints = useExternal(jumpHints, jumpHints.get);
        const working = useSection(context, CHAT_SECTION, ChatSettings).workingSection;
        const count = useExternal(settledCount, settledCount.get);
        const scoped = useExternal(scope, scope.get);
        const highlighted = useExternal(highlight, highlight.get);
        const drop = useExternal(optimistic, optimistic.get);
        const drag = useExternal(dragState, dragState.get);
        const now = useExternal(clock, clock.get);
        useExternal(workVersion, workVersion.get);
        const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
        const current = routeThreadKey(route);
        const content = useExternal(contentSearch, contentSearch.get);
        // The open nodes search their threads' messages while a query is typed.
        const searchable = nodes.filter((node) => node.state === "open").map((node) => node.target);
        const searchableKey = searchable.map(targetKey).join(" ");
        useEffect(() => contentSearch.request(query, searchable), [query, searchableKey]);
        const list = listOf(nodes, now, {
          query,
          content,
          scoped,
          count,
          expanded,
          snoozedOpen,
          workingOpen,
          working,
          current,
          drop,
        });
        const routeTarget = targetOf(route);
        // The list changes as soon as the first snoozed thread's time comes, not a minute later.
        const nextWake = list.snoozed[0]?.thread.snoozedUntil;
        useEffect(() => {
          clock.wakeAt(nextWake === undefined ? undefined : Date.parse(nextWake));
        }, [nextWake]);
        // Threads that changed are drawn as of now: one snoozed "in 1 hour" reads 1h, not
        // the minute-old time's 2h. Commands see the same time.
        useEffect(() => clock.refresh(), [nodes]);

        // One detector per drag, so its sticky side survives the renders a drag causes
        // (T3 builds one per render; a re-render would forget the side). It is made at the
        // drag's first collision, from what that render showed.
        const latestDrag = useRef<{
          drag: DragState | undefined;
          items: readonly SidebarListItem[];
          changesSomething: (state: DragState, id: string) => boolean;
        }>({ drag: undefined, items: [], changesSomething: () => false });
        const dragKey = drag?.key;
        const collisionDetection = useMemo((): CollisionDetection => {
          let detect: CollisionDetection | undefined;
          return (args) => {
            if (detect === undefined) {
              const { drag: started, items: shown } = latestDrag.current;
              detect =
                started === undefined || started.key !== dragKey
                  ? createSidebarCollisionDetection(() => true)
                  : createSidebarCollisionDetection(
                      (id) => latestDrag.current.changesSomething(started, id),
                      { items: shown, activationY: started.activationY },
                    );
            }
            return detect(args);
          };
        }, [dragKey]);

        if (query.trim() !== "") {
          return list.results.length > 0 ? (
            <ul
              aria-label="Thread search results"
              className="flex flex-col gap-px"
              id="sidebar-thread-search-results"
              role="listbox"
            >
              {list.results.map((entry, index) => (
                <SearchResult
                  query={query}
                  active={entry.key === current}
                  entry={entry}
                  hosts={hosts}
                  highlighted={index === Math.min(highlighted, list.results.length - 1)}
                  index={index}
                  key={entry.key}
                  now={now}
                />
              ))}
            </ul>
          ) : (
            <p
              className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              role="status"
            >
              {emptySearchLabel(content, query)}
            </p>
          );
        }

        const draftNode =
          routeTarget !== undefined && route.thread === undefined && route.project !== undefined
            ? nodes.find(
                (node) =>
                  node.target.node === routeTarget.node &&
                  node.target.remote === routeTarget.remote,
              )
            : undefined;
        const drafting =
          draftNode !== undefined &&
          (list.scopeKey === undefined ||
            list.scopeKey === projectKey(draftNode.target, route.project!));
        const loading = nodes.some(
          (node) => node.state === "open" && node.catalog.status === "loading",
        );
        const total =
          list.pinned.length + list.active.length + list.snoozed.length + list.settled.length;
        const scopedProject = list.scopes.find((item) => item.key === list.scopeKey)?.project;
        const anyProject = nodes.some((node) =>
          node.catalog.projects.some((project) => !project.scratch),
        );
        const keys = (entries: readonly Entry[]) => entries.map((entry) => entry.key);
        const items: SidebarListItem[] =
          total === 0
            ? []
            : sidebarListItems({
                pinned: keys(list.pinned),
                active: keys(list.active),
                working: list.working.length === 0 ? undefined : keys(list.shownWorking),
                snoozed: list.snoozed.length === 0 ? undefined : keys(list.shownSnoozed),
                settled: keys(list.shown),
              });
        const entries = new Map(
          [
            ...list.pinned,
            ...list.active,
            ...list.shownWorking,
            ...list.shownSnoozed,
            ...list.shown,
          ].map((entry) => [entry.key, entry]),
        );
        const from = drag?.from;
        const over = drag?.over ?? null;

        const onDragStart = (event: DragStartEvent) => {
          const entry = entries.get(String(event.active.id));
          if (entry !== undefined) {
            const activator = event.activatorEvent as Partial<PointerEvent> | null;
            dragState.set({
              key: entry.key,
              from: entry.section,
              over: null,
              activationY: typeof activator?.clientY === "number" ? activator.clientY : null,
            });
          }
        };
        const onDragOver = (event: DragOverEvent) => {
          const state = dragState.get();
          if (state === undefined) return;
          const target =
            event.over === null ? null : resolveDropTarget(items, state.key, String(event.over.id));
          dragState.set({ ...state, over: target?.section ?? null });
        };
        const onDragEnd = (event: DragEndEvent) => {
          dragState.set(undefined);
          const entry = entries.get(String(event.active.id));
          if (entry === undefined || event.over === null) return;
          const target = resolveDropTarget(items, entry.key, String(event.over.id));
          if (target === null) return;
          const order =
            target.section === "pinned"
              ? target.pinnedOrder
              : target.section === "active"
                ? target.activeOrder
                : undefined;
          // The move says itself what failed (T3's titles): a drop onto the shelf runs
          // thread.settle, whose own failure toasts "Failed to settle thread".
          void context.commands
            .execute("sidebar.thread.move", {
              ...entry.node.target,
              threadId: entry.thread.id,
              section: target.section,
              ...(order === undefined ? {} : { index: order.indexOf(entry.key) }),
            })
            .catch(() => undefined);
        };

        /** Whether dropping the dragged row over `id` would do anything (T3's isValidTarget). */
        const changesSomething = (state: DragState, id: string) => {
          const target = resolveDropTarget(items, state.key, id);
          if (target === null) return false;
          const every = everyThread();
          const keysOf = (pick: (item: Entry) => string | undefined) =>
            new Map([...every.values()].map((item) => [item.key, pick(item)]));
          return (
            planDrop({
              key: state.key,
              from: state.from,
              target,
              pinnedOrder: keys(list.pinned),
              activeOrder: keys(list.active),
              pinnedKeysById: keysOf((item) => item.thread.pinOrderKey),
              activeKeysById: keysOf((item) => item.thread.activeOrderKey),
              activeTimeOrdered: readSection(context, CHAT_SECTION, ChatSettings).workingSection,
            }).kind !== "none"
          );
        };
        latestDrag.current = { drag, items, changesSomething };

        // The first nine rows' numbers, while the jump modifiers are held (T3's jump hints).
        const jumps = new Map(list.rows.slice(0, 9).map((entry, index) => [entry.key, index + 1]));
        const jumpLabelOf = (key: string) => {
          const jump = hints ? jumps.get(key) : undefined;
          return jump === undefined
            ? undefined
            : keybindings?.labelFor(`sidebar.thread.jump.${jump}`);
        };
        const row = (entry: Entry) => (
          <SortableThreadRow
            active={entry.key === current}
            busy={drop?.key === entry.key}
            disabled={drop !== undefined}
            jumpLabel={jumpLabelOf(entry.key)}
            entry={entry}
            hosts={hosts}
            key={entry.key}
            now={now}
          />
        );
        /** A boundary of the pinned threads, named while a row is dragged (T3's SidebarDragBoundary). */
        const boundary = (marker: "pinned-header" | "pinned-divider", text: string) => {
          const targeted = over === (marker === "pinned-header" ? "pinned" : "active");
          return (
            <SortableMarker
              className="pointer-events-none relative mx-0.5 -mb-px h-0"
              key={marker}
              marker={marker}
            >
              {drag === undefined ? null : (
                <div
                  className={cn(
                    DRAG_BOUNDARY_LABEL_CLASS,
                    "absolute inset-x-2 top-1 flex h-4 items-center gap-2",
                  )}
                >
                  <span
                    className={cn(
                      "shrink-0 text-xs font-medium",
                      targeted ? "text-primary" : "text-sidebar-foreground/80",
                    )}
                  >
                    {text}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "h-px flex-1",
                      targeted ? "bg-primary/50" : "bg-sidebar-foreground/25",
                    )}
                  />
                </div>
              )}
            </SortableMarker>
          );
        };
        /** Where to drop into an empty section (T3's SidebarSectionPlaceholder). */
        const placeholder = (
          marker: "active-placeholder" | "settled-placeholder",
          text: string,
          shown: number,
          section: DropSection,
        ) => (
          <SortableMarker className="relative mx-0.5 -mb-px h-0" key={marker} marker={marker}>
            {from !== undefined &&
            (shown === 0 ||
              (from === section && shown === 1 && over !== null && over !== section)) ? (
              <div
                className={cn(
                  "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
                  over === section && "border-primary/40 bg-primary/5 text-primary",
                )}
              >
                {text}
              </div>
            ) : null}
          </SortableMarker>
        );

        const rendered = items.map((item) => {
          if (item.kind === "thread") {
            const entry = entries.get(item.key);
            return entry === undefined ? null : row(entry);
          }
          switch (item.marker) {
            case "pinned-header":
              return boundary("pinned-header", "Pinned");
            case "pinned-divider":
              return boundary("pinned-divider", "Active");
            case "active-placeholder":
              return placeholder("active-placeholder", "Active", list.active.length, "active");
            case "working-header":
              // T3's Working section: below the inbox, pushing the shelves down.
              return (
                <SortableMarker
                  className="mx-0.5 mt-auto h-8"
                  key={item.marker}
                  marker={item.marker}
                >
                  <SectionHeaderButton
                    expanded={workingOpen}
                    label={workingOpen ? "Working" : `Working (${list.working.length})`}
                    onToggle={() => workingExpanded.set(!workingOpen)}
                    tone="muted"
                  />
                </SortableMarker>
              );
            case "snoozed-header":
              return (
                <SortableMarker
                  className={cn("mx-0.5 h-8", list.working.length === 0 && "mt-auto")}
                  key={item.marker}
                  marker={item.marker}
                >
                  <SectionHeaderButton
                    expanded={snoozedOpen}
                    label={snoozedOpen ? "Snoozed" : `Snoozed (${list.snoozed.length})`}
                    onToggle={() => snoozedExpanded.set(!snoozedOpen)}
                    tone="info"
                  />
                </SortableMarker>
              );
            case "settled-header":
              return (
                <SortableMarker
                  className={cn(
                    "mx-0.5 h-8",
                    list.working.length === 0 && list.snoozed.length === 0 && "mt-auto",
                  )}
                  key={item.marker}
                  marker={item.marker}
                >
                  <SectionHeaderButton
                    expanded={expanded}
                    label={expanded ? "Settled" : `Settled (${list.settled.length})`}
                    onToggle={() => settledExpanded.set(!expanded)}
                    tone={
                      over === "settled" ? "accent" : drag !== undefined ? "emphasized" : "muted"
                    }
                  />
                </SortableMarker>
              );
            case "settled-placeholder":
              return placeholder("settled-placeholder", "Settled", list.shown.length, "settled");
          }
        });

        return (
          <>
            {total === 0 && !drafting && loading ? (
              <div aria-hidden className="flex flex-col gap-1.5 px-2 py-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : null}
            <DndContext
              collisionDetection={collisionDetection}
              onDragCancel={() => dragState.set(undefined)}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDragStart={onDragStart}
              sensors={sensors}
            >
              <SortableContext items={items.map(itemId)} strategy={verticalListSortingStrategy}>
                {/* Presentational, as in T3: a list is an interaction boundary for VoiceOver. */}
                <ul
                  className={cn(
                    "relative flex flex-col gap-px",
                    (total > 0 || drafting) && "flex-1",
                  )}
                  role="presentation"
                >
                  {drafting ? (
                    <DraftRow hosts={hosts} node={draftNode} projectId={route.project!} />
                  ) : null}
                  {rendered}
                  {expanded && list.hidden > 0 ? (
                    <li className="list-none">
                      <button
                        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        onClick={() =>
                          settledCount.set(settledCount.get() + SETTLED_TAIL_PAGE_COUNT)
                        }
                        type="button"
                      >
                        <PlusIcon aria-hidden className="size-4 shrink-0" />
                        Show {Math.min(list.hidden, SETTLED_TAIL_PAGE_COUNT)} more
                      </button>
                    </li>
                  ) : null}
                </ul>
              </SortableContext>
            </DndContext>
            {total === 0 && !drafting && !loading && nodes.some((node) => node.state === "open") ? (
              <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                {!anyProject ? (
                  <>
                    <span>No projects yet</span>
                    <button
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      onClick={() => void context.commands.execute("project.add", {})}
                      type="button"
                    >
                      <PlusIcon className="-mx-0.5 size-3" />
                      Add project
                    </button>
                  </>
                ) : scopedProject !== undefined ? (
                  `No threads in ${scopedProject.name} yet`
                ) : (
                  "No threads yet"
                )}
              </div>
            ) : null}
          </>
        );
      }

      /** Arrow keys walk the search results, Enter opens one, Escape clears (T3's search keys). */
      const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
          search.set("");
          return;
        }
        if (search.get().trim() === "") return;
        const { results } = listOf(nodeView.snapshot(), clock.now(), stateNow());
        if (results.length === 0) return;
        const index = Math.min(highlight.get(), results.length - 1);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          highlight.set(Math.min(index + 1, results.length - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          highlight.set(Math.max(index - 1, 0));
        } else if (event.key === "Enter") {
          event.preventDefault();
          const entry = results[index]!;
          search.set("");
          openThread(entry.node.target, entry.thread.id);
        }
      };

      function SidebarRoot() {
        const nodes = useExternal(nodeView, nodeView.snapshot);
        const anyOpen = nodes.some((node) => node.state === "open");
        const hosts = showsHosts(nodes);
        const query = useExternal(search, search.get);
        const highlighted = useExternal(highlight, highlight.get);
        const shortcut = useShortcutLabels(keybindings);
        const searching = query.trim() !== "";
        const newThreadLabel =
          shortcut("chat.new") === undefined
            ? "New thread"
            : `New thread (${shortcut("chat.new")})`;
        return (
          <>
            <div className="drag-region relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3">
              <div className="relative z-10 ml-[calc(var(--workspace-controls-left)+1px)] flex shrink-0 items-center md:hidden">
                <SidebarTrigger
                  aria-label="Toggle main sidebar"
                  className="relative top-auto translate-y-0"
                  variant="ghost"
                />
              </div>
              <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
                <button
                  aria-label="Go to threads"
                  className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 cursor-pointer items-center overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex"
                  onClick={() => navigation.navigate({})}
                  type="button"
                >
                  <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
                    <span className="font-semibold">Jhin</span>
                  </span>
                </button>
              </div>
              <div
                aria-label="Sidebar actions"
                className="flex shrink-0 items-center gap-0.5"
                role="toolbar"
              >
                <Slot name="sidebar.actions" />
              </div>
            </div>
            <SidebarContent
              className="min-h-full"
              fixedHeader={
                <SidebarGroup className="z-[1]">
                  <div className="flex items-center gap-1">
                    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                      <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                      <SidebarInput
                        aria-activedescendant={
                          searching ? `sidebar-thread-search-result-${highlighted}` : undefined
                        }
                        aria-autocomplete="list"
                        aria-controls={searching ? "sidebar-thread-search-results" : undefined}
                        aria-expanded={searching}
                        aria-label="Search threads"
                        className="min-w-0 flex-1"
                        onChange={(event) => search.set(event.target.value)}
                        onKeyDown={onSearchKeyDown}
                        placeholder="Search"
                        role="combobox"
                        type="search"
                        value={query}
                      />
                      {searching ? (
                        <Button
                          aria-label="Clear thread search"
                          className="shrink-0"
                          onClick={() => search.set("")}
                          size="icon-micro"
                          variant="ghost-muted"
                        >
                          <XIcon className="size-3" />
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center">
                      {anyOpen ? (
                        <>
                          <ProjectScope hosts={hosts} nodes={nodes} />
                          <SidebarHeaderIconButton
                            label="Add project"
                            onClick={() => void context.commands.execute("project.add", {})}
                            tooltip={
                              shortcut("project.add") === undefined
                                ? "Add project"
                                : `Add project (${shortcut("project.add")})`
                            }
                          >
                            <FolderPlusIcon />
                          </SidebarHeaderIconButton>
                        </>
                      ) : null}
                      <SidebarHeaderIconButton
                        disabled={!anyOpen}
                        label="New thread"
                        onClick={() => void context.commands.execute("chat.new", {})}
                        tooltip={newThreadLabel}
                      >
                        <SquarePenIcon />
                      </SidebarHeaderIconButton>
                    </div>
                  </div>
                </SidebarGroup>
              }
            >
              <SidebarGroup className="flex-1" role="presentation">
                {nodes.length === 0 ? (
                  <p className="px-2 py-4 text-center text-xs text-sidebar-muted-foreground/70">
                    No node connected.
                  </p>
                ) : (
                  <>
                    <NodeStatus nodes={nodes} />
                    <ThreadList hosts={hosts} nodes={nodes} />
                  </>
                )}
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              {/* T3's footer starts with its undo notice: here any plugin's notes. */}
              <Slot name={SIDEBAR_NOTICES_SLOT} />
              {/* T3's footer: its utility items on the left. */}
              <SidebarMenu className="flex-row items-center">
                <SidebarMenuItem className="shrink-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuButton
                          aria-label="Settings"
                          onClick={() => void context.commands.execute("settings.open", {})}
                          size="icon"
                        />
                      }
                    >
                      <SettingsIcon />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      Settings
                      {shortcut("settings.open") === undefined
                        ? ""
                        : ` (${shortcut("settings.open")})`}
                    </TooltipPopup>
                  </Tooltip>
                </SidebarMenuItem>
                <Slot name="sidebar.footer" />
                <SidebarMenuItem className="ms-auto shrink-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          aria-label="Command palette"
                          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-2xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
                          onClick={() => void context.commands.execute("palette.toggle", {})}
                          type="button"
                        />
                      }
                    >
                      <Kbd>{shortcut("palette.toggle") ?? "⌘K"}</Kbd>
                    </TooltipTrigger>
                    <TooltipPopup side="top">Command palette</TooltipPopup>
                  </Tooltip>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          </>
        );
      }

      /** Mounted in `app.global`: it opens wherever the request comes from, sidebar shown or not. */
      function AddProject() {
        return (
          <AddProjectDialog
            connections={connections}
            machines={machines}
            navigation={navigation}
            nodes={nodeView}
            requests={addProjectRequests}
            threads={threads}
            toasts={toasts}
          />
        );
      }

      function AddNode() {
        const route = useExternal(navigation, navigation.current);
        return (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Add node"
                  onClick={() => navigation.navigate({ ...route, panel: "connect" })}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Add node</TooltipPopup>
          </Tooltip>
        );
      }

      // --- Commands ------------------------------------------------------------
      /**
       * The threads the sidebar shows, in its order and as of the time it is
       * drawn with: the search's results, else its rows.
       */
      const orderedThreads = (): Entry[] => {
        const list = listOf(nodeView.snapshot(), clock.now(), stateNow());
        return search.get().trim() !== "" ? list.results : list.rows;
      };
      const step = (delta: number) => {
        const list = orderedThreads();
        if (list.length === 0) return;
        const current = routeThreadKey(navigation.current());
        const index = list.findIndex((entry) => entry.key === current);
        const next =
          index < 0
            ? delta > 0
              ? list[0]
              : list.at(-1)
            : list[Math.min(list.length - 1, Math.max(0, index + delta))];
        if (next !== undefined) openThread(next.node.target, next.thread.id);
      };
      context.commands.register({
        name: "sidebar.thread.previous",
        title: "Previous thread",
        description: "Opens the thread above the current one in the sidebar",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          step(-1);
          return {};
        },
      });
      context.commands.register({
        name: "sidebar.thread.next",
        title: "Next thread",
        description: "Opens the thread below the current one in the sidebar",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          step(1);
          return {};
        },
      });
      for (let jump = 1; jump <= 9; jump += 1) {
        context.commands.register({
          name: `sidebar.thread.jump.${jump}`,
          description: `Opens the sidebar's thread number ${jump}`,
          input: z.object({}),
          output: z.object({}),
          handler: () => {
            const entry = orderedThreads()[jump - 1];
            if (entry !== undefined) openThread(entry.node.target, entry.thread.id);
            return {};
          },
        });
      }
      // --- Settling, pinning and snoozing from the sidebar (D75–D78) ------------
      const actions = threadActions({
        context,
        threads,
        navigation,
        mesh,
        toasts,
        dialogs,
        visits,
      });
      /** Every thread the sidebar can show, of every project, by key, as of its clock. */
      const everyThread = () => {
        const list = listOf(nodeView.snapshot(), clock.now(), {
          ...stateNow(),
          scoped: "",
          drop: undefined,
        });
        return new Map(
          [...list.pinned, ...list.active, ...list.snoozed, ...list.settled].map((entry) => [
            entry.key,
            entry,
          ]),
        );
      };
      /** The open thread as the sidebar lists it. */
      const openEntry = () => {
        const key = routeThreadKey(navigation.current());
        return key === undefined ? undefined : everyThread().get(key);
      };
      /**
       * Where to go when the open thread leaves the cards (T3's settle-and-advance):
       * the next card below it, else above it, else a new thread in its project.
       */
      const forwardFrom = (key: string): (() => void) | undefined => {
        if (routeThreadKey(navigation.current()) !== key) return undefined;
        const rows = orderedThreads();
        const index = rows.findIndex((entry) => entry.key === key);
        const card = (entry: Entry) =>
          entry.key !== key && (entry.section === "pinned" || entry.section === "active");
        const next =
          index === -1 ? undefined : [...rows.slice(index + 1), ...rows.slice(0, index)].find(card);
        if (next !== undefined) return () => openThread(next.node.target, next.thread.id);
        const self = rows[index] ?? everyThread().get(key);
        return self === undefined
          ? () => navigation.navigate({})
          : () => newThread(self.node.target, self.thread.projectId);
      };
      context.subscriptions.add(
        context.hooks.around<ThreadParkInput, boolean>(THREAD_PARK_HOOK, async (input, next) => {
          const key = threadKey(input.target, input.threadId);
          const forward = forwardFrom(key);
          const parked = await next(input);
          if (parked && forward !== undefined && routeThreadKey(navigation.current()) === key) {
            forward();
          }
          return parked;
        }),
      );
      /** Settles a thread through `thread.park`, so the open one moves on. */
      const settle = (entry: Entry) =>
        context.hooks.run<ThreadParkInput, boolean>(
          THREAD_PARK_HOOK,
          { target: entry.node.target, threadId: entry.thread.id, action: "settle" },
          () =>
            actions.arrange(
              entry.node.target,
              entry.thread,
              { method: "settle" },
              "Failed to settle thread",
            ),
        );

      context.commands.register({
        name: "sidebar.thread.toggle-settled",
        title: "Settle or un-settle thread",
        description:
          "Settles the open thread and opens the next one, or brings it back when it is settled",
        input: z.object({}),
        output: z.object({}),
        handler: async () => {
          const entry = openEntry();
          if (entry === undefined) return {};
          if (entry.section === "settled") {
            await actions.arrange(
              entry.node.target,
              entry.thread,
              { method: "unsettle" },
              "Failed to un-settle thread",
            );
          } else {
            await settle(entry);
          }
          return {};
        },
      });
      context.commands.register({
        name: "sidebar.thread.toggle-pinned",
        title: "Pin or unpin thread",
        description: "Pins the open thread, or unpins it when it is pinned",
        input: z.object({}),
        output: z.object({}),
        handler: async () => {
          const entry = openEntry();
          if (entry === undefined) return {};
          await (entry.thread.pinnedAt === undefined
            ? actions.arrange(
                entry.node.target,
                entry.thread,
                { method: "pin" },
                "Failed to pin thread",
              )
            : actions.unpin(entry.node.target, entry.thread));
          return {};
        },
      });

      context.commands.register({
        name: "sidebar.thread.move",
        title: "Move thread",
        description:
          "Moves a thread to the pinned, active or settled threads, at `index` among the section's shown threads (pinning, unpinning, settling, un-settling or waking it), as dropping it there does",
        input: z.object({
          node: z.string(),
          remote: z.string().optional(),
          threadId: z.string(),
          section: z.enum(["pinned", "active", "settled"]),
          index: z.number().int().nonnegative().optional(),
        }),
        output: z.object({}),
        handler: async (input) => {
          const target: NodeTarget = {
            node: input.node,
            ...(input.remote === undefined ? {} : { remote: input.remote }),
          };
          const key = threadKey(target, input.threadId);
          const every = everyThread();
          const entry = every.get(key);
          if (entry === undefined) {
            throw failure(`No thread ${input.threadId} in the sidebar`, "THREAD_NOT_FOUND");
          }
          const list = listOf(nodeView.snapshot(), clock.now(), { ...stateNow(), drop: undefined });
          const shownKeys = (entries: readonly Entry[]) =>
            entries.map((item) => item.key).filter((item) => item !== key);
          const place = (keys: string[], section: DropSection) => {
            if (input.section === section)
              keys.splice(Math.min(input.index ?? keys.length, keys.length), 0, key);
            return keys;
          };
          const pinnedOrder = place(shownKeys(list.pinned), "pinned");
          const activeOrder = place(shownKeys(list.active), "active");
          const keysOf = (pick: (entry: Entry) => string | undefined) =>
            new Map([...every.values()].map((item) => [item.key, pick(item)]));
          const plan =
            input.index === undefined && input.section !== "settled"
              ? input.section === entry.section
                ? ({ kind: "none" } as const)
                : input.section === "pinned"
                  ? ({ kind: "pin", orderKey: undefined, assignments: [] } as const)
                  : ({
                      kind: "move-active",
                      assignments: [],
                      unpin: entry.section === "pinned",
                      unsettle: entry.section === "settled",
                      unsnooze: entry.section === "snoozed",
                    } as const)
              : planDrop({
                  key,
                  from: entry.section,
                  target: { section: input.section, pinnedOrder, activeOrder },
                  pinnedOrder: list.pinned.map((item) => item.key),
                  activeOrder: list.active.map((item) => item.key),
                  pinnedKeysById: keysOf((item) => item.thread.pinOrderKey),
                  activeKeysById: keysOf((item) => item.thread.activeOrderKey),
                  activeTimeOrdered: readSection(context, CHAT_SECTION, ChatSettings)
                    .workingSection,
                });
          if (plan.kind === "none") return {};
          // One write per node the drop touches (D449): its steps go as one `threads.arrange`.
          type Step = { op: string; threadId: string } & Record<string, unknown>;
          const steps = new Map<string, { target: NodeTarget; steps: Step[] }>();
          const addStep = (item: Entry, op: string, rest: Record<string, unknown> = {}) => {
            const node = targetKey(item.node.target);
            const forNode = steps.get(node) ?? { target: item.node.target, steps: [] };
            forNode.steps.push({ op, threadId: item.thread.id, ...rest });
            steps.set(node, forNode);
          };
          const reorder = (assignments: readonly OrderAssignment[], into: "pinned" | "active") => {
            for (const assignment of assignments) {
              const item = every.get(assignment.id);
              if (item !== undefined)
                addStep(item, "reorder", { list: into, orderKey: assignment.orderKey });
            }
          };
          // T3's failure titles, by what the drop does to the thread.
          let failedTitle = "Failed to settle thread";
          switch (plan.kind) {
            case "pin":
              addStep(entry, "pin", plan.orderKey === undefined ? {} : { orderKey: plan.orderKey });
              reorder(plan.assignments, "pinned");
              failedTitle = "Failed to pin thread";
              break;
            case "reorder-pinned":
              reorder(plan.assignments, "pinned");
              failedTitle = "Failed to reorder pinned threads";
              break;
            case "move-active":
              if (plan.unsnooze) addStep(entry, "unsnooze");
              if (plan.unpin) addStep(entry, "unpin");
              if (plan.unsettle) addStep(entry, "unsettle");
              reorder(plan.assignments, "active");
              failedTitle = plan.unsnooze
                ? "Failed to wake thread"
                : plan.unpin
                  ? "Failed to unpin thread"
                  : plan.unsettle
                    ? "Failed to un-settle thread"
                    : "Failed to reorder active threads";
              break;
          }
          // The dropped thread's node first: its write is the drop, the others' only order.
          const writes = [...steps.values()].toSorted(
            (a, b) =>
              Number(targetKey(b.target) === targetKey(target)) -
              Number(targetKey(a.target) === targetKey(target)),
          );
          // Shown where it was dropped until the nodes have it (T3's optimistic drop).
          const drop: OptimisticDrop = {
            key,
            section: input.section,
            order:
              input.index === undefined
                ? undefined
                : input.section === "pinned"
                  ? pinnedOrder
                  : input.section === "active"
                    ? activeOrder
                    : undefined,
          };
          optimistic.set(drop);
          const writeAll = async () => {
            for (const write of writes)
              await threads.call(write.target, "threads.arrange", { steps: write.steps });
            return true;
          };
          try {
            // T3's drop runs the same actions as the buttons, with their undo (D964).
            if (plan.kind === "settle") {
              if (hasCommand("thread.settle"))
                await context.commands.execute("thread.settle", refOf(entry));
              else await settle(entry);
            } else if (plan.kind === "move-active" && plan.unpin && undo !== undefined) {
              // A pinned thread is neither settled nor snoozed: unpinning is all this drop does to it.
              const orderKey = entry.thread.pinOrderKey;
              await undo.run({
                kind: "pin",
                key: visitKey(entry.node.target, entry.thread.id),
                action: "Unpinned",
                noun: "thread",
                failureTitle: "Failed to undo unpin",
                perform: writeAll,
                revert: () =>
                  threads.call(entry.node.target, "threads.pin", {
                    threadId: entry.thread.id,
                    ...(orderKey === undefined ? {} : { orderKey }),
                  }),
              });
            } else await writeAll();
          } catch (error) {
            if (plan.kind !== "settle")
              toasts?.show({
                type: "error",
                title: failedTitle,
                description: (error as Error).message,
              });
            throw error;
          } finally {
            if (optimistic.get() === drop) optimistic.set(undefined);
          }
          return {};
        },
      });
      context.commands.register({
        name: "project.add",
        title: "Add project",
        description:
          "Opens the dialog that adds a folder of a node as a project: the given node, or the current one",
        input: NodeInput,
        output: z.object({}),
        handler: (input) => {
          const place = placeOf(input);
          if (place !== undefined) addProjectRequests.open(place.target);
          return {};
        },
      });
      context.commands.register({
        name: "chat.new",
        title: "New thread",
        description: "Starts a new thread in the current project",
        input: z.object({}),
        output: z.object({}),
        handler: async () => {
          const place = placeOf({});
          if (place === undefined) return {};
          const projectId = place.projectId ?? (await scratchOnceLoaded(place.target));
          if (projectId !== undefined) newThread(place.target, projectId);
          return {};
        },
      });
      context.commands.register({
        name: "chat.new-without-project",
        title: "New thread without a project",
        description:
          "Starts a new thread in a node's scratch project: the given node, or the current one",
        input: NodeInput,
        output: z.object({}),
        handler: (input) => {
          const place = placeOf(input);
          if (place === undefined) return {};
          const scratch = scratchIn(place.target);
          if (scratch !== undefined) newThread(place.target, scratch);
          else if (input.node !== undefined) {
            throw failure(
              `The projects of ${input.remote ?? input.node} are not loaded yet`,
              "PROJECT_NOT_FOUND",
            );
          }
          return {};
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+shift+[", command: "sidebar.thread.previous" },
            { key: "mod+shift+]", command: "sidebar.thread.next" },
            ...Array.from({ length: 9 }, (_, index) => ({
              key: `mod+${index + 1}`,
              command: `sidebar.thread.jump.${index + 1}`,
            })),
            { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
            { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
            { key: "mod+alt+n", command: "chat.new-without-project", when: "!terminalFocus" },
            {
              key: "mod+shift+s",
              command: "sidebar.thread.toggle-settled",
              when: "!terminalFocus",
            },
            { key: "mod+shift+p", command: "sidebar.thread.toggle-pinned", when: "!terminalFocus" },
          ]),
        );
      }

      context.subscriptions.add(
        slots.contribute("app.sidebar", { id: "jhin.sidebar.nodes", component: SidebarRoot }),
      );
      context.subscriptions.add(
        slots.contribute("app.global", { id: "jhin.sidebar.add-project", component: AddProject }),
      );
      context.subscriptions.add(
        slots.contribute("sidebar.actions", {
          id: "jhin.sidebar.add-node",
          order: -10,
          component: AddNode,
        }),
      );
    },
  }),
);
