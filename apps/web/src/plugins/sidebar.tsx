// The design follows T3 Code's sidebar (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/Sidebar.tsx (thread cards, the Settled shelf, search results),
// sidebar/SidebarThreadHeader.tsx, sidebar/SidebarChrome.tsx, ThreadHoverCard.tsx,
// ui/collapsible-section-header.tsx, EnvironmentMachineIcon.tsx and, for the node alerts,
// LegacySidebar.tsx (LocalSecondaryStatus).
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type Connections,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeConnection,
  type NodeTarget,
  type ThreadsCatalog,
  VISITS_CAPABILITY,
  visitKey,
  type ThreadVisits,
  type NodeActionProps,
  type ThreadActionProps,
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
  MenuItem,
  MenuSeparator,
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
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  MessageSquareDashedIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
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
import { formatCompactRelativeTime } from "../lib/format.ts";
import { useExternal, useNow, useShortcutLabels } from "../lib/hooks.ts";
import { createShownNodes, showsHosts, type NodeWithCatalog } from "../lib/nodes.ts";
import { ProjectIcon } from "../lib/project-icon.tsx";
import {
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  formatWorkingDurationLabel,
  isUnread,
  projectKey,
  projectScopes,
  searchSidebarThreads,
  shouldRecede,
  shownSettled,
  sidebarThreadStatus,
  sidebarThreads,
  sidebarTopStatus,
  threadActivityAt,
  threadKey,
  type SidebarThread,
  type SidebarTopStatus,
} from "../lib/sidebar-order.ts";

type Entry = SidebarThread<NodeWithCatalog>;

const SETTLED_EXPANDED_STORAGE_KEY = "jhin.sidebar.settled-expanded";
const PROJECT_SCOPE_STORAGE_KEY = "jhin.sidebar.project-scope";

