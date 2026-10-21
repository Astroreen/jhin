import { OrchestrationThreadEvents, ThreadEvents } from "@jhin/agent-api";
import type {
  ChatThreadDetailsProps,
  ChatTurnItemProps,
  NodeTarget,
  ThreadsCatalog,
} from "@jhin/client-api";
import type { Toasts } from "@jhin/ui";
import { useSyncExternalStore } from "react";

import { useCatalog } from "../../lib/hooks.ts";
import { DelegationLineage } from "./lineage.tsx";
import { LaunchedRow, runOfTask, SubagentRow, WorkflowBlock, type WorkflowMark } from "./rows.tsx";
import type { DelegationStore } from "./store.ts";

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
      run={runOfTask(task)}
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

/** A subagent the agent ran itself, followed by its thread's last turn (D879). */
function ProviderSubagent({ target, event, services }: Props) {
  const { childThreadId, title } = event.payload as { childThreadId: string; title: string };
  const catalog = useCatalog(services.threads, target);
  const child = catalog?.threads.find((item) => item.id === childThreadId);
  const turn = child?.lastTurn;
  return (
    <SubagentRow
      title={child?.title ?? title}
      // As the bar says it: starting until its thread's turn is known (D880).
      status={turn === undefined ? "starting" : turn.status}
      run={
        turn === undefined
          ? undefined
          : {
              startedAt: child?.createdAt ?? turn.at,
              ...(turn.status === "running" || turn.status === "waiting"
                ? {}
                : { endedAt: turn.at }),
            }
      }
      onOpen={() => services.open(target, childThreadId)}
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
  if (type === ThreadEvents.subagentStarted) {
    return text("childThreadId", "title") ? <ProviderSubagent {...props} /> : null;
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
