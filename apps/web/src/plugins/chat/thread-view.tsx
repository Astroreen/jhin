// The layout and scroll behaviour follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/ChatView.tsx and chat/MessagesTimeline.tsx.
import type { AgentResponse, TurnAttachment } from "@jhin/agent-api";
import {
  targetKey,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
} from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";
import { Alert, AlertAction, AlertDescription, Button } from "@jhin/ui";
import { ChevronDownIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { buildPromptHistory } from "../../lib/composer.ts";
import { CHAT_SECTION, ChatSettings, useSection } from "../../lib/settings.ts";
import { visitKey } from "../../lib/thread-actions.ts";
import { visits } from "../../lib/thread-status.ts";
import { openRequests, reduceTimeline } from "../../lib/timeline.ts";
import {
  Composer,
  type ComposerHandleApi,
  type QueuedMessage,
  type Selection,
} from "./composer.tsx";
import { ChatHeader } from "./header.tsx";
import { useChat } from "./services.ts";
import { TimelineView } from "./timeline.tsx";

/** A thread's events, kept current: the thread's stream, or this node's copy of a remote one (D26). */
function useThreadEvents(target: NodeTarget, threadId: string) {
  const { threads, connections } = useChat();
  const [state, setState] = useState<{ events: readonly StoredEvent[]; error?: string }>({
    events: [],
  });
  useEffect(() => {
    setState({ events: [] });
    let disposed = false;
    let subscription: { dispose(): void } | undefined;
    const node = connections.get(target.node);
    if (node === undefined) return;
    // Events arrive one by one; they are batched into one update per frame.
    let pending: StoredEvent[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const batch = pending;
      pending = [];
      setState((previous) => ({ ...previous, events: [...previous.events, ...batch] }));
    };
    void threads
      .open(target, threadId)
      .then((stream) => {
        if (disposed) return;
        subscription = node.client.subscribe(
          stream,
          {
            onError: (error) =>
              !disposed && setState((previous) => ({ ...previous, error: error.message })),
          },
          (event) => {
            pending.push(event);
            frame ??= requestAnimationFrame(flush);
          },
        );
      })
      .catch((failure: unknown) => {
        if (!disposed)
          setState({ events: [], error: `Cannot open this thread: ${(failure as Error).message}` });
      });
    return () => {
      disposed = true;
      subscription?.dispose();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [threads, connections, target.node, target.remote, threadId]);
  return state;
}

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
  const { events, error: openError } = useThreadEvents(target, threadId);
  const timeline = useMemo(() => reduceTimeline(events), [events]);
  const lastTurn = timeline.turns.at(-1);
  const running = lastTurn?.state === "running";
  const requests = useMemo(() => openRequests(timeline), [timeline]);
  const history = useMemo(
    () => buildPromptHistory(timeline.turns.map((turn) => ({ id: turn.turnId, text: turn.text }))),
    [timeline],
  );
  const [error, setError] = useState<string | undefined>();
  const [queue, setQueue] = useState<readonly QueuedMessage[]>([]);
  const [selection, setSelection] = useState<Selection>(() =>
    thread === undefined ? {} : selectionOf(thread),
  );
  const composer = useHeight<HTMLDivElement>();
  const { scroller, onScroll, showPill, scrollToEnd } = useStickToEnd(events.length);
  const handle = useRef<ComposerHandleApi>(null);

  // The thread's settings follow its record when they change elsewhere.
  const recordSelection = thread === undefined ? undefined : JSON.stringify(selectionOf(thread));
  useEffect(() => {
    if (thread !== undefined) setSelection(selectionOf(thread));
  }, [recordSelection]);

  // Seen while open: a turn that ends here is not "unread". Visits are the
  // node's own times (the thread's last change), so clocks never disagree.
  const visitStore = visits();
  const seenAt = thread?.lastTurn?.at ?? thread?.updatedAt ?? thread?.createdAt;
  useEffect(() => {
    if (seenAt !== undefined) visitStore.visit(visitKey(target, threadId), seenAt);
  }, [seenAt, targetKey(target), threadId]);

  // Commands reach this composer.
  useEffect(() => {
    chat.composer.current = {
      focus: () => handle.current?.focus(),
      toggleModelPicker: () => handle.current?.toggleModelPicker(),
      cycleRuntimeMode: () => handle.current?.cycleRuntimeMode(),
      togglePlanMode: () => handle.current?.togglePlanMode(),
    };
    return () => {
      chat.composer.current = undefined;
    };
  }, [chat]);

  const send = async (text: string, attachments: readonly TurnAttachment[]): Promise<boolean> => {
    setError(undefined);
    try {
      await chat.threads.call(target, "threads.send", {
        threadId,
        text,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...selection,
      });
      return true;
    } catch (failure) {
      const code = (failure as { code?: unknown }).code;
      if (code === "TURN_IN_PROGRESS") {
        setQueue((current) => [...current, { id: crypto.randomUUID(), text, attachments }]);
        return true;
      }
      setError((failure as Error).message);
      return false;
    }
  };

  // Queued messages go out one by one as turns end (T3 Code's follow-up queue, kept in this page).
  useEffect(() => {
    if (running || queue.length === 0 || requests.length > 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void send(next!.text, next!.attachments).then((sent) => {
      if (!sent) setQueue((current) => [next!, ...current]);
    });
  }, [running, queue.length]);

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

  const respond = async (requestId: string, response: AgentResponse) => {
    try {
      await chat.threads.call(target, "threads.respond", { threadId, requestId, response });
    } catch (failure) {
      chat.toasts?.show({
        type: "error",
        title: "Answer not delivered",
        description: (failure as Error).message,
      });
    }
  };

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
          {shownError === undefined ? null : (
            <div className="pointer-events-none absolute top-0 inset-x-0 z-20 flex flex-col">
              <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
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
            </div>
          )}
          <div
            aria-label="Messages"
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] sm:px-12"
            onScroll={onScroll}
            ref={scroller}
            role="log"
          >
            <div className="h-6" />
            <div className="chat-content-lane overflow-x-clip">
              {timeline.deleted ? (
                <div className="py-24 text-center text-sm text-muted-foreground" role="status">
                  This thread was deleted.
                </div>
              ) : (
                <TimelineView
                  format={settings.timestampFormat}
                  onRetry={(text) => void send(text, [])}
                  timeline={timeline}
                />
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
                {timeline.deleted ? null : (
                  <Composer
                    draftKey={`${targetKey(target)}|thread|${threadId}`}
                    handleRef={handle}
                    history={history}
                    onDequeue={(id) =>
                      setQueue((current) => current.filter((item) => item.id !== id))
                    }
                    onRespond={respond}
                    onSelectionChange={changeSelection}
                    onSend={send}
                    onStop={() =>
                      void chat.threads
                        .call(target, "threads.interrupt", { threadId })
                        .catch((failure: unknown) => setError((failure as Error).message))
                    }
                    queue={queue}
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
      focus: () => handle.current?.focus(),
      toggleModelPicker: () => handle.current?.toggleModelPicker(),
      cycleRuntimeMode: () => handle.current?.cycleRuntimeMode(),
      togglePlanMode: () => handle.current?.togglePlanMode(),
    };
    handle.current?.focus();
    return () => {
      chat.composer.current = undefined;
    };
  }, [chat, project.id]);

  const send = async (text: string, attachments: readonly TurnAttachment[]): Promise<boolean> => {
    try {
      const thread = await chat.threads.call<ThreadRecord>(target, "threads.create", {
        projectId: project.id,
        ...selection,
      });
      chat.drafts.set(`${targetKey(target)}|thread|${thread.id}`, { prompt: "", attachments: [] });
      await chat.threads.call(target, "threads.send", {
        threadId: thread.id,
        text,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...selection,
      });
      chat.navigation.navigate({
        node: target.node,
        ...(target.remote === undefined ? {} : { remote: target.remote }),
        thread: thread.id,
      });
      return true;
    } catch (failure) {
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
                draftKey={`${targetKey(target)}|draft|${project.id}`}
                handleRef={handle}
                history={[]}
                onDequeue={() => undefined}
                onRespond={async () => undefined}
                onSelectionChange={(next) => {
                  setSelection(next);
                  chat.lastSelection.set(target, next);
                }}
                onSend={send}
                onStop={() => undefined}
                queue={[]}
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
