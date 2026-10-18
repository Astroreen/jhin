// The design follows T3 Code's per-project sidebar (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/LegacySidebar.tsx, sidebar/SidebarChrome.tsx and ThreadStatusIndicators.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type Keybindings,
  type MeshMembership,
  type Navigation,
  type NodeConnection,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  Button,
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Kbd,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
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
  EllipsisIcon,
  FolderPlusIcon,
  HashIcon,
  LinkIcon,
  MailOpenIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { AddProjectDialog, addProjectRequests } from "../lib/add-project.tsx";
import { builtin } from "../lib/builtin.ts";
import { formatRelativeTimeLabel } from "../lib/format.ts";
import { useExternal, useNow, useShortcutLabels } from "../lib/hooks.ts";
import { useMeshMembers } from "../lib/mesh.ts";
import { ProjectIcon } from "../lib/project-icon.tsx";
import { CHAT_SECTION, ChatSettings, useSection } from "../lib/settings.ts";
import { threadActions, visitKey, type ThreadActions } from "../lib/thread-actions.ts";
import {
  strongestPill,
  threadStatusPill,
  visits,
  type ThreadStatusPill,
} from "../lib/thread-status.ts";

const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

const COLLAPSED_STORAGE_KEY = "jhin.sidebar.collapsed";

/** The time a thread last moved: its last turn, then its last change. */
const threadActivityAt = (thread: ThreadRecord) =>
  thread.lastTurn?.at ?? thread.updatedAt ?? thread.createdAt;

/** Threads as the sidebar lists them: not archived, most recent first. */
function listedThreads(threads: readonly ThreadRecord[], projectId: string): ThreadRecord[] {
  return threads
    .filter((thread) => thread.projectId === projectId && thread.archivedAt === undefined)
    .toSorted((a, b) => threadActivityAt(b).localeCompare(threadActivityAt(a)));
}

const normalize = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

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

