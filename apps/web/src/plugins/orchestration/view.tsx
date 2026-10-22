import { OrchestrationThreadEvents, ThreadEvents } from "@jhin/agent-api";
import type {
  ChatThreadDetailsProps,
  ChatTurnItemProps,
  NodeTarget,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import type { Toasts } from "@jhin/ui";
import { useSyncExternalStore } from "react";

import { useCatalog } from "../../lib/hooks.ts";
import { DelegationLineage } from "./lineage.tsx";
import {
  LaunchedRow,
  runOfTask,
  SubagentGroup,
  SubagentRow,
  WorkflowBlock,
  type SubagentDetails,
  type SubagentMember,
  type WorkflowMark,
} from "./rows.tsx";
import type { DelegationStore, DelegationView } from "./store.ts";

export { createDelegationStore } from "./store.ts";

interface TaskMark {
  readonly taskId: string;
  readonly childThreadId: string;
  readonly title: string;
}

export interface DelegatedWorkServices {
  readonly store: DelegationStore;
  readonly open: (target: NodeTarget, threadId: string) => void;
  readonly threads: ThreadsCatalog;
  readonly toasts: Toasts | undefined;
}

type Props = ChatTurnItemProps & { readonly services: DelegatedWorkServices };
type Mark = ChatTurnItemProps["event"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

/** A mark of a subagent: a delegated task (D864) or one the runtime ran itself (D879). */
function isSubagentMark(event: Mark): boolean {
  const { type, payload } = event;
  if (!isRecord(payload)) return false;
  const text = (...keys: string[]) => keys.every((key) => typeof payload[key] === "string");
  if (type === OrchestrationThreadEvents.taskDelegated) {
    return text("taskId", "childThreadId", "title");
  }
  return type === ThreadEvents.subagentStarted && text("childThreadId", "title");
}

/** The subagent marks in a row (nothing else between) that `event` is one of (D1161). */
export function subagentRun(event: Mark, adjacent: readonly Mark[] | undefined): readonly Mark[] {
  const marks = adjacent ?? [event];
  const index = marks.findIndex((mark) => mark.sequence === event.sequence);
  if (index === -1 || !isSubagentMark(event)) return [event];
  let first = index;
  while (first > 0 && isSubagentMark(marks[first - 1]!)) first -= 1;
  let last = index;
  while (last < marks.length - 1 && isSubagentMark(marks[last + 1]!)) last += 1;
  return marks.slice(first, last + 1);
}

/** T3 shows the effort a child runs with; the option's id differs between runtimes. */
const EFFORT_OPTIONS = ["reasoningEffort", "effort", "reasoning", "variant"];

/** The hover card's details of a child thread (D1162). */
export function childDetails(
  child: ThreadRecord | undefined,
  parent: ThreadRecord,
  fallback: { agentId?: string; model?: string } = {},
): SubagentDetails {
  const agentId = child?.agentId ?? child?.lastTurn?.agentId ?? fallback.agentId;
  const model = child?.model ?? fallback.model;
  const effort = EFFORT_OPTIONS.map(
    (id) => child?.modelOptions?.find((option) => option.id === id)?.value,
  ).find((value): value is string => typeof value === "string" && value !== "");
  const worktree =
    child?.worktreePath !== undefined && child.worktreePath !== parent.worktreePath
      ? child.worktreePath
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .at(-1)
      : undefined;
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(worktree === undefined || worktree === "" ? {} : { worktree }),
  };
}

/** What a subagent mark's row shows, from the node's records and catalog. */
export function subagentMember(
  mark: Mark,
  context: {
    readonly view: DelegationView;
    readonly threads: readonly ThreadRecord[];
    readonly parent: ThreadRecord;
    readonly open: (threadId: string) => void;
  },
): SubagentMember {
  const key = String(mark.sequence);
  if (mark.type === OrchestrationThreadEvents.taskDelegated) {
    const { taskId, childThreadId, title } = mark.payload as TaskMark;
    const task = context.view.tasks.get(taskId);
    const child = context.threads.find((thread) => thread.id === childThreadId);
    return {
      key,
      title: task?.title ?? title,
      status: task?.status ?? (context.view.status === "loading" ? "starting" : "unknown"),
      run: runOfTask(task),
      onOpen: () => context.open(childThreadId),
      details: childDetails(child, context.parent, {
        ...(task === undefined ? {} : { agentId: task.agentId }),
        ...(task?.model === undefined ? {} : { model: task.model }),
      }),
    };
  }
  const { childThreadId, title } = mark.payload as { childThreadId: string; title: string };
  const child = context.threads.find((thread) => thread.id === childThreadId);
  const turn = child?.lastTurn;
  return {
    key,
    title: child?.title ?? title,
    // As the bar says it: starting until its thread's turn is known (D880).
    status: turn === undefined ? "starting" : turn.status,
    run:
      turn === undefined
        ? undefined
        : {
            startedAt: child?.createdAt ?? turn.at,
            ...(turn.status === "running" || turn.status === "waiting" ? {} : { endedAt: turn.at }),
          },
    onOpen: () => context.open(childThreadId),
    details: childDetails(child, context.parent),
  };
}

function useDelegation({ store }: DelegatedWorkServices, target: NodeTarget, threadId: string) {
  return useSyncExternalStore(store.watch(target, threadId), () => store.view(target, threadId));
}

/** A subagent's row, or the "N subagents" row its group shows at the first of them (D1161). */
function Subagents({ target, thread, event, adjacent, services }: Props) {
  const view = useDelegation(services, target, thread.id);
  const catalog = useCatalog(services.threads, target);
  const marks = subagentRun(event, adjacent);
  if (marks[0]!.sequence !== event.sequence) return null;
  const context = {
    view,
    threads: catalog?.threads ?? [],
    parent: thread,
    open: (threadId: string) => services.open(target, threadId),
  };
  if (marks.length > 1) {
    return <SubagentGroup members={marks.map((mark) => subagentMember(mark, context))} />;
  }
  const { key: _key, ...member } = subagentMember(event, context);
  return <SubagentRow {...member} />;
}

function Workflow({ target, thread, event, services }: Props) {
  const view = useDelegation(services, target, thread.id);
  const mark = event.payload as WorkflowMark;
  return (
    <WorkflowBlock
      mark={mark}
      workflow={view.workflows.get(mark.workflowId)}
      tasks={view.tasks}
      onOpen={(threadId) => services.open(target, threadId)}
    />
  );
}

/** A mark of delegated work in its turn (D864). */
export function DelegatedWork(props: Props) {
  const { type, payload } = props.event;
  if (!isRecord(payload)) return null;
  // A mark missing what it names (another version wrote it) is not shown.
  const text = (...keys: string[]) => keys.every((key) => typeof payload[key] === "string");
  if (isSubagentMark(props.event)) return <Subagents {...props} />;
  if (type === OrchestrationThreadEvents.workflowStarted) {
    return text("workflowId", "name", "description", "script") && Array.isArray(payload.phases) ? (
      <Workflow {...props} />
    ) : null;
  }
  if (type === OrchestrationThreadEvents.threadLaunched && text("threadId", "title")) {
    const { threadId, title } = payload as { threadId: string; title: string };
    return <LaunchedRow title={title} onOpen={() => props.services.open(props.target, threadId)} />;
  }
  return null;
}

/** The thread's delegated work in its Lineage section (D866, D867). */
export function Lineage(
  props: ChatThreadDetailsProps & { readonly services: DelegatedWorkServices },
) {
  const view = useDelegation(props.services, props.target, props.thread.id);
  return <DelegationLineage {...props} view={view} />;
}
