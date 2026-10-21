// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/V2LifecycleRow.tsx (SubagentTimelineLink, the
// created-thread row), WorkflowOpeningBlock.tsx, AgentElapsed.tsx and
// workflowOpeningHeadline of packages/client-runtime/src/state/subagentRuntime.ts.
// Decisions: docs/plans/orchestration.md (D864).
import { Button, cn, InlineButton } from "@jhin/ui";
import { ChevronRightIcon, MessageSquareIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MessageText } from "../chat/message-text.tsx";
import type { TaskRecord, TaskStatus, WorkflowRecord } from "./store.ts";

/** `unknown`: no record of the task here (yet, or any more): no live state is claimed. */
type RowStatus = TaskStatus | "starting" | "unknown";

const STATUS_VISUALS: Record<RowStatus, { dotClass: string; label: string }> = {
  unknown: { dotClass: "bg-muted-foreground/40", label: "Status unavailable" },
  starting: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

const isLive = (status: RowStatus) =>
  status === "starting" || status === "running" || status === "waiting";

/** T3 names no result for a child that ended without one. */
const GENERIC_CHILD_END =
  /^Child task (ended with status\b|completed without an assistant result)/i;

function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Time since the task started, until it ended; a live one ticks without re-rendering. */
function Elapsed(props: { status: RowStatus; startedAt?: string; endedAt?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const live = isLive(props.status);
  const { startedAt, endedAt } = props;
  const text = (nowMs: number) => {
    if (startedAt === undefined) return "";
    const end = endedAt === undefined ? nowMs : Date.parse(endedAt);
    const elapsed = end - Date.parse(startedAt);
    return Number.isFinite(elapsed) ? formatElapsedSeconds(elapsed / 1000) : "";
  };
  useEffect(() => {
    const update = () => {
      if (ref.current) ref.current.textContent = text(Date.now());
    };
    update();
    if (!live || endedAt !== undefined) return;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  });
  if (startedAt === undefined) return null;
  return <span ref={ref} className="tabular-nums" />;
}

const ROW_CLASS =
  "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";

/** One delegated agent: T3's subagent row, opening its thread. */
export function SubagentRow(props: {
  readonly title: string;
  readonly status: RowStatus;
  readonly task: TaskRecord | undefined;
  readonly onOpen: (() => void) | undefined;
}) {
  const { status, task } = props;
  const visual = STATUS_VISUALS[status];
  const settled = !isLive(status);
  const raw = settled ? task?.summary?.trim() : undefined;
  const detail = raw && !GENERIC_CHILD_END.test(raw) ? plainDetail(raw) || null : null;
  const failed = status === "failed";
  const content = (
    <>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", visual.dotClass)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {props.title}
          </span>
          {detail !== null && status !== "completed" ? (
            <span
              className={cn(
                "shrink-0 text-3xs",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {visual.label}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "block truncate text-2xs leading-relaxed",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail ?? visual.label}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        <Elapsed
          status={status}
          {...(task === undefined ? {} : { startedAt: task.createdAt })}
          {...(task?.endedAt === undefined ? {} : { endedAt: task.endedAt })}
        />
      </span>
      {props.onOpen === undefined ? null : (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
        />
      )}
    </>
  );
  return props.onOpen === undefined ? (
    <div aria-description={visual.label} className={ROW_CLASS}>
      {content}
    </div>
  ) : (
    <button
      type="button"
      aria-label={`Open ${props.title}`}
      aria-description={visual.label}
      onClick={props.onOpen}
      className={cn(
        ROW_CLASS,
        "cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      {content}
    </button>
  );
}

/** The mark of `orchestration.workflow.started` (D862). */
export interface WorkflowMark {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly phases: readonly { readonly title: string }[];
  readonly script: string;
}

type Member = WorkflowRecord["agents"][number];

const settledKey = (status: RowStatus) =>
  isLive(status)
    ? "working"
    : status === "completed"
      ? "done"
      : status === "failed"
        ? "failed"
        : "stopped";

/** "N agents · 1 working · 2 done", as T3's workflow headline counts them. */
export function workflowAgentsLabel(members: readonly Member[]): string | null {
  if (members.length === 0) return null;
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = settledKey(member.status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return `${members.length} ${members.length === 1 ? "agent" : "agents"} · ${[
    "working",
    "done",
    "failed",
    "stopped",
  ]
    .filter((key) => counts.has(key))
    .map((key) => `${counts.get(key)} ${key}`)
    .join(" · ")}`;
}

const MAX_FOLDED_LINES = 8;
const MAX_FOLDED_LENGTH = 600;
const FOLDED_SCRIPT_MASK = "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

/** The script as a fenced block, so it renders like any other code in the thread. */
function scriptMarkdown(script: string) {
  const longestRun = Math.max(2, ...(script.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}javascript\n${script.trimEnd()}\n${fence}`;
}

function WorkflowScript(props: { readonly script: string }) {
  const [expanded, setExpanded] = useState(false);
  const canFold =
    props.script.length > MAX_FOLDED_LENGTH || props.script.split("\n").length > MAX_FOLDED_LINES;
  const folded = canFold && !expanded;
  return (
    <div>
      <div
        className={cn("relative", folded && "max-h-44 overflow-hidden")}
        style={
          folded
            ? { WebkitMaskImage: FOLDED_SCRIPT_MASK, maskImage: FOLDED_SCRIPT_MASK }
            : undefined
        }
      >
        <MessageText text={scriptMarkdown(props.script)} />
      </div>
      {canFold ? (
        <div className="-ms-1">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full script"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A workflow the thread started: T3's opening block, its plan, its agents, then the script. */
export function WorkflowBlock(props: {
  readonly mark: WorkflowMark;
  readonly workflow: WorkflowRecord | undefined;
  readonly tasks: ReadonlyMap<string, TaskRecord>;
  readonly onOpen: (threadId: string) => void;
}) {
  const { mark, workflow } = props;
  const title = mark.name || mark.description || "Workflow";
  const description =
    mark.description !== "" && mark.description !== title ? mark.description : null;
  const members = workflow?.agents ?? [];
  const agents = workflowAgentsLabel(members);
  const phases = mark.phases
    .map((phase) => ({
      title: phase.title,
      members: members.filter((member) => member.phase === phase.title),
    }))
    .filter((phase) => phase.members.length > 0);
  const unphased = members.filter(
    (member) => !mark.phases.some((phase) => phase.title === member.phase),
  );
  const row = (member: Member) => {
    const threadId = member.childThreadId;
    return (
      <li key={member.index}>
        <SubagentRow
          title={member.label ?? `Agent ${member.index + 1}`}
          status={member.status}
          task={member.taskId === undefined ? undefined : props.tasks.get(member.taskId)}
          onOpen={threadId === undefined ? undefined : () => props.onOpen(threadId)}
        />
      </li>
    );
  };
  return (
    <section
      aria-label={`Workflow started: ${title}`}
      className="flex min-w-0 flex-col gap-3 px-1 py-0.5"
    >
      <header className="flex min-w-0 items-start gap-2">
        <WorkflowIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-2xs font-medium text-muted-foreground">Workflow started</p>
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {agents ? (
          <span aria-live="polite" className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {agents}
          </span>
        ) : null}
      </header>
      {phases.map((phase) => (
        <section key={phase.title} aria-label={`${phase.title} phase`}>
          <h4 className="flex items-baseline gap-2 px-2 pb-0.5 text-2xs font-medium text-muted-foreground">
            <span className="min-w-0 truncate">{phase.title}</span>
            <span className="shrink-0 font-normal tabular-nums">
              {phase.members.filter((member) => !isLive(member.status)).length}/
              {phase.members.length}
            </span>
          </h4>
          <ul className="m-0 list-none p-0">{phase.members.map(row)}</ul>
        </section>
      ))}
      {unphased.length > 0 ? <ul className="m-0 list-none p-0">{unphased.map(row)}</ul> : null}
      <WorkflowScript script={mark.script} />
    </section>
  );
}

/** A thread the agent launched: T3's created-thread row. */
export function LaunchedRow(props: { readonly title: string; readonly onOpen: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
      <MessageSquareIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
      <span className="min-w-0 flex-1 truncate">
        Created thread{props.title ? ` · ${props.title}` : ""}
      </span>
      <InlineButton aria-label={`Open ${props.title || "created thread"}`} onClick={props.onOpen}>
        Open chat
      </InlineButton>
    </div>
  );
}
