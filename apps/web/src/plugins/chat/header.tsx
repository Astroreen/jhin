// The header follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ChatHeader.tsx,
// apps/web/src/components/WorkspaceBreadcrumb.tsx and chat/PanelLayoutControls.tsx.
import type {
  ChatHeaderActionProps,
  NodeTarget,
  ProjectRecord,
  ThreadRecord,
} from "@jhin/client-api";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Slot,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  ArchiveIcon,
  ChevronDownIcon,
  HashIcon,
  LinkIcon,
  MailOpenIcon,
  PencilIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { ProjectIcon } from "../../lib/project-icon.tsx";
import { useChat } from "./services.ts";

function BreadcrumbText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "block min-w-0 truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ChatHeader(props: {
  target: NodeTarget;
  project: ProjectRecord | undefined;
  thread: ThreadRecord | undefined;
  /** A title for a view without a thread (a draft). */
  title: string;
  nodeLabel: string;
}) {
  const { target, project, thread } = props;
  const { actions, navigation } = useChat();
  const [renaming, setRenaming] = useState<string | undefined>();
  const committed = useRef(false);
  const running = thread?.lastTurn?.status === "running" || thread?.lastTurn?.status === "waiting";

  const commit = () => {
    if (renaming === undefined || thread === undefined) return;
    const title = renaming;
    setRenaming(undefined);
    void actions.rename(target, thread, title);
  };
  const newThreadInProject = () => {
    if (project === undefined) return;
    navigation.navigate({
      node: target.node,
      ...(target.remote === undefined ? {} : { remote: target.remote }),
      project: project.id,
    });
  };

  return (
    <header
      className="relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-background pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]"
      data-chat-header
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 pr-24 sm:gap-3">
        <nav
          aria-label="Thread breadcrumb"
          className="min-w-0 flex-1 overflow-clip [overflow-clip-margin:2px]"
        >
          <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3">
            <li className="flex min-w-0 shrink items-center font-medium text-muted-foreground">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      aria-label={
                        project === undefined ? props.nodeLabel : `New thread in ${project.name}`
                      }
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={newThreadInProject}
                      type="button"
                    />
                  }
                >
                  {project === undefined ? null : (
                    <ProjectIcon className="size-3.5" project={project} />
                  )}
                  <BreadcrumbText className="max-w-40">
                    {project?.name ?? props.nodeLabel}
                  </BreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {project === undefined ? props.nodeLabel : `New thread in ${project.name}`}
                </TooltipPopup>
              </Tooltip>
            </li>
            <li aria-hidden className="flex shrink-0 items-center text-icon-muted">
              <BreadcrumbText>/</BreadcrumbText>
            </li>
            <li
              aria-current="page"
              className="flex min-w-10 flex-1 items-center font-medium text-foreground"
            >
              {thread === undefined ? (
                <h2 className="min-w-0 flex-1">
                  <BreadcrumbText>{props.title}</BreadcrumbText>
                </h2>
              ) : renaming !== undefined ? (
                <input
                  aria-label="Thread title"
                  autoFocus
                  className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
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
              ) : (
                <Menu>
                  <MenuTrigger
                    render={
                      <button
                        className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onDoubleClick={() => {
                          committed.current = false;
                          setRenaming(thread.title);
                        }}
                        type="button"
                      />
                    }
                  >
                    <h2 className="min-w-0">
                      <BreadcrumbText>{thread.title}</BreadcrumbText>
                    </h2>
                    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    {project === undefined ? null : (
                      <MenuItem onClick={newThreadInProject}>
                        <SquarePenIcon />
                        New thread in {project.name}
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        committed.current = false;
                        setRenaming(thread.title);
                      }}
                    >
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
                    <MenuItem
                      disabled={running}
                      onClick={() => void actions.archive(target, thread)}
                    >
                      <ArchiveIcon />
                      Archive thread
                    </MenuItem>
                    <MenuItem
                      onClick={() => void actions.remove(target, thread)}
                      variant="destructive"
                    >
                      <Trash2Icon />
                      Delete
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              )}
            </li>
          </ol>
        </nav>
      </div>
      <div
        className="pointer-events-none absolute top-0 right-(--workspace-gutter-end) z-30 flex h-[var(--workspace-topbar-height)] items-center gap-1"
        data-workspace-titlebar-controls
      >
        <div
          className="pointer-events-auto flex h-full items-center gap-1"
          data-panel-layout-controls
        >
          <Slot
            name="chat.header.actions"
            props={
              {
                target,
                ...(thread === undefined ? {} : { thread }),
                ...(project === undefined ? {} : { project }),
              } satisfies ChatHeaderActionProps
            }
          />
        </div>
      </div>
    </header>
  );
}
