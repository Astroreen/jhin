// The thread details panel and its Lineage section follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadDetailsCard.tsx (the card, its popover presentation),
// PanelLayoutControls.tsx (the toggle), ThreadRelationshipsControl.tsx (ThreadRelationshipsPanel),
// ThreadRelationshipIcon.tsx (the status labels), threadDetailsPanelStyles.ts and
// packages/client-runtime/src/state/threadRelationships.ts (the order of the rows).
// docs/plans/t3-parity.md, D802.
import type {
  ChatHeaderActionProps,
  ChatThreadDetailsProps,
  Keybindings,
  Navigation,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import { z, type PluginContext } from "@jhin/sdk";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
  ScrollArea,
  Slot,
  ThreadDetailsSection,
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
  type SlotRegistry,
} from "@jhin/ui";
import {
  ArrowRightIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  PlusIcon,
  SquareMenuIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useCatalog, useShortcutLabels } from "../../lib/hooks.ts";

const LINEAGE_INITIAL_COUNT = 6;
const LINEAGE_PAGE_COUNT = 12;

// T3's threadDetailsPanelStyles.ts.
const HOVER_SURFACE =
  "hover:!bg-black/[0.035] data-pressed:!bg-black/[0.035] dark:hover:!bg-white/[0.08] dark:data-pressed:!bg-white/[0.08]";
const ROW_CONTENT = "gap-2.5 px-2.5 text-left";
const CONTROL = `h-8 min-w-0 rounded-lg border-transparent ${ROW_CONTENT} text-[13px] font-medium text-foreground/80`;
const CONTROL_BASE =
  "relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border outline-none transition-[box-shadow,scale] [&:active]:scale-[0.97] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-64";
const ROW = `${CONTROL_BASE} ${CONTROL} w-full justify-start bg-transparent shadow-none ${HOVER_SURFACE}`;
const SPLIT_GROUP = `flex w-full items-center rounded-lg ${HOVER_SURFACE}`;
const SPLIT_PRIMARY = `${CONTROL_BASE} ${CONTROL} flex-1 justify-start rounded-e-none bg-transparent shadow-none ${HOVER_SURFACE}`;
const SPLIT_SECONDARY = `${CONTROL_BASE} ${CONTROL} w-8 justify-center rounded-s-none px-0 bg-transparent shadow-none ${HOVER_SURFACE}`;
const SPLIT_SEPARATOR = "h-4 w-px shrink-0 bg-border/65";

