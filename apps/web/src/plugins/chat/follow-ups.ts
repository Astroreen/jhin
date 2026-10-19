// The queue follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/QueuedRunsControl.tsx
// (queued follow-ups) and apps/server/src/orchestration-v2/Orchestrator.ts (a queue held after a stop
// or a failure), kept in this page instead of on the server.
import type { TurnAttachment } from "@jhin/agent-api";
import {
  targetKey,
  visitKey,
  type NodeTarget,
  type ThreadsCatalog,
  type TurnStatus,
} from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";
import { useSyncExternalStore } from "react";

import { ENDED_STATUSES } from "../../lib/thread-status.ts";

/** The agent, model and modes a message is sent with. */
interface MessageSettings {
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
}

/** A message sent while a turn ran: it goes out when the thread is free. */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly TurnAttachment[];
  /** What it was typed with: it goes with these, whatever the composer shows later. */
  readonly settings: MessageSettings;
}

/** What sending a message came to. */
export type SendOutcome =
  | { readonly kind: "sent" }
  /** The thread runs a turn (started here or elsewhere): it goes when that one ends. */
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly message: string };

/** Sends a message to a thread; a thread running a turn answers `busy`. */
export async function sendMessage(
  threads: Pick<ThreadsCatalog, "call">,
  target: NodeTarget,
  threadId: string,
  message: Omit<QueuedMessage, "id">,
): Promise<SendOutcome> {
  try {
    await threads.call(target, "threads.send", {
      threadId,
      text: message.text,
      ...(message.attachments.length === 0 ? {} : { attachments: message.attachments }),
      ...message.settings,
    });
    return { kind: "sent" };
  } catch (failure) {
    if ((failure as { code?: unknown }).code === "TURN_IN_PROGRESS") return { kind: "busy" };
    return { kind: "failed", message: (failure as Error).message };
  }
}

/** Why a queue waits for the user. */
export interface QueuePause {
  /** "failed": its first message was refused; "held": the turn before it was stopped or failed. */
  readonly kind: "failed" | "held";
  readonly message: string;
}

/** A thread's queue as its view shows it. */
export interface FollowUpQueue {
  readonly queue: readonly QueuedMessage[];
  readonly paused?: QueuePause;
  /** The first message is on its way: it can no longer be taken back. */
  readonly sending: boolean;
}

interface QueueState extends FollowUpQueue {
  readonly target: NodeTarget;
  readonly threadId: string;
  /** The ending a send (or a busy answer) happened after: the next one must be another. */
  readonly after?: string;
  /** The ending the record showed when the queue began: it came before the messages. */
  readonly since?: string;
  /** A stopped or failed ending the user resumed the queue past. */
  readonly released?: string;
}

const EMPTY: FollowUpQueue = { queue: [], sending: false };

/**
 * Where a thread's latest turn is, by its record: the ending it reached (with
 * a key, "none" before its first turn), "running" while a turn runs or waits
 * for an answer or the record is not known yet, and "gone" once the node's
 * catalog has no such thread.
 */
function endingOf(
  threads: Pick<ThreadsCatalog, "catalog">,
  target: NodeTarget,
  threadId: string,
): { readonly key: string; readonly status?: TurnStatus } | "running" | "gone" {
  const catalog = threads.catalog(target);
  const thread = catalog.threads.find((item) => item.id === threadId);
  if (thread === undefined) return catalog.status === "ready" ? "gone" : "running";
  const latest = thread.lastTurn;
  if (latest === undefined) return { key: "none" };
  return ENDED_STATUSES.has(latest.status)
    ? { key: `${latest.turnId}:${latest.status}`, status: latest.status }
    : "running";
}

/** The key of the ending a thread's record shows, if any. */
const endingKey = (ending: ReturnType<typeof endingOf>) =>
  typeof ending === "string" ? undefined : ending.key;

/**
 * The follow-up queues of the threads of this page. A queue goes on whether
 * its thread is on screen or not: it follows the thread's record in its node's
 * catalog, and sends its first message once each time the record says the
 * latest turn ended. After a send, or when the thread turned out busy, it
 * waits until the record shows another ending. A message refused, or a turn
 * that was stopped or failed after the queue began, holds it until `resume`,
 * as in T3 Code. So a failing or busy thread never gets a loop of sends. The
 * queue of a thread gone from its node is dropped.
 */