/** A value of the sidebar that its commands read too (the search, the shelf). */
function createValue<T>(initial: T, storageKey?: string) {
  let value = initial;
  if (storageKey !== undefined) {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) value = JSON.parse(stored) as T;
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

/** Without `client.visits`: nothing was seen, so nothing shows as unread. */
const NO_VISITS: Pick<ThreadVisits, "snapshot" | "subscribe"> = {
  snapshot: () => NO_SEEN,
  subscribe: () => ({ dispose() {} }),
};
const NO_SEEN: Readonly<Record<string, string>> = {};

/**
 * The node a row lives on, while the sidebar shows several: T3 Code marks a
 * thread's environment with its machine icon (EnvironmentMachineIcon, the
 * "server" kind; nodes have no kind to pick yet).
 */
function HostIcon({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-label={`On ${label}`}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      data-host-indicator
      role="img"
    >
      <ServerIcon aria-hidden className="size-3.5" />
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

/** T3's section header with a rule and a chevron (CollapsibleSectionHeader, muted tone). */
function SectionHeader(props: { label: string; expanded: boolean; onToggle(): void }) {
  return (
    <li className="mx-0.5 mt-auto h-8 list-none">
      <button
        aria-expanded={props.expanded}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={props.onToggle}
        type="button"
      >
        <span className="shrink-0">{props.label}</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", !props.expanded && "rotate-180")}
        />
      </button>
    </li>
  );
}

const TOP_STATUS: Record<
  SidebarTopStatus,
  { label: string; className: string; icon: ComponentType<{ className?: string }> }
> = {
  working: { label: "Working", className: "text-info", icon: CircleDashedIcon },
  approval: { label: "Approval", className: "text-warning-foreground", icon: ShieldQuestionIcon },
  input: {
    label: "Input",
    className: "text-indigo-600 dark:text-indigo-300",
    icon: MessageCircleQuestionIcon,
  },
  failed: { label: "Failed", className: "text-error", icon: CircleAlertIcon },
  done: { label: "Done", className: "text-success", icon: CircleCheckIcon },
};

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
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const visits = context.services.tryGet<ThreadVisits>(VISITS_CAPABILITY);
      const search = createValue("");
      const settledExpanded = createValue(false, SETTLED_EXPANDED_STORAGE_KEY);
      /** The project the list is narrowed to (a `projectKey`), or "" for all. */
      const scope = createValue("", PROJECT_SCOPE_STORAGE_KEY);
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
        scoped: scope.get(),
        count: settledCount.get(),
        expanded: settledExpanded.get(),
        current: routeThreadKey(navigation.current()),
      });

      /** What the list shows: the threads of the scoped projects, and the search's matches. */
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
        const { active, settled } = sidebarThreads(nodes, { nowMs, scope: scopeKey });
        const { shown, hidden } = shownSettled(settled, {
          count: state.count,
          expanded: state.expanded,
          ...(state.current === undefined ? {} : { current: state.current }),
        });
        const results = searchSidebarThreads([...active, ...settled], state.query);
        return { scopes, scopeKey, active, settled, shown, hidden, results };
      };

      /** The details T3 shows when the pointer rests on a thread (SidebarThreadTooltip). */
      function ThreadDetails({ entry, hosts }: { entry: Entry; hosts: boolean }) {
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
                  <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
                  <div className="min-w-0 truncate text-foreground/75">{node.label}</div>
                </div>
              ) : null}
              {agentId === undefined ? null : (
                <div className="flex min-w-0 items-center gap-2">
                  <AgentIcon agentId={agentId} className="size-3 shrink-0 opacity-60 grayscale" />
                  <div className="min-w-0 truncate text-foreground/75">
                    {thread.model ?? agentId}
                  </div>
                </div>
              )}
              {thread.lastTurn?.status === "failed" ? (
                <div className="flex min-w-0 items-center gap-2 text-error">
                  <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
                  <div className="min-w-0 truncate">Error occurred</div>
                </div>
              ) : null}
            </div>
          </div>
        );
      }

      /**
       * One thread: a card in the active list, a slim row on the Settled shelf
       * (T3's SidebarThreadRow). Its context menu is the `thread.actions` slot;
       * a double click renames it in place.
       */
      function ThreadRow(props: {
        entry: Entry;
        variant: "card" | "slim";
        active: boolean;
        /** Whether rows name their node: the sidebar shows several. */
        hosts: boolean;
        now: number;
      }) {
        const { entry, variant, active, hosts, now } = props;
        const { thread, project, node } = entry;
        const target = node.target;
        const seen = useExternal(visitStore, visitStore.snapshot);
        const [renaming, setRenaming] = useState<string | undefined>();
        const committed = useRef(false);
        const status = sidebarThreadStatus(thread);
        const unread = isUnread(thread, seen[visitKey(target, thread.id)]);
        const top = sidebarTopStatus(status, unread);
        const recede = shouldRecede({ status, unread, active });
        const settled = variant === "slim";
        const agentId = thread.agentId ?? thread.lastTurn?.agentId;
        // T3 names a scratch thread's machine on its last line instead of a branch.
        const showsScratchNode = hosts && project?.scratch === true;
        const label = [thread.title, top === null ? null : TOP_STATUS[top].label, project?.name]
          .filter(Boolean)
          .join(", ");

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
                        : unread || status === "input"
                          ? "text-foreground"
                          : status === "failed"
                            ? "text-foreground/95"
                            : "text-foreground/90",
                    )
                  : cn(
                      "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                      recede
                        ? "text-secondary-label/70"
                        : active || status === "input"
                          ? "text-foreground"
                          : unread
                            ? "text-muted-foreground"
                            : "text-secondary-label/70",
                    ),
              )}
              data-thread-title
            >
              {thread.title}
            </span>
          );

        const rowClassName = cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          settled && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          recede &&
            status === "working" &&
            "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
          variant === "slim" && "flex h-9 items-center gap-2.5 px-2.5",
        );

        const body =
          variant === "slim" ? (
            <>
              <span className="sr-only">{thread.title}</span>
              <span
                className={cn(
                  "flex shrink-0 items-center transition-opacity",
                  !active &&
                    "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
                )}
              >
                {project === undefined ? null : (
                  <ProjectIcon className="size-4" project={project} />
                )}
              </span>
              {title}
              <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end gap-1">
                <span className="inline-flex justify-end text-secondary-label tabular-nums">
                  <span className="text-xs">
                    {formatCompactRelativeTime(entry.settledAt ?? threadActivityAt(thread), now)}
                  </span>
                </span>
                {hosts ? (
                  <HostIcon
                    className="text-sidebar-muted-foreground/70 [&>svg]:size-3"
                    label={node.label}
                  />
                ) : null}
              </span>
            </>
          ) : (
            <>
              <span className="sr-only">{thread.title}</span>
              <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
                <div className="flex h-5 min-w-0 items-center gap-1.5">
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
                  <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
                    <span className="flex items-center self-center justify-self-end text-secondary-label tabular-nums">
                      {top === null ? (
                        formatCompactRelativeTime(threadActivityAt(thread), now)
                      ) : (
                        <TopStatus kind={top} startedAt={thread.lastTurn?.at} />
                      )}
                    </span>
                  </span>
                </div>
                <div className="mt-1 flex min-w-0">{title}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
                  {showsScratchNode ? (
                    <>
                      <ServerIcon
                        aria-hidden
                        className="size-3 shrink-0 text-muted-foreground/40"
                      />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
                        {node.label}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <span className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1">
                    {hosts ? (
                      <HostIcon
                        className={cn(
                          "text-sidebar-muted-foreground/70",
                          // Named on the line already: the icon stays for finding it.
                          showsScratchNode && "sr-only",
                        )}
                        label={node.label}
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
            )}
            data-thread-item
          >
            <ContextMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ContextMenuTrigger
                      render={
                        <div
                          aria-current={active ? "page" : undefined}
                          aria-label={label}
                          className={rowClassName}
                          data-active={active}
                          data-testid={variant === "card" ? "sidebar-row-card" : "sidebar-row-slim"}
                          onClick={() => {
                            if (renaming === undefined) openThread(target, thread.id);
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
                  {body}
                </TooltipTrigger>
                <TooltipPopup
                  align="start"
                  className="max-w-80 text-left whitespace-normal"
                  side="right"
                  sideOffset={4}
                  variant="glass"
                >
                  <ThreadDetails entry={entry} hosts={hosts} />
                </TooltipPopup>
              </Tooltip>
              <ContextMenuPopup>
                <Slot
                  name="thread.actions"
                  props={
                    {
                      target,
                      thread,
                      ...(project === undefined ? {} : { project }),
                      rename: startRename,
                    } satisfies ThreadActionProps
                  }
                />
              </ContextMenuPopup>
            </ContextMenu>
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
            {kind === "working" && startedAt !== undefined ? (
              <span aria-hidden>
                <WorkingDuration startedAt={startedAt} />
              </span>
            ) : null}
          </span>
        );
      }

      /** The new thread being written, before its first message (T3's SidebarDraftRow). */
      function DraftRow({ node, projectId }: { node: NodeWithCatalog; projectId: string }) {
        const project = node.catalog.projects.find((item) => item.id === projectId);
        return (
          <li className="list-none py-0.5">
            <div
              aria-current="page"
              aria-label={["New thread", "Unsent draft", project?.name].filter(Boolean).join(", ")}
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
        entry: Entry;
        index: number;
        highlighted: boolean;
        active: boolean;
        now: number;
      }) {
        const { entry, highlighted, active, now } = props;
        const settled = entry.settledAt !== undefined;
        return (
          <li className="list-none" role="presentation">
            <button
              aria-current={active ? "page" : undefined}
              aria-label={[entry.thread.title, entry.project?.name].filter(Boolean).join(", ")}
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
                      : `Filter threads by project: ${current.project.name}`
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
                          <ServerIcon aria-hidden className="size-3 shrink-0" />
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
      const scratchOf = (target: NodeTarget) =>
        threads.catalog(target).projects.find((project) => project.scratch)?.id ?? "scratch";

      /** The thread list, or the search's results while a search is typed (T3's sidebar body). */
      function ThreadList({ nodes, hosts }: { nodes: readonly NodeWithCatalog[]; hosts: boolean }) {
        const route = useExternal(navigation, navigation.current);
        const query = useExternal(search, search.get);
        const expanded = useExternal(settledExpanded, settledExpanded.get);
        const count = useExternal(settledCount, settledCount.get);
        const scoped = useExternal(scope, scope.get);
        const highlighted = useExternal(highlight, highlight.get);
        const now = useNow();
        const current = routeThreadKey(route);
        const list = listOf(nodes, now, { query, scoped, count, expanded, current });
        const routeTarget = targetOf(route);

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
                  active={entry.key === current}
                  entry={entry}
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
              No threads found
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
        const total = list.active.length + list.settled.length;
        const scopedProject = list.scopes.find((item) => item.key === list.scopeKey)?.project;
        const anyProject = nodes.some((node) =>
          node.catalog.projects.some((project) => !project.scratch),
        );
        return (
          <>
            {total === 0 && !drafting && loading ? (
              <div aria-hidden className="flex flex-col gap-1.5 px-2 py-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : null}
            {/* Presentational, as in T3: a list is an interaction boundary for VoiceOver. */}
            <ul
              className={cn("relative flex flex-col gap-px", (total > 0 || drafting) && "flex-1")}
              role="presentation"
            >
              {drafting ? <DraftRow node={draftNode} projectId={route.project!} /> : null}
              {list.active.map((entry) => (
                <ThreadRow
                  active={entry.key === current}
                  entry={entry}
                  hosts={hosts}
                  key={entry.key}
                  now={now}
                  variant="card"
                />
              ))}
              {total > 0 ? (
                <SectionHeader
                  expanded={expanded}
                  label={expanded ? "Settled" : `Settled (${list.settled.length})`}
                  onToggle={() => settledExpanded.set(!expanded)}
                />
              ) : null}
              {list.shown.map((entry) => (
                <ThreadRow
                  active={entry.key === current}
                  entry={entry}
                  hosts={hosts}
                  key={entry.key}
                  now={now}
                  variant="slim"
                />
              ))}
              {expanded && list.hidden > 0 ? (
                <li className="list-none">
                  <button
                    className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    onClick={() => settledCount.set(settledCount.get() + SETTLED_TAIL_PAGE_COUNT)}
                    type="button"
                  >
                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                    Show {Math.min(list.hidden, SETTLED_TAIL_PAGE_COUNT)} more
                  </button>
                </li>
              ) : null}
            </ul>
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
        const { results } = listOf(nodeView.snapshot(), Date.now(), stateNow());
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
            <div className="relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3">
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
      /** The threads the sidebar shows, in its order: the search's results, else active then settled. */
      const orderedThreads = (): Entry[] => {
        const list = listOf(nodeView.snapshot(), Date.now(), stateNow());
        return search.get().trim() !== "" ? list.results : [...list.active, ...list.shown];
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
      context.commands.register({
        name: "project.add",
        title: "Add project",
        description:
          "Opens the dialog that adds a folder of a node as a project: the given node, or the current one",
        input: z.object({ node: z.string().optional(), remote: z.string().optional() }),
        output: z.object({}),
        handler: ({ node, remote }) => {
          const target =
            node === undefined
              ? currentPlace()?.target
              : { node, ...(remote === undefined ? {} : { remote }) };
          if (target !== undefined) addProjectRequests.open(target);
          return {};
        },
      });
      context.commands.register({
        name: "chat.new",
        title: "New thread",
        description: "Starts a new thread in the current project",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          const place = currentPlace();
          if (place !== undefined)
            newThread(place.target, place.projectId ?? scratchOf(place.target));
          return {};
        },
      });
      context.commands.register({
        name: "chat.new-without-project",
        title: "New thread without a project",
        description:
          "Starts a new thread in a node's scratch project: the given node, or the current one",
        input: z.object({ node: z.string().optional(), remote: z.string().optional() }),
        output: z.object({}),
        handler: ({ node, remote }) => {
          const target =
            node === undefined
              ? currentPlace()?.target
              : { node, ...(remote === undefined ? {} : { remote }) };
          if (target !== undefined) newThread(target, scratchOf(target));
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
