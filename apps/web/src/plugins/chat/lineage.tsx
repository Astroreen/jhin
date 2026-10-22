// The Lineage section of the thread details panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadRelationshipsControl.tsx (ThreadRelationshipsPanel),
// ThreadRelationshipIcon.tsx (the status labels), threadDetailsPanelStyles.ts and
// packages/client-runtime/src/state/threadRelationships.ts (the order of the rows).
// A chunk of its own, loaded with the panel (D440). docs/plans/t3-parity.md, D802.
import type {
  ChatThreadDetailsProps,
  Navigation,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { Slot, ThreadDetailsSection, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import {
  ArrowRightIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { useCatalog } from "../../lib/hooks.ts";
import { forkRan } from "../../lib/forks.ts";

const LINEAGE_INITIAL_COUNT = 6;
const LINEAGE_PAGE_COUNT = 12;

// T3's threadDetailsPanelStyles.ts.
export const HOVER_SURFACE =
  "hover:!bg-black/[0.035] data-pressed:!bg-black/[0.035] dark:hover:!bg-white/[0.08] dark:data-pressed:!bg-white/[0.08]";
export const ROW_CONTENT = "gap-2.5 px-2.5 text-left";
export const CONTROL = `h-8 min-w-0 rounded-lg border-transparent ${ROW_CONTENT} text-[13px] font-medium text-foreground/80`;
export const CONTROL_BASE =
  "relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border outline-none transition-[box-shadow,scale] [&:active]:scale-[0.97] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-default aria-disabled:opacity-64";
export const ROW = `${CONTROL_BASE} ${CONTROL} w-full justify-start bg-transparent shadow-none ${HOVER_SURFACE}`;
export const SPLIT_GROUP = `flex w-full items-center rounded-lg ${HOVER_SURFACE}`;
export const SPLIT_PRIMARY = `${CONTROL_BASE} ${CONTROL} flex-1 justify-start rounded-e-none bg-transparent shadow-none ${HOVER_SURFACE}`;
export const SPLIT_SECONDARY = `${CONTROL_BASE} ${CONTROL} w-8 justify-center rounded-s-none px-0 bg-transparent shadow-none ${HOVER_SURFACE}`;
export const SPLIT_SEPARATOR = "h-4 w-px shrink-0 bg-border/65";

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

/** The section's list, paged as T3 pages it ("Show 12 more"); `extra` rows follow it. */
export function LineageRowList(props: {
  rows: readonly LineageRow[];
  children: (row: LineageRow) => ReactNode;
  extra?: ReactNode;
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
        {props.extra}
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

/** A row's status, T3's label; a failure in red. */
export function Status(props: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 text-2xs",
        props.label === "Failed" ? "text-destructive" : "text-muted-foreground",
        props.className,
      )}
    >
      {props.label}
    </span>
  );
}

/**
 * A row's button with its tooltip. Unavailable, it stays focusable and hoverable
 * (`aria-disabled`, its click ignored), so its tooltip says why to the pointer and
 * the keyboard alike.
 */
export function TipButton(props: {
  tip: string;
  className: string;
  unavailable: boolean;
  label?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <button
            {...(props.label === undefined ? {} : { "aria-label": props.label })}
            aria-disabled={props.unavailable || undefined}
            className={props.className}
            onClick={() => {
              if (!props.unavailable) props.onClick();
            }}
            type="button"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="left">{props.tip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The thread's subagents whose turn runs (D1163): delegated tasks, workflow
 * agents and a runtime's own, as T3 counts its active subagent edges.
 */
export function runningSubagents(thread: ThreadRecord, threads: readonly ThreadRecord[]): number {
  return threads.filter(
    (child) =>
      child.parentThreadId === thread.id &&
      child.relationshipToParent === "subagent" &&
      child.archivedAt === undefined &&
      child.lastTurn?.status === "running",
  ).length;
}

/** The Lineage section (`jhin.chat.lineage`), bound to what it reads and runs. */
export function createLineage(deps: {
  readonly threads: ThreadsCatalog;
  readonly navigation: Navigation;
  readonly commands: PluginContext["commands"];
}): ComponentType<ChatThreadDetailsProps> {
  /** T3's ThreadRelationshipsPanel, for forks: the parent and the forks of the thread. */
  return function Lineage({ target, thread }: ChatThreadDetailsProps) {
    const catalog = useCatalog(deps.threads, target);
    const [merging, setMerging] = useState(false);
    // Until the node's threads are known, a parent cannot be told missing.
    if (catalog?.status !== "ready") return null;
    const rows = lineageRows(thread, catalog.threads);
    const at = {
      node: target.node,
      ...(target.remote === undefined ? {} : { remote: target.remote }),
    };
    const open = (threadId: string) => deps.navigation.navigate({ ...target, thread: threadId });
    const ran = forkRan(thread);
    const running = runningSubagents(thread, catalog.threads);
    const merge = async () => {
      if (merging) return;
      setMerging(true);
      try {
        await deps.commands.execute("thread.merge-back", { ...at, threadId: thread.id });
      } catch {
        // `thread.merge-back` says why in a toast.
      } finally {
        setMerging(false);
      }
    };
    // Other plugins' rows (delegated work, D866) follow the forks; the section shows while any does.
    return (
      <div className="[&:not(:has(li))]:hidden">
        <ThreadDetailsSection
          headingId="thread-details-lineage-heading"
          title={running > 0 ? `Lineage · ${running} running` : "Lineage"}
        >
          <LineageRowList
            rows={rows}
            extra={
              <Slot
                name="chat.thread.lineage"
                props={{ target, thread } satisfies ChatThreadDetailsProps}
              />
            }
          >
            {(row) => {
              const parent = row.relationship === "parent";
              // A parent the node no longer has is named as T3 names it, not by its id.
              const title = row.thread?.title ?? "Source conversation";
              const relationship = parent ? "Parent thread" : "Fork";
              const missing = row.thread === undefined;
              // The parent row shows the fork's status, as T3's edge does.
              const status = lineageStatusLabel(parent ? thread : row.thread);
              const Icon = parent ? CornerLeftUpIcon : GitForkIcon;
              const link = (className: string, label?: string) => (
                <TipButton
                  className={className}
                  {...(label === undefined ? {} : { label })}
                  onClick={() => open(row.threadId)}
                  tip={
                    missing
                      ? "This related thread is unavailable"
                      : `Open ${relationship.toLowerCase()} in this chat`
                  }
                  unavailable={missing}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                      {title}
                    </span>
                  </span>
                  {parent ? null : (
                    <>
                      <ArrowRightIcon
                        aria-hidden
                        className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      />
                      <Status label={status} />
                    </>
                  )}
                </TipButton>
              );
              return (
                <li className="group relative flex h-8 items-center rounded-lg" key={row.threadId}>
                  {parent ? (
                    <div className={SPLIT_GROUP}>
                      {link(SPLIT_PRIMARY, `${title} ${status}`)}
                      <span aria-hidden="true" className={SPLIT_SEPARATOR} />
                      <TipButton
                        className={SPLIT_SECONDARY}
                        label={
                          missing ? "Merge back to source conversation" : `Merge back to ${title}`
                        }
                        onClick={() => void merge()}
                        unavailable={!ran || merging || missing}
                        tip={
                          missing
                            ? "This related thread is unavailable"
                            : !ran
                              ? "Complete a run in this fork before merging it back"
                              : `Merge this conversation back into ${title}`
                        }
                      >
                        {merging ? (
                          <LoaderCircleIcon className="size-3 animate-spin" />
                        ) : (
                          <GitMergeIcon className="size-3" />
                        )}
                      </TipButton>
                      <Status
                        className="border border-transparent ps-1 pe-2.5 font-medium"
                        label={status}
                      />
                    </div>
                  ) : (
                    link(ROW)
                  )}
                </li>
              );
            }}
          </LineageRowList>
        </ThreadDetailsSection>
      </div>
    );
  };
}
