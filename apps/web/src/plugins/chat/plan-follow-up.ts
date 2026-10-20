// "Implement this plan" follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/ChatView.tsx (onImplementPlan, onImplementPlanInNewThread) at eb7b35ac.
import type { Navigation, NodeTarget, ThreadRecord, ThreadsCatalog } from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";

import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../../lib/proposed-plan.ts";
import { startThread } from "../../lib/thread-actions.ts";
import { actionablePlan, reduceTimeline } from "../../lib/timeline.ts";
import { sendMessage } from "./follow-ups.ts";

class PlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Sends a thread's latest proposed plan to be implemented (D306): in build
 * mode, in the thread itself or in a new thread of its project titled after
 * the plan, with the thread's agent and model. Resolves with the thread that
 * runs it.
 */
export async function implementPlan(
  deps: { readonly threads: Pick<ThreadsCatalog, "call">; readonly navigation?: Navigation },
  input: { readonly target: NodeTarget; readonly threadId: string; readonly newThread: boolean },
): Promise<{ readonly threadId: string }> {
  const { threads, navigation } = deps;
  const { target, threadId } = input;
  const [events, thread] = await Promise.all([
    threads.call<StoredEvent[]>(target, "threads.events", { threadId }),
    threads.call<ThreadRecord>(target, "threads.get", { threadId }),
  ]);
  const plan = actionablePlan(reduceTimeline(events));
  if (plan === undefined) {
    throw new PlanError("PLAN_NOT_FOUND", "This thread has no proposed plan to implement");
  }
  const selection = {
    ...(thread.agentId === undefined ? {} : { agentId: thread.agentId }),
    ...(thread.model === undefined ? {} : { model: thread.model }),
    ...(thread.runtimeMode === undefined ? {} : { runtimeMode: thread.runtimeMode }),
    interactionMode: "default",
  };
  const text = buildPlanImplementationPrompt(plan.markdown);
  if (!input.newThread) {
    const outcome = await sendMessage(threads, target, threadId, {
      text,
      attachments: [],
      settings: selection,
    });
    if (outcome.kind === "busy") {
      throw new PlanError("TURN_IN_PROGRESS", "The thread is running a turn");
    }
    if (outcome.kind === "failed") throw new PlanError("SEND_FAILED", outcome.message);
    return { threadId };
  }
  const started = await startThread(threads, target, {
    projectId: thread.projectId,
    title: buildPlanImplementationThreadTitle(plan.markdown),
    text,
    attachments: [],
    selection,
  });
  navigation?.navigate({
    node: target.node,
    ...(target.remote === undefined ? {} : { remote: target.remote }),
    thread: started.threadId,
  });
  return { threadId: started.threadId };
}
