// The design follows T3 Code's per-project sidebar (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/LegacySidebar.tsx, sidebar/SidebarChrome.tsx and ThreadStatusIndicators.tsx;
// the node of a row as T3 marks a thread's environment: apps/web/src/components/Sidebar.tsx and
// EnvironmentMachineIcon.tsx.
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
  type ProjectRecord,
  type ThreadRecord,
  type ThreadsCatalog,
  VISITS_CAPABILITY,
  visitKey,
  type ThreadVisits,
  type NodeActionProps,
  type ProjectActionProps,
  type ThreadActionProps,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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
  ArchiveIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type ComponentType, type ReactNode } from "react";

import { AddProjectDialog, createAddProjectRequests } from "../lib/add-project.tsx";
import { builtin } from "../lib/builtin.ts";
import { formatRelativeTimeLabel } from "../lib/format.ts";
import { useExternal, useNow, useShortcutLabels } from "../lib/hooks.ts";
import { createShownNodes, showsHosts, type NodeWithCatalog } from "../lib/nodes.ts";
import { ProjectIcon } from "../lib/project-icon.tsx";
import { CHAT_SECTION, ChatSettings, readSection, useSection } from "../lib/settings.ts";
import {
  projectKey,
  shownThreads,
  sidebarProjects,
  threadActivityAt,
  type SidebarProject,
} from "../lib/sidebar-order.ts";
import { strongestPill, threadStatusPill, type ThreadStatusPill } from "../lib/thread-status.ts";

const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

const COLLAPSED_STORAGE_KEY = "jhin.sidebar.collapsed";

/** A value of the sidebar that its commands read too (the search). */
function createValue<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

/** The projects that show all their threads, not only the first few. */
function createShowingAll() {
  let keys: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    has: (key: string) => keys.has(key),
    toggle(key: string) {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      keys = next;
      for (const listener of Array.from(listeners)) listener();
    },
    snapshot: () => keys,
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

/** Which projects the user collapsed, kept on this device. */
function createCollapsed() {
  const listeners = new Set<() => void>();
  let collapsed = new Set<string>();
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]");
    if (Array.isArray(value)) collapsed = new Set(value.filter((key) => typeof key === "string"));
  } catch {
    // Unreadable: everything expanded.
  }
  return {
    has: (key: string) => collapsed.has(key),
    toggle(key: string) {
      collapsed = new Set(collapsed);
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]));
      } catch {
        // Not kept; still applied.
      }
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    snapshot: () => collapsed,
  };
}

