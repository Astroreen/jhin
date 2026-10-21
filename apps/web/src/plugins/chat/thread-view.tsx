// The layout and scroll behaviour follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/ChatView.tsx and chat/MessagesTimeline.tsx.
import type { AgentResponse, StoredAttachment, TurnAttachment } from "@jhin/agent-api";
import {
  targetKey,
  visitKey,
  type ChatDrawerProps,
  type ChatTurnFooterProps,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
} from "@jhin/client-api";
import { Alert, AlertAction, AlertDescription, Button, Slot } from "@jhin/ui";
import { ArchiveRestoreIcon, ChevronDownIcon, CircleAlertIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { buildPromptHistory, newThreadDraftKey, threadDraftKey } from "../../lib/composer.ts";
import { useCatalog } from "../../lib/hooks.ts";
import { downloadAttachment } from "../../lib/uploads.ts";
import { CHAT_SECTION, ChatSettings, useSection } from "../../lib/settings.ts";
import { wokeAt } from "../../lib/sidebar-order.ts";
import { startThread, threadMayExist } from "../../lib/thread-actions.ts";
import { proposedPlanTitle } from "../../lib/proposed-plan.ts";
import { actionablePlan, openRequests } from "../../lib/timeline.ts";
import {
  Composer,
  type ComposerHandleApi,
  type QueueActions,
  type Selection,
} from "./composer.tsx";
import { ChatHeader } from "./header.tsx";
import { dispatchMode, sendMessage } from "./send.ts";
import { useAgents, useChat } from "./services.ts";
import { useThreadTimeline } from "./thread-timeline.ts";
import { useUnconfirmed } from "./unconfirmed.ts";
import { AttachmentLoaderContext, TimelineView } from "./timeline.tsx";

/** Stick to the end while the user is there; a pill brings them back otherwise. */
function useStickToEnd(dependency: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const [showPill, setShowPill] = useState(false);
  useEffect(() => {
    if (atEnd) {
      setShowPill(false);
      return;
    }
    const timer = setTimeout(() => setShowPill(true), 150);
    return () => clearTimeout(timer);
  }, [atEnd]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    const end = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
    following.current = end;
    setAtEnd(end);
  };
  const scrollToEnd = () => {
    const element = scroller.current;
    following.current = true;
    setAtEnd(true);
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };
  return { scroller, onScroll, showPill, scrollToEnd };
}

/** The composer's height, so the timeline's end can scroll clear of it. */
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setHeight(element.getBoundingClientRect().height));
    observer.observe(element);
    setHeight(element.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

const selectionOf = (thread: ThreadRecord): Selection => ({
  ...(thread.agentId === undefined ? {} : { agentId: thread.agentId }),
  ...(thread.model === undefined ? {} : { model: thread.model }),
  ...(thread.runtimeMode === undefined ? {} : { runtimeMode: thread.runtimeMode }),
  ...(thread.interactionMode === undefined ? {} : { interactionMode: thread.interactionMode }),
  ...(thread.modelOptions === undefined ? {} : { modelOptions: thread.modelOptions }),
});

export function ThreadView(props: {
  target: NodeTarget;
  thread: ThreadRecord | undefined;
  threadId: string;
  project: ProjectRecord | undefined;
  nodeLabel: string;
  connected: boolean;
}) {
  const { target, threadId, thread } = props;
  const chat = useChat();
  const settings = useSection(chat.context, CHAT_SECTION, ChatSettings);
  const {
    timeline,
    count,
    error: openError,
  } = useThreadTimeline(chat.threads, chat.connections, target, threadId);
  const catalog = useCatalog(chat.threads, target);
  const lastTurn = timeline.turns.at(-1);
  const running = lastTurn?.state === "running";
  const requests = useMemo(() => openRequests(timeline), [timeline]);
  const history = useMemo(
    () => buildPromptHistory(timeline.turns.map((turn) => ({ id: turn.turnId, text: turn.text }))),
    [timeline],
  );
  const [error, setError] = useState<string | undefined>();
  const [selection, setSelection] = useState<Selection>(() =>
    thread === undefined ? {} : selectionOf(thread),
  );
  const composer = useHeight<HTMLDivElement>();
  const { scroller, onScroll, showPill, scrollToEnd } = useStickToEnd(count);
  const handle = useRef<ComposerHandleApi>(null);

  // The thread's settings follow its record when they change elsewhere.
  const recordSelection = thread === undefined ? undefined : JSON.stringify(selectionOf(thread));
  useEffect(() => {
    if (thread !== undefined) setSelection(selectionOf(thread));
  }, [recordSelection]);

  // Seen while open: a turn that ends here is not "unread". Visits are the
  // node's own times (the thread's last change), so clocks never disagree.
  // A snoozed thread that woke is seen as of its wake too, so its card stops
  // saying "Woke" (D77).
  const seenAt = thread?.lastTurn?.at ?? thread?.updatedAt ?? thread?.createdAt;
  const snooze = thread === undefined ? undefined : `${thread.snoozedUntil}|${thread.snoozedAt}`;
  useEffect(() => {
    if (seenAt === undefined || thread === undefined) return;
    chat.visits?.visit(target, threadId, seenAt);
    const woke = wokeAt(thread, Date.now());
    if (woke !== undefined) chat.visits?.visit(target, threadId, woke);
  }, [seenAt, snooze, targetKey(target), threadId]);

  // Commands reach this composer, which has focus when the thread opens (as in T3 Code).
  useEffect(() => {
    chat.composer.current = {
      draftKey: threadDraftKey(target, threadId),
      restore: (draft) => handle.current?.restore(draft),
      draft: () => handle.current?.draft(),
      focus: () => handle.current?.focus(),
      toggleModelPicker: () => handle.current?.toggleModelPicker(),
      cycleRuntimeMode: () => handle.current?.cycleRuntimeMode(),
      togglePlanMode: () => handle.current?.togglePlanMode(),
      sendAlternate: () => handle.current?.sendAlternate(),
      steerNext: () => handle.current?.steerNext() ?? false,
      editLatest: () => handle.current?.editLatest() ?? false,
    };
    handle.current?.focus();
    return () => {
      chat.composer.current = undefined;
    };
  }, [chat]);

  // Follow-ups typed while a turn runs wait in the thread's queue on its node
  // (D201) and go out one by one as turns end, whoever is watching.
  const agents = useAgents(target);
  // A steer goes into the running turn, so that turn's agent decides. Until
  // the agents are known the setting is trusted: an agent that cannot steer
  // gets the message queued (STEER_UNSUPPORTED, send.ts).
  const canSteer =
    running &&
    (agents === undefined ||
      agents.find((agent) => agent.agentId === lastTurn?.agentId)?.steering === true);
  // A first message the connection dropped: offered again until the thread shows it.
  const unconfirmed = useUnconfirmed(
    chat.unconfirmed,
    visitKey(target, threadId),
    timeline.turns.length > 0,
    (message) => sendMessage(chat.threads, target, threadId, message),
  );

  const send = async (
    text: string,
    attachments: readonly TurnAttachment[],
    alternate = false,
  ): Promise<boolean> => {
    setError(undefined);
    const message = { text, attachments, settings: selection };
    const mode = running ? dispatchMode(settings.followUpBehavior, alternate, canSteer) : "send";
    const outcome = await sendMessage(chat.threads, target, threadId, message, mode);
    if (outcome.kind === "failed") {
      setError(outcome.message);
      return false;
    }
    // Asked to steer, but it waits in the queue (the agent takes no steering,
    // or the turn ended first): say so rather than let it look steered.
    const askedToSteer =
      running && dispatchMode(settings.followUpBehavior, alternate, true) === "steer";
    if (outcome.kind === "queued" && askedToSteer) {
      chat.toasts?.show({
        type: "info",
        title: "Queued instead",
        description: "The turn ended first, or its agent takes no steering: it goes next.",
      });
    }
    return true;
  };

  /** What the queue banner and the composer do to the thread's queue on its node. */
  const call = async (method: string, input: Record<string, unknown>, title: string) => {
    try {
      await chat.threads.call(target, method, { threadId, ...input });
      return true;
    } catch (failure) {
      chat.toasts?.show({ type: "error", title, description: (failure as Error).message });
      return false;
    }
  };
  const queueActions: QueueActions = {
    remove: (messageId) => call("threads.queue.cancel", { messageId }, "Not removed"),
    resume: () => call("threads.queue.resume", {}, "Queue not resumed"),
    steer: (messageId) => call("threads.queue.steer", { messageId }, "Not steered"),
    reorder: (messageId, beforeMessageId) =>
      call("threads.queue.reorder", { messageId, beforeMessageId }, "Not moved"),
    edit: (messageId, text, attachments) =>
      call("threads.queue.edit", { messageId, text, attachments }, "Queued message not saved"),
    load: async (messageId) => {
      try {
        const queue = await chat.threads.call<{
          messages: { id: string; text: string; attachments?: TurnAttachment[] }[];
        }>(target, "threads.queue.list", { threadId });
        const message = queue.messages.find((item) => item.id === messageId);
        return message === undefined
          ? undefined
          : { text: message.text, attachments: message.attachments ?? [] };
      } catch (failure) {
        chat.toasts?.show({
          type: "error",
          title: "Queued message not loaded",
          description: (failure as Error).message,
        });
        return undefined;
      }
    },
  };

  const changeSelection = (next: Selection) => {
    setSelection(next);
    // The thread keeps it for its next turns, here and on other clients.
    if (thread !== undefined) {
      void chat.threads
        .call(target, "threads.update", { threadId, ...next })
        .catch((failure: unknown) =>
          chat.toasts?.show({
            type: "error",
            title: "Setting not saved",
            description: String((failure as Error).message ?? failure),
          }),
        );
    }
  };

  const respond = async (requestId: string, response: AgentResponse): Promise<boolean> => {
    try {
      await chat.threads.call(target, "threads.respond", { threadId, requestId, response });
      return true;
    } catch (failure) {
      chat.toasts?.show({
        type: "error",
        title: "Answer not delivered",
        description: (failure as Error).message,
      });
      return false;
    }
  };

  // A plan-mode turn proposed a plan: the composer offers to implement it (D306).
  const plan = useMemo(() => actionablePlan(timeline), [timeline]);
  const planFollowUp =
    plan !== undefined && selection.interactionMode === "plan" && !running
      ? {
          title: proposedPlanTitle(plan.markdown),
          onImplement: async (newThread: boolean) => {
            setError(undefined);
            try {
              const result = (await chat.context.commands.execute(
                newThread ? "chat.plan.implement-new-thread" : "chat.plan.implement",
                { ...target, threadId },
              )) as { uncertain?: string };
              if (result.uncertain !== undefined) {
                chat.toasts?.show({
                  type: "warning",
                  title: "The plan may not have reached the new thread",
                  description: result.uncertain,
                });
              }
              if (!newThread)
                setSelection((current) => ({ ...current, interactionMode: "default" }));
              return true;
            } catch (failure) {
              chat.toasts?.show({
                type: "error",
                title: newThread
                  ? "Could not start implementation thread"
                  : "Failed to send plan follow-up.",
                description: (failure as Error).message,
              });
              return false;
            }
          },
        }
      : undefined;
  const savePlan =
    props.project === undefined
      ? undefined
      : (path: string, contents: string) =>
          chat.threads.call<{ relativePath: string }>(target, "projects.write-file", {
            projectId: props.project!.id,
            path,
            contents,
          });

  // Attachments of sent messages, read back from the node once each.
  const loadAttachment = useCallback(
    (attachment: StoredAttachment) =>
      chat.attachmentUrls.load(`${targetKey(target)}|${attachment.id}`, () =>
        downloadAttachment(
          (method, params) => chat.threads.call(target, method, params),
          attachment.id,
        ),
      ),
    [chat, targetKey(target)],
  );

  const shownError = openError ?? error;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      <ChatHeader
        nodeLabel={props.nodeLabel}
        project={props.project}
        target={target}
        thread={thread}
        title={thread?.title ?? "Thread"}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {(unconfirmed.message === undefined || count === 0) && shownError === undefined ? null : (
            <div className="pointer-events-none absolute top-0 inset-x-0 z-20 flex flex-col gap-2 pt-3">
              {/* Shown once the thread's stream has answered: until then nothing is known. */}
              {unconfirmed.message === undefined || count === 0 ? null : (
                <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))]">
                  <Alert variant="warning">
                    <CircleAlertIcon />
                    <AlertDescription>
                      <div className="line-clamp-3">
                        Your message may not have reached the node: &ldquo;
                        {unconfirmed.message.text}&rdquo;
                      </div>
                    </AlertDescription>
                    <AlertAction>
                      <Button
                        onClick={() =>
                          void unconfirmed.resend().then((outcome) => {
                            if (outcome?.kind === "failed") setError(outcome.message);
                          })
                        }
                        size="xs"
                        variant="outline"
                      >
                        Send again
                      </Button>
                      <Button
                        aria-label="Dismiss"
                        onClick={unconfirmed.dismiss}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    </AlertAction>
                  </Alert>
                </div>
              )}
              {shownError === undefined ? null : (
                <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))]">
                  <Alert variant="error">
                    <CircleAlertIcon />
                    <AlertDescription>
                      <div className="line-clamp-3">{shownError}</div>
                    </AlertDescription>
                    <AlertAction>
                      <Button
                        aria-label="Dismiss error"
                        onClick={() => setError(undefined)}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    </AlertAction>
                  </Alert>
                </div>
              )}
            </div>
          )}
          <div
            aria-label="Messages"
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] sm:px-12"
            onScroll={onScroll}
            ref={scroller}
            role="log"
            // Scrollable by keyboard too.
            tabIndex={0}
          >
            <div className="h-6" />
            <div className="chat-content-lane overflow-x-clip">
              {timeline.deleted ? (
                <div className="py-24 text-center text-sm text-muted-foreground" role="status">
                  This thread was deleted.
                </div>
              ) : (
                <AttachmentLoaderContext.Provider value={loadAttachment}>
                  <TimelineView
                    footer={
                      thread === undefined
                        ? undefined
                        : (turn, latest) => (
                            <Slot
                              name="chat.turn.footer"
                              props={
                                {
                                  target,
                                  thread,
                                  turnId: turn.turnId,
                                  state: turn.state,
                                  latest,
                                } satisfies ChatTurnFooterProps
                              }
                            />
                          )
                    }
                    format={settings.timestampFormat}
                    onRetry={(turn) =>
                      chat.context.commands
                        .execute("thread.regenerate", { ...target, threadId, turnId: turn.turnId })
                        // The command shows its own toast.
                        .catch(() => undefined)
                    }
                    onOpenThread={(id) => chat.navigation.navigate({ ...target, thread: id })}
                    thread={{ target, threadId }}
                    timeline={timeline}
                    {...(savePlan === undefined || props.project === undefined
                      ? {}
                      : { onSavePlan: savePlan, projectPath: props.project.path })}
                    titleOf={(id) =>
                      catalog?.threads.find((candidate) => candidate.id === id)?.title
                    }
                  />
                </AttachmentLoaderContext.Provider>
              )}
            </div>
            <div aria-hidden style={{ height: composer.height }} />
            <div aria-hidden className="h-3 sm:h-4" />
          </div>
          {showPill ? (
            <div
              className="pointer-events-none absolute inset-x-0 z-30 flex justify-center py-1.5"
              style={{ bottom: composer.height + 4 }}
            >
              <Button
                aria-label="Scroll to end"
                className="pointer-events-auto"
                onClick={scrollToEnd}
                onPointerDown={(event) => event.preventDefault()}
                size="xs"
                variant="glass"
              >
                <ChevronDownIcon className="size-3.5" />
                Scroll to end
              </Button>
            </div>
          ) : null}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
            ref={composer.ref}
          >
            <div className="w-full px-[calc(env(safe-area-inset-left)+0.75rem)] sm:px-12">
              <div className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)">
                {timeline.deleted ? null : thread?.archivedAt !== undefined ? (
                  <ArchivedNotice
                    onUnarchive={() =>
                      void chat.context.commands
                        .execute("thread.unarchive", { ...target, threadId })
                        .catch((failure: unknown) => setError((failure as Error).message))
                    }
                  />
                ) : (
                  <Composer
                    context={{
                      target,
                      ...(thread === undefined ? {} : { thread }),
                      ...(props.project === undefined ? {} : { project: props.project }),
                    }}
                    draftKey={threadDraftKey(target, threadId)}
                    handleRef={handle}
                    history={history}
                    canSteer={canSteer}
                    onRespond={respond}
                    onSelectionChange={changeSelection}
                    onSend={send}
                    {...(planFollowUp === undefined ? {} : { planFollowUp })}
                    onStop={() =>
                      void chat.threads
                        .call(target, "threads.interrupt", { threadId })
                        .catch((failure: unknown) => setError((failure as Error).message))
                    }
                    queue={timeline.queue}
                    queueActions={queueActions}
                    requests={requests}
                    running={running}
                    selection={selection}
                    target={target}
                    unavailable={props.connected ? undefined : "The node is not connected"}
                    usage={lastTurn?.usage}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Under the chat, as T3 puts its terminal drawer. */}
      {thread === undefined || props.project === undefined || timeline.deleted ? null : (
        <Slot
          name="chat.drawer"
          props={{ target, thread, project: props.project } satisfies ChatDrawerProps}
        />
      )}
    </div>
  );
}

