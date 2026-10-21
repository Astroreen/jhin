import { OrchestrationThreadEvents } from "@jhin/agent-api";
import type { ChatTurnItemProps, NodeTarget } from "@jhin/client-api";
import { useSyncExternalStore } from "react";

import { LaunchedRow, SubagentRow, WorkflowBlock, type WorkflowMark } from "./rows.tsx";
import type { DelegationStore } from "./store.ts";

interface TaskMark {
  readonly taskId: string;
  readonly childThreadId: string;
  readonly title: string;
}

export interface DelegatedWorkServices {
  readonly store: DelegationStore;
  readonly open: (target: NodeTarget, threadId: string) => void;
}

type Props = ChatTurnItemProps & { readonly services: DelegatedWorkServices };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

function useDelegation({ store }: DelegatedWorkServices, target: NodeTarget, threadId: string) {
  return useSyncExternalStore(store.watch(target, threadId), () => store.view(target, threadId));
}

function Subagent({ target, thread, event, services }: Props) {
  const view = useDelegation(services, target, thread.id);
  const mark = event.payload as TaskMark;
  const task = view.tasks.get(mark.taskId);
  return (
    <SubagentRow
      title={task?.title ?? mark.title}
      status={task?.status ?? (view.status === "loading" ? "starting" : "unknown")}
      task={task}
      onOpen={() => services.open(target, mark.childThreadId)}
    />
  );
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
  if (type === OrchestrationThreadEvents.taskDelegated) {
    return text("taskId", "childThreadId", "title") ? <Subagent {...props} /> : null;
  }
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