/** A connection's state as a dot (T3 Code's ConnectionStatusDot). */
function ConnectionDot({ state }: { state: NodeConnection["state"] }) {
  return (
    <span
      aria-label={`Connection ${state}`}
      className="relative flex size-3 shrink-0 items-center justify-center"
      role="img"
    >
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
      const actions: ThreadActions = threadActions({
        context,
        threads,
        navigation,
        mesh,
        toasts,
        dialogs,
      });
      const collapsed = createCollapsed();
      const visitStore = visits();

      const useCatalog = (target: NodeTarget) =>
        useSyncExternalStore(
          (listener) => {
            const subscription = threads.subscribe(target, listener);
            return () => subscription.dispose();
          },
          () => threads.catalog(target),
        );

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

      function ThreadRow(props: {
        target: NodeTarget;
        thread: ThreadRecord;
        active: boolean;
        now: number;
      }) {
        const { target, thread, active, now } = props;
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
          void actions.rename(target, thread, title);
        };

        return (
          <SidebarMenuSubItem className="w-full" data-thread-item>
            <ContextMenu>
              <ContextMenuTrigger
                render={
                  <div
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      active
                        ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
                        : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                    data-active={active}
                    onClick={() => {
                      if (renaming === undefined) openThread(target, thread.id);
                    }}
                    onDoubleClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                      startRename();
                    }}
                    onKeyDown={(event) => {
                      if (renaming !== undefined || event.target !== event.currentTarget) return;
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
                  />
                }
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  {status === null ? null : <ThreadStatusLabel status={status} />}
                  {renaming === undefined ? (
                    <span className="min-w-0 flex-1 truncate text-sm" data-thread-title>
                      {thread.title}
                    </span>
                  ) : (
                    <input
                      aria-label="Thread title"
                      autoFocus
                      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
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
                  )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <div className="flex min-w-12 justify-end max-sm:min-w-20">
                    {!running && renaming === undefined ? (
                      <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                aria-label={`Archive ${thread.title}`}
                                className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void actions.archive(target, thread);
                                }}
                                onPointerDown={(event) => event.stopPropagation()}
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
                    <span
                      className={cn(
                        "pointer-events-none",
                        !running &&
                          "transition-opacity duration-150 max-sm:pr-6 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0",
                      )}
                    >
                      <span
                        className={cn(
                          "text-3xs tabular-nums",
                          active ? "text-foreground" : "text-secondary-label",
                        )}
                      >
                        {formatRelativeTimeLabel(threadActivityAt(thread), now)}
                      </span>
                    </span>
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuPopup>
                <MenuItem onClick={startRename}>
                  <PencilIcon />
                  Rename thread
                </MenuItem>
                <MenuItem onClick={() => actions.markUnread(target, thread)}>
                  <MailOpenIcon />
                  Mark unread
                </MenuItem>
                <MenuItem onClick={() => actions.copyId(thread)}>
                  <HashIcon />
                  Copy thread ID
                </MenuItem>
                <MenuItem onClick={() => actions.copyAddress(target, thread)}>
                  <LinkIcon />
                  Copy thread address
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={running} onClick={() => void actions.archive(target, thread)}>
                  <ArchiveIcon />
                  Archive thread
                </MenuItem>
                <MenuItem onClick={() => void actions.remove(target, thread)} variant="destructive">
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </ContextMenuPopup>
            </ContextMenu>
          </SidebarMenuSubItem>
        );
      }

      /** The new thread being written in a project, before its first message. */
      function DraftRow() {
        return (
          <SidebarMenuSubItem className="w-full">
            <div
              aria-current="page"
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
        target: NodeTarget;
        project: ProjectRecord;
        threads: readonly ThreadRecord[];
        query: string;
        now: number;
      }) {
        const { target, project, query, now } = props;
        const route = useExternal(navigation, navigation.current);
        const settings = useSection(context, CHAT_SECTION, ChatSettings);
        const seen = useExternal(visitStore, visitStore.snapshot);
        const key = `${targetKey(target)}|${project.id}`;
        const collapsedNow = useExternal(collapsed, collapsed.snapshot).has(key);
        const [showAll, setShowAll] = useState(false);
        const here = sameTarget(targetOf(route), target);
        const drafting = here && route.thread === undefined && route.project === project.id;
        const matching =
          query === ""
            ? props.threads
            : props.threads.filter((thread) => normalize(thread.title).includes(normalize(query)));
        if (query !== "" && matching.length === 0) return null;
        const expanded = query !== "" || !collapsedNow;
        const limit = settings.threadPreviewCount;
        const overflowing = matching.length > limit;
        const shown =
          showAll || !overflowing || query !== ""
            ? matching
            : matching.filter(
                (thread, index) => index < limit || (here && route.thread === thread.id),
              );
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
                    <span className="truncate text-sm font-medium text-sidebar-foreground/90">
                      {project.name}
                    </span>
                  </span>
                  <span aria-hidden className="w-4 shrink-0 max-sm:w-10" />
                </ContextMenuTrigger>
                <ContextMenuPopup>
                  <MenuItem onClick={() => newThread(target, project.id)}>
                    <SquarePenIcon />
                    New thread
                  </MenuItem>
                  {project.scratch ? null : (
                    <>
                      <MenuItem onClick={() => void actions.renameProject(target, project)}>
                        <PencilIcon />
                        Rename project
                      </MenuItem>
                      <MenuItem onClick={() => actions.copyPath(project)}>
                        <CopyIcon />
                        Copy path
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        onClick={() =>
                          void actions.removeProject(target, project, props.threads.length)
                        }
                        variant="destructive"
                      >
                        <Trash2Icon />
                        Remove project
                      </MenuItem>
                    </>
                  )}
                </ContextMenuPopup>
              </ContextMenu>
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
                aria-label={`Threads of ${project.name}`}
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
                    key={thread.id}
                    now={now}
                    target={target}
                    thread={thread}
                  />
                ))}
                {overflowing && query === "" ? (
                  <SidebarMenuSubItem className="w-full">
                    <SidebarMenuSubButton
                      onClick={() => setShowAll(!showAll)}
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

      /** One node's projects and threads: a connected node, or one of its mesh. */
      function NodeSection(props: {
        target: NodeTarget;
        label: string;
        state: NodeConnection["state"];
        query: string;
        connection?: NodeConnection;
      }) {
        const { target, label, state, query } = props;
        const catalog = useCatalog(target);
        const route = useExternal(navigation, navigation.current);
        const now = useNow();
        const here = sameTarget(targetOf(route), target);
        const scratch = catalog.projects.find((project) => project.scratch);
        const projects = catalog.projects.filter(
          (project) =>
            !project.scratch ||
            listedThreads(catalog.threads, project.id).length > 0 ||
            (here && route.project === project.id),
        );

        return (
          <section aria-label={`Node ${label}`} className="flex flex-col">
            <div className="group/node-header flex h-8 items-center gap-2 pr-1.5 pl-2">
              {target.remote === undefined ? (
                <ConnectionDot state={state} />
              ) : (
                <ServerIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
              )}
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/80">
                {label}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="New thread"
                        disabled={state !== "open" || scratch === undefined}
                        onClick={() => scratch !== undefined && newThread(target, scratch.id)}
                        size="icon-xs"
                        variant="ghost-muted"
                      />
                    }
                  >
                    <SquarePenIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">New thread without a project on {label}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={`Add project on ${label}`}
                        disabled={state !== "open"}
                        onClick={() => addProjectRequests.open(target)}
                        size="icon-xs"
                        variant="ghost-muted"
                      />
                    }
                  >
                    <FolderPlusIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Add project</TooltipPopup>
                </Tooltip>
                {props.connection === undefined ? null : <NodeMenu connection={props.connection} />}
              </div>
            </div>
            {catalog.status === "loading" && state === "open" ? (
              <div className="flex flex-col gap-1.5 px-2 py-1" aria-hidden>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : null}
            {catalog.status === "error" ? (
              <p className="px-2 py-1 text-2xs text-destructive-foreground" role="alert">
                {catalog.error ?? "Cannot reach this node"}
              </p>
            ) : null}
            <SidebarMenu className="gap-0.5">
              {projects.map((project) => (
                <ProjectGroup
                  key={project.id}
                  now={now}
                  project={project}
                  query={query}
                  target={target}
                  threads={listedThreads(catalog.threads, project.id)}
                />
              ))}
            </SidebarMenu>
            {catalog.status === "ready" &&
            catalog.projects.every((p) => p.scratch) &&
            query === "" &&
            !(here && route.project !== undefined) &&
            listedThreads(catalog.threads, scratch?.id ?? "").length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-xs text-muted-foreground/60">
                <span>No projects yet</span>
                <button
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  onClick={() => addProjectRequests.open(target)}
                  type="button"
                >
                  <PlusIcon className="-mx-0.5 size-3" />
                  Add project
                </button>
              </div>
            ) : null}
          </section>
        );
      }

      function NodeMenu({ connection }: { connection: NodeConnection }) {
        return (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={`More for ${connection.label}`}
                  size="icon-xs"
                  variant="ghost-muted"
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() =>
                  void dialogs
                    ?.prompt({
                      title: "Rename node",
                      description: "The name this device shows for the node.",
                      label: "Node name",
                      value: connection.label,
                      confirmLabel: "Rename",
                      validate: (value) =>
                        value.trim() === "" ? "A node needs a name" : undefined,
                    })
                    .then((label) => {
                      if (label !== undefined) connections.rename?.(connection.id, label);
                    })
                }
              >
                <PencilIcon />
                Rename on this device
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(connection.url)
                    .then(() =>
                      toasts?.show({ type: "success", title: "Address copied", timeout: 1500 }),
                    )
                }
              >
                <CopyIcon />
                Copy address
              </MenuItem>
              <MenuSeparator />
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
                    connections.remove(connection.id);
                    if (navigation.current().node === connection.id) navigation.navigate({});
                  })
                }
                variant="destructive"
              >
                <XIcon />
                Disconnect
              </MenuItem>
            </MenuPopup>
          </Menu>
        );
      }

      /** The other nodes of a connected node's mesh, reached through it. */
      function MeshNodes({ node, query }: { node: NodeConnection; query: string }) {
        const members = useMeshMembers(mesh, node.id) ?? [];
        return (
          <>
            {members
              .filter((member) => !member.self && member.reachable)
              .map((member) => (
                <NodeSection
                  key={member.nodeId}
                  label={member.name}
                  query={query}
                  state="open"
                  target={{ node: node.id, remote: member.nodeId }}
                />
              ))}
          </>
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
        const nodes = useExternal(connections, connections.list);
        const [query, setQuery] = useState("");
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
                        disabled={nodes.length === 0}
                        label="Add project"
                        onClick={() => {
                          const place = currentPlace();
                          if (place !== undefined) addProjectRequests.open(place.target);
                        }}
                        shortcut={shortcut("sidebar.add-project")}
                      >
                        <FolderPlusIcon />
                      </SidebarHeaderIconButton>
                      <SidebarHeaderIconButton
                        disabled={nodes.length === 0}
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
                  nodes.map((node) => (
                    <div className="flex flex-col gap-2" key={node.id}>
                      <NodeSection
                        connection={node}
                        label={node.label}
                        query={query}
                        state={node.state}
                        target={{ node: node.id }}
                      />
                      {node.state === "open" ? <MeshNodes node={node} query={query} /> : null}
                    </div>
                  ))
                )}
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
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
            <AddProjectDialog
              connections={connections}
              navigation={navigation}
              threads={threads}
              toasts={toasts}
            />
          </>
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
      /** Every listed thread in sidebar order: nodes, projects, then recency. */
      const orderedThreads = (): { target: NodeTarget; thread: ThreadRecord }[] => {
        const result: { target: NodeTarget; thread: ThreadRecord }[] = [];
        for (const node of connections.list()) {
          const targets: NodeTarget[] = [
            { node: node.id },
            ...(mesh.members(node.id) ?? [])
              .filter((member) => !member.self && member.reachable)
              .map((member) => ({ node: node.id, remote: member.nodeId })),
          ];
          for (const target of targets) {
            const catalog = threads.catalog(target);
            for (const project of catalog.projects) {
              if (collapsed.has(`${targetKey(target)}|${project.id}`)) continue;
              for (const thread of listedThreads(catalog.threads, project.id)) {
                result.push({ target, thread });
              }
            }
          }
        }
        return result;
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
        name: "sidebar.add-project",
        title: "Add project",
        description: "Adds a folder of a node as a project",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          const place = currentPlace();
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
        description: "Starts a new thread in the node's scratch project",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          const place = currentPlace();
          if (place !== undefined) newThread(place.target, scratchOf(place.target));
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
        slots.contribute("sidebar.actions", {
          id: "jhin.sidebar.add-node",
          order: -10,
          component: AddNode,
        }),
      );
    },
  }),
);