function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
              role="img"
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${status.pulse ? "animate-status-pulse" : ""}`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-3xs ${status.colorClass}`}
            role="img"
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${status.pulse ? "animate-status-pulse" : ""}`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

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
      <ServerIcon aria-hidden className="size-3" />
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

function SidebarHeaderIconButton(props: {
  label: string;
  shortcut?: string | undefined;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            aria-label={props.label}
            className="relative size-7 shrink-0"
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.label}
        {props.shortcut === undefined ? "" : ` (${props.shortcut})`}
      </TooltipPopup>
    </Tooltip>
  );
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
      const collapsed = createCollapsed();
      const showingAll = createShowingAll();
      const search = createValue("");
      const addProjectRequests = createAddProjectRequests();
      const visitStore = visits ?? NO_VISITS;
      const nodeView = createShownNodes(connections, mesh, threads);

      const targetOf = (route: { node?: string; remote?: string }): NodeTarget | undefined =>
        route.node === undefined
          ? undefined
          : { node: route.node, ...(route.remote === undefined ? {} : { remote: route.remote }) };
      const sameTarget = (a: NodeTarget | undefined, b: NodeTarget) =>
        a !== undefined && a.node === b.node && a.remote === b.remote;

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

      function ThreadRow(props: {
        target: NodeTarget;
        thread: ThreadRecord;
        project: ProjectRecord;
        active: boolean;
        now: number;
        /** The node's name, while the sidebar shows several nodes. */
        host: string | undefined;
      }) {
        const { target, thread, active, now, host } = props;
        const seen = useExternal(visitStore, visitStore.snapshot);
        const [renaming, setRenaming] = useState<string | undefined>();
        const committed = useRef(false);
        const status = threadStatusPill(thread, seen[visitKey(target, thread.id)]);
        const running =
          thread.lastTurn?.status === "running" || thread.lastTurn?.status === "waiting";

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

        return (
          <SidebarMenuSubItem className="w-full" data-thread-item>
            <ContextMenu>
              {/* The row, and next to it (not inside) its archive button. */}
              <ContextMenuTrigger render={<div className="relative isolate w-full min-w-0" />}>
                {renaming === undefined ? (
                  <div
                    aria-current={active ? "page" : undefined}
                    aria-label={
                      status === null ? thread.title : `${thread.title} (${status.label})`
                    }
                    className={cn(
                      "flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      active
                        ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
                        : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                    data-active={active}
                    onClick={() => openThread(target, thread.id)}
                    onDoubleClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                      startRename();
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openThread(target, thread.id);
                      } else if (event.key === "F2") {
                        event.preventDefault();
                        startRename();
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                      {status === null ? null : <ThreadStatusLabel status={status} />}
                      <span className="min-w-0 flex-1 truncate text-sm" data-thread-title>
                        {thread.title}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "pointer-events-none ml-auto flex min-w-12 shrink-0 justify-end max-sm:min-w-20",
                        host !== undefined && "max-sm:min-w-24",
                        !running &&
                          "transition-opacity duration-150 max-sm:pr-6 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0",
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        <span
                          className={cn(
                            "text-3xs tabular-nums",
                            active ? "text-foreground" : "text-secondary-label",
                          )}
                        >
                          {formatRelativeTimeLabel(threadActivityAt(thread), now)}
                        </span>
                        {/* Last in the row, where T3 ends a row with its environment's icon. */}
                        {host === undefined ? null : (
                          <HostIcon className="text-sidebar-muted-foreground/70" label={host} />
                        )}
                      </span>
                    </span>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2",
                      active && "bg-sidebar-row-active",
                    )}
                  >
                    {status === null ? null : <ThreadStatusLabel status={status} />}
                    <input
                      aria-label="Thread title"
                      autoFocus
                      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
                      onBlur={() => {
                        if (!committed.current) commit();
                      }}
                      onChange={(event) => setRenaming(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
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
                  </div>
                )}
                {!running && renaming === undefined ? (
                  <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            aria-label={`Archive ${thread.title}`}
                            className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                            onClick={() =>
                              run("thread.archive", { ...target, threadId: thread.id })
                            }
                            type="button"
                          />
                        }
                      >
                        <ArchiveIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Archive</TooltipPopup>
                    </Tooltip>
                  </div>
                ) : null}
              </ContextMenuTrigger>
              <ContextMenuPopup>
                <Slot
                  name="thread.actions"
                  props={
                    {
                      target,
                      thread,
                      project: props.project,
                      rename: startRename,
                    } satisfies ThreadActionProps
                  }
                />
              </ContextMenuPopup>
            </ContextMenu>
          </SidebarMenuSubItem>
        );
      }

      /** The new thread being written in a project, before its first message. */
      function DraftRow() {
        return (
          <SidebarMenuSubItem aria-current="page" className="w-full">
            <div
              className="relative isolate flex h-8 w-full min-w-0 select-none items-center gap-2 overflow-hidden rounded-md bg-sidebar-row-active px-2 text-left text-xs font-medium text-sidebar-foreground"
              data-active
            >
              <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">New thread</span>
            </div>
          </SidebarMenuSubItem>
        );
      }

      function ProjectGroup(props: {
        entry: SidebarProject<NodeWithCatalog>;
        query: string;
        now: number;
        /** Whether rows name their node: the sidebar shows several. */
        hosts: boolean;
      }) {
        const { query, now } = props;
        const { key, project, node } = props.entry;
        const target = node.target;
        const host = props.hosts ? node.label : undefined;
        const route = useExternal(navigation, navigation.current);
        const settings = useSection(context, CHAT_SECTION, ChatSettings);
        const seen = useExternal(visitStore, visitStore.snapshot);
        const collapsedNow = useExternal(collapsed, collapsed.snapshot).has(key);
        const showAll = useExternal(showingAll, showingAll.snapshot).has(key);
        const here = sameTarget(targetOf(route), target);
        const drafting = here && route.thread === undefined && route.project === project.id;
        const { matching, shown } = shownThreads(props.entry.threads, {
          query,
          limit: settings.threadPreviewCount,
          showAll,
          current: here ? route.thread : undefined,
        });
        if (query !== "" && matching.length === 0) return null;
        const expanded = query !== "" || !collapsedNow;
        const overflowing = matching.length > settings.threadPreviewCount;
        const hiddenStatus = strongestPill(
          matching
            .filter((thread) => !shown.includes(thread))
            .map((thread) => threadStatusPill(thread, seen[visitKey(target, thread.id)])),
        );
        const collapsedStatus = expanded
          ? null
          : strongestPill(
              matching.map((thread) => threadStatusPill(thread, seen[visitKey(target, thread.id)])),
            );

        return (
          <SidebarMenuItem>
            <div className="group/project-header relative">
              <ContextMenu>
                <ContextMenuTrigger
                  render={
                    <SidebarMenuButton
                      aria-expanded={expanded}
                      onClick={() => collapsed.toggle(key)}
                    />
                  }
                >
                  {collapsedStatus !== null ? (
                    <span
                      aria-label={collapsedStatus.label}
                      className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${collapsedStatus.colorClass}`}
                    >
                      <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                        <span
                          className={`size-[9px] rounded-full ${collapsedStatus.dotClass} ${collapsedStatus.pulse ? "animate-status-pulse" : ""}`}
                        />
                      </span>
                      <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
                    </span>
                  ) : (
                    <ChevronRightIcon
                      className={cn(
                        "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
                        expanded && "rotate-90",
                      )}
                    />
                  )}
                  <span className="flex shrink-0">
                    <ProjectIcon project={project} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={cn(
                        "truncate text-sm font-medium text-sidebar-foreground/90",
                        // The project's name first; the node's name takes what is left.
                        host !== undefined && "max-w-[calc(100%-2rem)] shrink-0",
                      )}
                    >
                      {project.name}
                    </span>
                    {/* Where T3 says how many projects a row groups: here, whose project it is. */}
                    {host === undefined ? null : (
                      <span
                        aria-hidden
                        className="min-w-6 max-w-24 truncate text-secondary-label text-3xs"
                      >
                        {host}
                      </span>
                    )}
                  </span>
                  <span aria-hidden className="w-4 shrink-0 max-sm:w-10" />
                </ContextMenuTrigger>
                <ContextMenuPopup>
                  <Slot
                    name="project.actions"
                    props={{ target, project } satisfies ProjectActionProps}
                  />
                </ContextMenuPopup>
              </ContextMenu>
              {/* T3's remote project mark: the node's icon, giving way to the new-thread button. */}
              {host === undefined ? null : (
                <HostIcon
                  className="pointer-events-none absolute top-1/2 right-1.5 size-5 -translate-y-1/2 rounded-md text-icon-muted transition-opacity duration-150 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
                  label={host}
                />
              )}
              <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        aria-label={`Create new thread in ${project.name}`}
                        className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                        onClick={() => newThread(target, project.id)}
                        type="button"
                      />
                    }
                  >
                    <SquarePenIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">New thread in {project.name}</TooltipPopup>
                </Tooltip>
              </div>
            </div>
            {expanded ? (
              <SidebarMenuSub
                aria-label={
                  host === undefined
                    ? `Threads of ${project.name}`
                    : `Threads of ${project.name} on ${host}`
                }
                className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden empty:hidden sm:mx-1"
              >
                {drafting ? <DraftRow /> : null}
                {matching.length === 0 && !drafting ? (
                  <SidebarMenuSubItem className="w-full">
                    <div className="flex h-8 w-full translate-x-0 items-center px-2 text-left text-xs text-sidebar-muted-foreground/75">
                      <span>No threads yet</span>
                    </div>
                  </SidebarMenuSubItem>
                ) : null}
                {shown.map((thread) => (
                  <ThreadRow
                    active={here && route.thread === thread.id}
                    host={host}
                    key={thread.id}
                    now={now}
                    project={project}
                    target={target}
                    thread={thread}
                  />
                ))}
                {overflowing && query === "" ? (
                  <SidebarMenuSubItem className="w-full">
                    <SidebarMenuSubButton
                      onClick={() => showingAll.toggle(key)}
                      render={<button type="button" />}
                      size="sm"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {!showAll && hiddenStatus !== null ? (
                          <ThreadStatusLabel compact status={hiddenStatus} />
                        ) : null}
                        <span>{showAll ? "Show less" : "Show more"}</span>
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ) : null}
              </SidebarMenuSub>
            ) : null}
          </SidebarMenuItem>
        );
      }

      /**
       * Connections that are not open and nodes whose catalog failed, above the
       * projects: T3 Code's LocalSecondaryStatus (LegacySidebar.tsx) for every node.
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

      /**
       * The projects of every shown node in one list, as T3 Code lists them:
       * no section per node; while several nodes are shown, each row names its node.
       */
      function ProjectList({ nodes, query }: { nodes: readonly NodeWithCatalog[]; query: string }) {
        const route = useExternal(navigation, navigation.current);
        const now = useNow();
        const routeTarget = targetOf(route);
        const drafting =
          routeTarget !== undefined && route.thread === undefined && route.project !== undefined
            ? projectKey(routeTarget, route.project)
            : undefined;
        const projects = sidebarProjects(nodes, drafting);
        const hosts = showsHosts(nodes);
        const loading = nodes.some(
          (node) => node.state === "open" && node.catalog.status === "loading",
        );
        const empty =
          projects.length === 0 &&
          query === "" &&
          !loading &&
          nodes.some((node) => node.catalog.status === "ready");
        return (
          <>
            {projects.length === 0 && loading ? (
              <div aria-hidden className="flex flex-col gap-1.5 px-2 py-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : null}
            <SidebarMenu className="gap-0.5">
              {projects.map((entry) => (
                <ProjectGroup entry={entry} hosts={hosts} key={entry.key} now={now} query={query} />
              ))}
            </SidebarMenu>
            {empty ? (
              <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-xs text-muted-foreground/60">
                <span>No projects yet</span>
                <button
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  onClick={() => void context.commands.execute("project.add", {})}
                  type="button"
                >
                  <PlusIcon className="-mx-0.5 size-3" />
                  Add project
                </button>
              </div>
            ) : null}
          </>
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

      function SidebarRoot() {
        const nodes = useExternal(nodeView, nodeView.snapshot);
        const anyOpen = nodes.some((node) => node.state === "open");
        const query = useExternal(search, search.get);
        const setQuery = search.set;
        const shortcut = useShortcutLabels(keybindings);
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
              fixedHeader={
                <SidebarGroup className="z-[1]">
                  <div className="flex items-center gap-1">
                    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                      <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                      <SidebarInput
                        aria-label="Search threads"
                        className="min-w-0 flex-1"
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setQuery("");
                        }}
                        placeholder="Search"
                        type="search"
                        value={query}
                      />
                      {query !== "" ? (
                        <Button
                          aria-label="Clear thread search"
                          className="shrink-0"
                          onClick={() => setQuery("")}
                          size="icon-micro"
                          variant="ghost-muted"
                        >
                          <XIcon className="size-3" />
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center">
                      <SidebarHeaderIconButton
                        disabled={!anyOpen}
                        label="Add project"
                        onClick={() => void context.commands.execute("project.add", {})}
                        shortcut={shortcut("project.add")}
                      >
                        <FolderPlusIcon />
                      </SidebarHeaderIconButton>
                      <SidebarHeaderIconButton
                        disabled={!anyOpen}
                        label="New thread"
                        onClick={() => void context.commands.execute("chat.new", {})}
                        shortcut={shortcut("chat.new")}
                      >
                        <SquarePenIcon />
                      </SidebarHeaderIconButton>
                    </div>
                  </div>
                </SidebarGroup>
              }
            >
              <SidebarGroup className="gap-2 pt-0">
                {nodes.length === 0 ? (
                  <p className="px-2 py-4 text-center text-xs text-sidebar-muted-foreground/70">
                    No node connected.
                  </p>
                ) : (
                  <>
                    <NodeStatus nodes={nodes} />
                    <ProjectList nodes={nodes} query={query} />
                  </>
                )}
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              <SidebarMenu className="flex-row items-center">
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
      /** The threads the sidebar shows, in its order: projects (as `sidebarProjects` orders them), then recency. */
      const orderedThreads = (): { target: NodeTarget; thread: ThreadRecord }[] => {
        const query = search.get();
        const route = navigation.current();
        const routeTarget = targetOf(route);
        const limit = readSection(context, CHAT_SECTION, ChatSettings).threadPreviewCount;
        const drafting =
          routeTarget !== undefined && route.thread === undefined && route.project !== undefined
            ? projectKey(routeTarget, route.project)
            : undefined;
        return sidebarProjects(nodeView.snapshot(), drafting).flatMap(
          ({ key, node, threads: listed }) => {
            // A search shows the matches of collapsed projects too.
            if (query === "" && collapsed.has(key)) return [];
            const { shown } = shownThreads(listed, {
              query,
              limit,
              showAll: showingAll.has(key),
              current: sameTarget(routeTarget, node.target) ? route.thread : undefined,
            });
            return shown.map((thread) => ({ target: node.target, thread }));
          },
        );
      };
      const step = (delta: number) => {
        const list = orderedThreads();
        if (list.length === 0) return;
        const route = navigation.current();
        const index = list.findIndex(
          (entry) => entry.thread.id === route.thread && sameTarget(targetOf(route), entry.target),
        );
        const next =
          index < 0
            ? delta > 0
              ? list[0]
              : list.at(-1)
            : list[Math.min(list.length - 1, Math.max(0, index + delta))];
        if (next !== undefined) openThread(next.target, next.thread.id);
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
            if (entry !== undefined) openThread(entry.target, entry.thread.id);
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