/** T3's threadRelationshipStatusLabel, for the status of a thread's latest turn. */
export function lineageStatusLabel(thread: ThreadRecord | undefined): string {
  switch (thread?.lastTurn?.status) {
    case undefined:
      return "Idle";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Done";
    case "interrupted":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

/** A row of the Lineage section: the thread's parent, or one of its forks. */
export interface LineageRow {
  readonly threadId: string;
  readonly relationship: "parent" | "fork";
  /** The thread, when its node still has it. */
  readonly thread: ThreadRecord | undefined;
}

/**
 * The parent first, then the forks newest first (T3's orderWebThreadLineageRows;
 * the parent is the merge-back target too).
 */
export function lineageRows(thread: ThreadRecord, threads: readonly ThreadRecord[]): LineageRow[] {
  const rows: LineageRow[] = [];
  const parentId = thread.forkedFrom?.threadId;
  if (parentId !== undefined) {
    const parent = threads.find((candidate) => candidate.id === parentId);
    rows.push({ threadId: parentId, relationship: "parent", thread: parent });
  }
  const forks = threads
    .filter((candidate) => candidate.forkedFrom?.threadId === thread.id)
    .toSorted(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  for (const fork of forks) rows.push({ threadId: fork.id, relationship: "fork", thread: fork });
  return rows;
}

/** The section's list, paged as T3 pages it ("Show 12 more"). */
function LineageRowList(props: {
  rows: readonly LineageRow[];
  children: (row: LineageRow) => ReactNode;
}) {
  const [visible, setVisible] = useState(LINEAGE_INITIAL_COUNT);
  const hidden = props.rows.length - Math.min(visible, props.rows.length);
  return (
    <>
      <ul
        aria-label="Related threads"
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0"
      >
        {props.rows.slice(0, visible).map((row) => props.children(row))}
      </ul>
      {hidden > 0 ? (
        <button
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${ROW_CONTENT} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
          onClick={() => setVisible((count) => count + LINEAGE_PAGE_COUNT)}
          type="button"
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Show {Math.min(hidden, LINEAGE_PAGE_COUNT)} more
        </button>
      ) : null}
    </>
  );
}

/**
 * The header's toggle, the panel it opens, `chat.thread-details.toggle` and
 * the Lineage section (D802).
 */
export function registerThreadDetails(
  context: PluginContext,
  services: {
    readonly threads: ThreadsCatalog;
    readonly navigation: Navigation;
    readonly slots: SlotRegistry;
    readonly keybindings: Keybindings | undefined;
  },
) {
  const { threads, navigation, slots, keybindings } = services;
  /** The toggle on screen, for the command. */
  let toggle: (() => void) | undefined;

  context.commands.register({
    name: "chat.thread-details.toggle",
    title: "Toggle thread details",
    description:
      "Opens or closes the open thread's details panel (its lineage and what plugins add)",
    input: z.object({}),
    output: z.object({}),
    handler: () => {
      toggle?.();
      return {};
    },
  });
  if (keybindings !== undefined) {
    context.subscriptions.add(
      keybindings.addDefaults([
        { key: "mod+shift+b", command: "chat.thread-details.toggle", when: "!terminalFocus" },
      ]),
    );
  }

  function ThreadDetailsToggle({ target, thread, project }: ChatHeaderActionProps) {
    const [open, setOpen] = useState(false);
    const shortcut = useShortcutLabels(keybindings)("chat.thread-details.toggle");
    const threadId = thread?.id;
    // Another thread starts with the panel closed.
    useEffect(() => setOpen(false), [threadId]);
    useEffect(() => {
      if (threadId === undefined) return;
      const own = () => setOpen((current) => !current);
      toggle = own;
      return () => {
        if (toggle === own) toggle = undefined;
      };
    }, [threadId]);
    if (thread === undefined) return null;
    return (
      <Popover onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Toggle
                    aria-label="Toggle thread details panel"
                    className="relative shrink-0"
                    pressed={open}
                    size="sm"
                    variant="ghost"
                  />
                }
              />
            }
          >
            <SquareMenuIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Toggle thread details{shortcut ? ` (${shortcut})` : ""}
          </TooltipPopup>
        </Tooltip>
        <PopoverPopup align="end" padding="none" side="bottom" variant="panel">
          <div
            aria-label="Thread details"
            className="dropdown-glass isolate grid max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))] w-80 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-3xl"
            role="region"
          >
            <ScrollArea className="min-h-0" scrollFade>
              <div className="peer empty:hidden">
                <Slot
                  name="chat.thread.details"
                  props={
                    {
                      target,
                      thread,
                      ...(project === undefined ? {} : { project }),
                    } satisfies ChatThreadDetailsProps
                  }
                />
              </div>
              <p className="hidden px-4 py-3 text-sm text-muted-foreground peer-empty:block">
                No details for this thread
              </p>
            </ScrollArea>
          </div>
        </PopoverPopup>
      </Popover>
    );
  }
  context.subscriptions.add(
    slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
      id: "jhin.chat.thread-details",
      order: -20,
      component: ThreadDetailsToggle,
    }),
  );

  /** T3's ThreadRelationshipsPanel, for forks: the parent and the forks of the thread. */
  function Lineage({ target, thread }: ChatThreadDetailsProps) {
    const catalog = useCatalog(threads, target);
    const [merging, setMerging] = useState(false);
    const rows = lineageRows(thread, catalog?.threads ?? []);
    if (rows.length === 0) return null;
    const at = {
      node: target.node,
      ...(target.remote === undefined ? {} : { remote: target.remote }),
    };
    const open = (threadId: string) => navigation.navigate({ ...target, thread: threadId });
    // Whether the fork ran a turn: the node refuses a merge-back before (D224).
    const ran = thread.lastTurn !== undefined && thread.lastTurn.status !== "running";
    const merge = async () => {
      if (merging) return;
      setMerging(true);
      try {
        await context.commands.execute("thread.merge-back", { ...at, threadId: thread.id });
      } catch {
        // `thread.merge-back` says why in a toast.
      } finally {
        setMerging(false);
      }
    };
    return (
      <ThreadDetailsSection headingId="thread-details-lineage-heading" title="Lineage">
        <LineageRowList rows={rows}>
          {(row) => {
            const parent = row.relationship === "parent";
            const title = row.thread?.title ?? row.threadId;
            const relationship = parent ? "Parent thread" : "Fork";
            const missing = row.thread === undefined;
            // The parent row shows the fork's status, as T3's edge does.
            const status = lineageStatusLabel(parent ? thread : row.thread);
            const Icon = parent ? CornerLeftUpIcon : GitForkIcon;
            const content = (
              <>
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                    {title}
                  </span>
                </span>
                {parent ? null : (
                  <>
                    <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    <span
                      className={cn(
                        "shrink-0 text-2xs",
                        status === "Failed" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {status}
                    </span>
                  </>
                )}
              </>
            );
            const hint = missing
              ? "This related thread is unavailable"
              : `Open ${relationship.toLowerCase()} in this chat`;
            const link = (className: string, label?: string) => (
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <button
                      {...(label === undefined ? {} : { "aria-label": label })}
                      className={className}
                      disabled={missing}
                      onClick={() => open(row.threadId)}
                      type="button"
                    />
                  }
                >
                  {content}
                </TooltipTrigger>
                <TooltipPopup side="left">{hint}</TooltipPopup>
              </Tooltip>
            );
            return (
              <li className="group relative flex h-8 items-center rounded-lg" key={row.threadId}>
                {parent ? (
                  <div className={SPLIT_GROUP}>
                    {link(SPLIT_PRIMARY, `${title} ${status}`)}
                    <span aria-hidden="true" className={SPLIT_SEPARATOR} />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            aria-label={
                              missing
                                ? "Merge back to source conversation"
                                : `Merge back to ${title}`
                            }
                            className={SPLIT_SECONDARY}
                            disabled={!ran || merging}
                            onClick={() => void merge()}
                            type="button"
                          />
                        }
                      >
                        {merging ? (
                          <LoaderCircleIcon className="size-3 animate-spin" />
                        ) : (
                          <GitMergeIcon className="size-3" />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup side="left">
                        {!ran
                          ? "Complete a run in this fork before merging it back"
                          : missing
                            ? "Merge this conversation back into its source"
                            : `Merge this conversation back into ${title}`}
                      </TooltipPopup>
                    </Tooltip>
                    <span className="shrink-0 border border-transparent ps-1 pe-2.5 text-2xs font-medium text-muted-foreground">
                      {status}
                    </span>
                  </div>
                ) : (
                  link(ROW)
                )}
              </li>
            );
          }}
        </LineageRowList>
      </ThreadDetailsSection>
    );
  }
  context.subscriptions.add(
    slots.contribute<ChatThreadDetailsProps>("chat.thread.details", {
      id: "jhin.chat.lineage",
      order: 100,
      component: Lineage,
    }),
  );
}
