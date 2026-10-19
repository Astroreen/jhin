// The queue follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/QueuedRunsControl.tsx
// (queued follow-ups), kept in this page instead of on the server.
import type { TurnAttachment } from "@jhin/agent-api";
import { useEffect, useSyncExternalStore } from "react";

/** A message sent while a turn ran: it goes out when the thread is free. */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly TurnAttachment[];
}

/** What sending a message came to. */
export type SendOutcome =
  | { readonly kind: "sent" }
  /** The thread runs a turn (started here or elsewhere): it goes when that one ends. */
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly message: string };

interface QueueState {
  readonly queue: readonly QueuedMessage[];
  /** Why the first message was not sent; the queue waits for the user. */
  readonly paused?: string;
  readonly sending: boolean;
  /** The ending a send (or a busy answer) happened after: the next one must be another. */
  readonly after?: string;
}

const EMPTY: QueueState = { queue: [], sending: false };

/**
 * The follow-up queues of the threads of this page, by thread: a queue outlives
 * its view, so one typed before opening another thread is still sent.
 */
export function createFollowUpQueues() {
  let states: ReadonlyMap<string, QueueState> = new Map();
  const listeners = new Set<() => void>();
  return {
    get: (key: string): QueueState => states.get(key) ?? EMPTY,
    update(key: string, change: (state: QueueState) => QueueState) {
      const value = change(states.get(key) ?? EMPTY);
      const next = new Map(states);
      // Nothing left to send: nothing to keep.
      if (value.queue.length === 0 && !value.sending) next.delete(key);
      else next.set(key, value);
      states = next;
      for (const listener of Array.from(listeners)) listener();
    },
    watch(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type FollowUpQueues = ReturnType<typeof createFollowUpQueues>;

/**
 * A thread's follow-up queue. Its first message goes out once each time the
 * thread is free: no turn runs, nothing is asked, and the thread's record says
 * its latest turn ended (`settled`, a key of that turn and its status;
 * undefined while one runs). After a send, or when the thread turned out busy,
 * it waits until the record shows another ending; after a failure it waits for
 * `resume`. So a failing or busy thread never gets a loop of sends.
 */
export function useFollowUps(options: {
  readonly queues: FollowUpQueues;
  /** The thread: its node target and id. */
  readonly key: string;
  /** The timeline shows no running turn and no open request. */
  readonly quiet: boolean;
  readonly settled: string | undefined;
  post(message: QueuedMessage): Promise<SendOutcome>;
}) {
  const { queues, key, quiet, settled, post } = options;
  const state = useSyncExternalStore(queues.watch, () => queues.get(key));
  const head = state.queue[0];
  const ready =
    quiet &&
    settled !== undefined &&
    settled !== state.after &&
    !state.sending &&
    state.paused === undefined;
  useEffect(() => {
    if (!ready || head === undefined) return;
    queues.update(key, (current) => ({ ...current, sending: true, after: settled }));
    void post(head).then((outcome) =>
      queues.update(key, (current) => {
        if (outcome.kind === "sent") {
          return {
            ...current,
            sending: false,
            queue: current.queue.filter((item) => item.id !== head.id),
          };
        }
        if (outcome.kind === "failed") {
          // No turn started: once resumed, it goes without waiting for an ending.
          const { after: _after, ...rest } = current;
          return { ...rest, sending: false, paused: outcome.message };
        }
        return { ...current, sending: false };
      }),
    );
  }, [ready, head, key]);

  return {
    queue: state.queue,
    paused: state.paused,
    add(message: QueuedMessage) {
      queues.update(key, (current) => ({ ...current, queue: [...current.queue, message] }));
    },
    remove(id: string) {
      queues.update(key, (current) => {
        const queue = current.queue.filter((item) => item.id !== id);
        // Removing the message that failed lets the rest go.
        if (current.queue[0]?.id !== id) return { ...current, queue };
        const { paused: _paused, ...rest } = current;
        return { ...rest, queue };
      });
    },
    /** Tries the first message again. */
    resume() {
      queues.update(key, ({ paused: _paused, after: _after, ...rest }) => rest);
    },
  };
}