export function createFollowUpQueues(options: {
  readonly threads: Pick<ThreadsCatalog, "catalog" | "subscribe">;
  post(target: NodeTarget, threadId: string, message: QueuedMessage): Promise<SendOutcome>;
}) {
  const { threads } = options;
  let states: ReadonlyMap<string, QueueState> = new Map();
  const listeners = new Set<() => void>();
  /** The catalogs followed: those of the targets with queued messages. */
  const followed = new Map<string, Disposable>();
  let disposed = false;

  function set(key: string, value: QueueState) {
    const next = new Map(states);
    // Nothing left to send: nothing to keep.
    if (value.queue.length === 0 && !value.sending) next.delete(key);
    else next.set(key, value);
    states = next;
    follow();
    for (const listener of Array.from(listeners)) listener();
  }

  /** Follows the catalogs of the targets that have queued messages, and only those. */
  function follow() {
    const wanted = new Map<string, NodeTarget>();
    for (const state of states.values()) wanted.set(targetKey(state.target), state.target);
    for (const [key, subscription] of followed) {
      if (wanted.has(key)) continue;
      subscription.dispose();
      followed.delete(key);
    }
    for (const [key, target] of wanted) {
      if (disposed || followed.has(key)) continue;
      const subscription = threads.subscribe(target, () => {
        for (const [queue, state] of states) if (targetKey(state.target) === key) pump(queue);
      });
      followed.set(key, subscription);
    }
  }

  /** Sends the first message of a queue when its thread is free and it may go. */
  function pump(key: string) {
    const state = states.get(key);
    if (disposed || state === undefined || state.sending || state.paused !== undefined) return;
    const head = state.queue[0];
    const ending = endingOf(threads, state.target, state.threadId);
    if (ending === "gone") {
      // Nothing can be sent to it any more.
      set(key, { ...state, queue: [] });
      return;
    }
    if (head === undefined || ending === "running" || ending.key === state.after) return;
    if (
      (ending.status === "interrupted" || ending.status === "failed") &&
      ending.key !== state.since &&
      ending.key !== state.released
    ) {
      set(key, {
        ...state,
        paused: {
          kind: "held",
          message: ending.status === "interrupted" ? "The turn was stopped" : "The turn failed",
        },
      });
      return;
    }
    set(key, { ...state, sending: true, after: ending.key });
    void options.post(state.target, state.threadId, head).then((outcome) => {
      const current = states.get(key);
      if (current === undefined) return;
      const queue = current.queue.filter((item) => item.id !== head.id);
      if (outcome.kind === "sent") {
        set(key, { ...current, sending: false, queue });
      } else if (outcome.kind === "failed") {
        // No turn started: the next try goes without waiting for an ending. It
        // waits for the user, unless the message that failed was removed meanwhile.
        const { after: _after, ...rest } = current;
        const first = current.queue[0]?.id === head.id;
        set(key, {
          ...rest,
          sending: false,
          ...(first ? { paused: { kind: "failed" as const, message: outcome.message } } : {}),
        });
      } else {
        set(key, { ...current, sending: false });
      }
      // The record may have moved on while the message was on its way.
      pump(key);
    });
  }

  return {
    get: (key: string): FollowUpQueue => states.get(key) ?? EMPTY,
    add(target: NodeTarget, threadId: string, message: QueuedMessage) {
      const key = visitKey(target, threadId);
      const since = endingKey(endingOf(threads, target, threadId));
      const current = states.get(key) ?? {
        target,
        threadId,
        queue: [],
        sending: false,
        ...(since === undefined ? {} : { since }),
      };
      set(key, { ...current, queue: [...current.queue, message] });
      pump(key);
    },
    remove(key: string, id: string) {
      const current = states.get(key);
      if (current === undefined) return;
      const queue = current.queue.filter((item) => item.id !== id);
      // Removing the message that failed lets the rest go.
      if (current.queue[0]?.id !== id) set(key, { ...current, queue });
      else {
        const { paused: _paused, ...rest } = current;
        set(key, { ...rest, queue });
      }
      pump(key);
    },
    /** Sends the first message again, or past the turn that was stopped or failed. */
    resume(key: string) {
      const current = states.get(key);
      if (current === undefined) return;
      const { paused: _paused, after: _after, released: _released, ...rest } = current;
      const released = endingKey(endingOf(threads, current.target, current.threadId));
      set(key, { ...rest, ...(released === undefined ? {} : { released }) });
      pump(key);
    },
    watch(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      for (const subscription of followed.values()) subscription.dispose();
      followed.clear();
    },
  };
}

export type FollowUpQueues = ReturnType<typeof createFollowUpQueues>;

/** A thread's follow-up queue, for its view: what waits, and what can be done to it. */
export function useFollowUps(queues: FollowUpQueues, target: NodeTarget, threadId: string) {
  const key = visitKey(target, threadId);
  const state = useSyncExternalStore(queues.watch, () => queues.get(key));
  return {
    queue: state.queue,
    paused: state.paused,
    sending: state.sending,
    add: (message: QueuedMessage) => queues.add(target, threadId, message),
    remove: (id: string) => queues.remove(key, id),
    resume: () => queues.resume(key),
  };
}