/** An archived thread takes no messages: in place of the composer, the way back. */
function ArchivedNotice(props: { onUnarchive: () => void }) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-[20px] border border-border bg-card px-4 py-3 text-sm shadow-xs"
      role="status"
    >
      <span className="text-muted-foreground">This thread is archived.</span>
      <Button onClick={props.onUnarchive} size="sm" variant="outline">
        <ArchiveRestoreIcon />
        Unarchive
      </Button>
    </div>
  );
}

/** A thread that does not exist yet: the composer in the middle, under a question (T3 Code's draft hero). */
export function DraftView(props: {
  target: NodeTarget;
  project: ProjectRecord;
  nodeLabel: string;
  connected: boolean;
}) {
  const { target, project } = props;
  const chat = useChat();
  const [selection, setSelection] = useState<Selection>(() => chat.lastSelection.get(target));
  const handle = useRef<ComposerHandleApi>(null);
  const lastSelection = useSyncExternalStore(chat.lastSelection.subscribe, () =>
    chat.lastSelection.get(target),
  );
  useEffect(() => setSelection(lastSelection), [lastSelection]);
  useEffect(() => {
    chat.composer.current = {
      draftKey: newThreadDraftKey(target, project.id),
      restore: (draft) => handle.current?.restore(draft),
      draft: () => handle.current?.draft(),
      focus: () => handle.current?.focus(),
      toggleModelPicker: () => handle.current?.toggleModelPicker(),
      cycleRuntimeMode: () => handle.current?.cycleRuntimeMode(),
      togglePlanMode: () => handle.current?.togglePlanMode(),
      sendAlternate: () => handle.current?.sendAlternate(),
      steerNext: () => handle.current?.steerNext() ?? false,
      editLatest: () => handle.current?.editLatest() ?? false,
    };
    handle.current?.focus();
    return () => {
      chat.composer.current = undefined;
    };
  }, [chat, project.id]);

  // The new thread's id, kept until the thread is made: sending again after a
  // failure asks for the same thread, so it makes no second one (D207).
  const nextThreadId = useRef<string>(crypto.randomUUID());
  const send = async (text: string, attachments: readonly TurnAttachment[]): Promise<boolean> => {
    try {
      const { threadId, uncertain } = await startThread(
        chat.threads,
        target,
        { projectId: project.id, text, attachments, selection },
        nextThreadId.current,
      );
      nextThreadId.current = crypto.randomUUID();
      if (uncertain !== undefined) {
        // The node may have taken it: the thread stays, and offers to send it
        // again until it shows the message.
        chat.unconfirmed.set(visitKey(target, threadId), {
          text,
          attachments,
          settings: selection,
        });
        chat.toasts?.show({
          type: "warning",
          title: "Message not confirmed",
          description: `${uncertain.message}. The thread shows whether it arrived.`,
        });
      }
      // To the new thread, unless the user went elsewhere meanwhile.
      const route = chat.navigation.current();
      if (
        route.node === target.node &&
        route.remote === target.remote &&
        route.project === project.id &&
        route.thread === undefined &&
        route.panel === undefined
      ) {
        chat.navigation.navigate({
          node: target.node,
          ...(target.remote === undefined ? {} : { remote: target.remote }),
          thread: threadId,
        });
      }
      return true;
    } catch (failure) {
      // A thread deleted after its first message was refused takes its id along.
      if (!threadMayExist(failure)) nextThreadId.current = crypto.randomUUID();
      chat.toasts?.show({
        type: "error",
        title: "Could not start the thread",
        description: (failure as Error).message,
      });
      return false;
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      <ChatHeader
        nodeLabel={props.nodeLabel}
        project={project}
        target={target}
        thread={undefined}
        title="New thread"
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center">
          <div className="w-full px-[calc(env(safe-area-inset-left)+0.75rem)] sm:px-12">
            <div className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)">
              <div className="absolute inset-x-0 bottom-full">
                <div className="pb-4">
                  <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
                    <h1 className="w-full text-center font-normal text-2xl tracking-tight text-foreground sm:text-3xl">
                      {project.scratch
                        ? "What should we work on?"
                        : `What should we build in ${project.name}?`}
                    </h1>
                    <p className="mt-2 flex h-6 items-center text-sm text-muted-foreground">
                      {props.nodeLabel}
                    </p>
                  </div>
                </div>
              </div>
              <Composer
                context={{ target, project }}
                draftKey={newThreadDraftKey(target, project.id)}
                handleRef={handle}
                history={[]}
                onRespond={async () => false}
                seedModelOptions
                onSelectionChange={(next) => {
                  setSelection(next);
                  chat.lastSelection.set(target, next);
                }}
                onSend={send}
                onStop={() => undefined}
                requests={[]}
                running={false}
                selection={selection}
                target={target}
                unavailable={props.connected ? undefined : "The node is not connected"}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
