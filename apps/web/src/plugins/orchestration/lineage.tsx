// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadRelationshipsControl.tsx (the subagent rows
// and "Stop subagent") and ThreadLineageWorkflowRow.tsx (the workflow row, its
// phases and "Stop entire workflow"). Decisions: docs/plans/orchestration.md (D866–D868).
import type { ChatThreadDetailsProps, NodeTarget } from "@jhin/client-api";
import { Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import {
  BotIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  LoaderCircleIcon,
  SquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { useCatalog } from "../../lib/hooks.ts";
import {
  ROW,
  ROW_CONTENT,
  SPLIT_GROUP,
  SPLIT_PRIMARY,
  SPLIT_SECONDARY,
  SPLIT_SEPARATOR,
  Status,
  TipButton,
  lineageStatusLabel,
} from "../chat/lineage.tsx";
import type { TaskRecord, TaskStatus, WorkflowRecord } from "./store.ts";
import type { DelegatedWorkServices } from "./view.tsx";

type Props = ChatThreadDetailsProps & {
  readonly services: DelegatedWorkServices;
  readonly view: {
    readonly tasks: ReadonlyMap<string, TaskRecord>;
    readonly workflows: ReadonlyMap<string, WorkflowRecord>;
  };
};

/** T3's threadRelationshipStatusLabel for a task or an agent. */
export function taskStatusLabel(status: TaskStatus | "starting"): string {
  switch (status) {
    case "starting":
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return "Stopped";
  }
}

const live = (status: string) =>
  status === "starting" || status === "running" || status === "waiting";

const workflowStatusLabel = (status: WorkflowRecord["status"]) =>
  status === "running"
    ? "Running"
    : status === "completed"
      ? "Done"
      : status === "failed"
        ? "Failed"
        : "Stopped";

const STOP_HOVER =
  "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100";

function StopButton(props: {
  label: string;
  tip: string;
  stopping: boolean;
  disabled: boolean;
  className: string;
  onClick: () => void;
}) {
  return (
    <div className={cn(STOP_HOVER, props.className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={props.label}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-destructive/80 hover:bg-destructive/10 hover:text-destructive disabled:opacity-64"
              disabled={props.disabled}
              onClick={props.onClick}
              type="button"
            />
          }
        >
          {props.stopping ? (
            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
          ) : (
            <SquareIcon aria-hidden className="size-3 fill-current" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="left">{props.tip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function Title(props: { text: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
        {props.text}
      </span>
    </span>
  );
}

function WorkflowRow(props: {
  workflow: WorkflowRecord;
  stopping: boolean;
  busy: boolean;
  onStop: () => void;
  open: (threadId: string) => void;
}) {
  const { workflow } = props;
  const [expanded, setExpanded] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const running = workflow.status === "running";
  const status = workflowStatusLabel(workflow.status);
  const phases = workflow.phases
    .map((phase) => ({
      title: phase.title,
      members: workflow.agents.filter((agent) => agent.phase === phase.title),
    }))
    .filter((phase) => phase.members.length > 0);
  const unphased = workflow.agents.filter(
    (agent) => !workflow.phases.some((phase) => phase.title === agent.phase),
  );
  const member = (agent: WorkflowRecord["agents"][number]) => {
    const title = agent.label ?? `Agent ${agent.index + 1}`;
    const threadId = agent.childThreadId;
    return (
      <li className="group relative flex h-8 items-center rounded-lg" key={agent.index}>
        <TipButton
          className={ROW}
          label={`Open ${title} chat`}
          onClick={() => threadId !== undefined && props.open(threadId)}
          tip={
            threadId === undefined
              ? "This related thread is unavailable"
              : "Open subagent in this chat"
          }
          unavailable={threadId === undefined}
        >
          <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Title text={title} />
          <Status label={taskStatusLabel(agent.status)} />
        </TipButton>
      </li>
    );
  };
  return (
    <li className="group" data-workflow-expanded={expanded ? "" : undefined}>
      <div className={cn("relative", SPLIT_GROUP)}>
        <button
          aria-label={`${workflow.name} ${status}`}
          className={SPLIT_PRIMARY}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <WorkflowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Title text={workflow.name} />
          <Status
            className={running ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}
            label={status}
          />
        </button>
        {running ? (
          <StopButton
            className="right-9"
            disabled={props.busy}
            label={`Stop workflow ${workflow.name}`}
            onClick={props.onStop}
            stopping={props.stopping}
            tip="Stop entire workflow"
          />
        ) : null}
        <span aria-hidden="true" className={SPLIT_SEPARATOR} />
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${workflow.name}`}
          className={SPLIT_SECONDARY}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 ps-6.5">
          {phases.map((phase) => {
            const phaseRunning = phase.members.some((agent) => live(agent.status));
            const open = phaseOpen.get(phase.title) ?? phaseRunning;
            const settled = phase.members.filter((agent) => !live(agent.status)).length;
            const failed = phase.members.some((agent) => agent.status === "failed");
            const stopped = phase.members.some(
              (agent) => agent.status === "cancelled" || agent.status === "interrupted",
            );
            const phaseStatus = phaseRunning
              ? "running"
              : failed
                ? "failed"
                : stopped
                  ? "stopped"
                  : "done";
            return (
              <li key={phase.title}>
                <button
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${phase.title} phase, ${phaseStatus}`}
                  className={cn(
                    "flex h-7 w-full cursor-pointer items-center rounded-lg text-xs font-medium",
                    ROW_CONTENT,
                    phaseRunning ? "text-foreground/80" : "text-muted-foreground",
                  )}
                  onClick={() => setPhaseOpen((map) => new Map(map).set(phase.title, !open))}
                  type="button"
                >
                  <ChevronDownIcon
                    aria-hidden
                    className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
                  />
                  <span className="min-w-0 flex-1 truncate">{phase.title}</span>
                  {failed ? (
                    <span className="shrink-0 text-2xs text-destructive">Failed</span>
                  ) : null}
                  <span className="shrink-0 text-2xs font-normal tabular-nums">
                    {settled}/{phase.members.length}{" "}
                    {phase.members.length === 1 ? "agent" : "agents"}
                  </span>
                </button>
                {open ? <ul className="m-0 list-none p-0">{phase.members.map(member)}</ul> : null}
              </li>
            );
          })}
          {unphased.map(member)}
          {workflow.agents.length === 0 ? (
            <li className="px-2.5 py-1.5 text-2xs text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** A thread's delegated work as rows of its Lineage section (D867). */
export function DelegationLineage({ target, thread, services, view }: Props) {
  const catalog = useCatalog(services.threads, target);
  const [stopping, setStopping] = useState<string | null>(null);
  const open = (threadId: string) => services.open(target, threadId);
  const stop = async (key: string, method: string, input: Record<string, string>) => {
    if (stopping !== null) return;
    setStopping(key);
    try {
      await services.threads.call(target as NodeTarget, method, {
        ...input,
        parentThreadId: thread.id,
      });
    } catch (error) {
      services.toasts?.show({
        type: "error",
        title: "Could not stop",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStopping(null);
    }
  };
  const parentId = thread.relationshipToParent === "subagent" ? thread.parentThreadId : undefined;
  const parent =
    parentId === undefined ? undefined : catalog?.threads.find((item) => item.id === parentId);
  const tasks = [...view.tasks.values()]
    .filter((task) => task.workflowId === undefined)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  // The subagents the agent ran itself (D880): threads, not tasks.
  const providerSubagents = (catalog?.threads ?? [])
    .filter((item) => item.parentThreadId === thread.id && item.subagentOrigin === "provider")
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const workflows = [...view.workflows.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  return (
    <>
      {parentId === undefined ? null : (
        <li className="group relative flex h-8 items-center rounded-lg">
          <TipButton
            className={ROW}
            label={`${parent?.title ?? "Parent thread"} ${lineageStatusLabel(thread)}`}
            onClick={() => open(parentId)}
            tip={
              parent === undefined
                ? "This related thread is unavailable"
                : "Open parent thread in this chat"
            }
            unavailable={parent === undefined}
          >
            <CornerLeftUpIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <Title text={parent?.title ?? "Parent thread"} />
            <Status label={lineageStatusLabel(thread)} />
          </TipButton>
        </li>
      )}
      {tasks.map((task) => {
        const running = live(task.status);
        const status = taskStatusLabel(task.status);
        return (
          <li className="group relative flex h-8 items-center rounded-lg" key={task.taskId}>
            <TipButton
              className={ROW}
              label={`Open ${task.title} chat`}
              onClick={() => open(task.childThreadId)}
              tip="Open subagent in this chat"
              unavailable={false}
            >
              <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Title text={task.title} />
              <Status
                className={running ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}
                label={status}
              />
            </TipButton>
            {running ? (
              <StopButton
                className="right-1"
                disabled={stopping !== null}
                label={`Stop subagent ${task.title}`}
                onClick={() => void stop(task.taskId, "tasks.cancel", { taskId: task.taskId })}
                stopping={stopping === task.taskId}
                tip="Stop subagent"
              />
            ) : null}
          </li>
        );
      })}
      {providerSubagents.map((child) => (
        <li className="group relative flex h-8 items-center rounded-lg" key={child.id}>
          <TipButton
            className={ROW}
            label={`Open ${child.title} chat`}
            onClick={() => open(child.id)}
            tip="Open subagent in this chat"
            unavailable={false}
          >
            <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <Title text={child.title} />
            <Status label={lineageStatusLabel(child)} />
          </TipButton>
        </li>
      ))}
      {workflows.map((workflow) => (
        <WorkflowRow
          busy={stopping !== null}
          key={workflow.workflowId}
          onStop={() =>
            void stop(workflow.workflowId, "workflows.stop", { workflowId: workflow.workflowId })
          }
          open={open}
          stopping={stopping === workflow.workflowId}
          workflow={workflow}
        />
      ))}
    </>
  );
}
