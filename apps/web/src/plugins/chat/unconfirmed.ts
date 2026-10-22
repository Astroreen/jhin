import { useEffect, useSyncExternalStore } from "react";

import type { OutgoingMessage, SendOutcome } from "./send.ts";

/** A message that may not have reached its thread: the connection dropped the call. */
export type UnconfirmedMessage = OutgoingMessage;

/**
 * Messages that may not have reached their thread, by thread: the thread's
 * view offers to send one again until the thread shows a turn.
 */
export function createUnconfirmed() {
  let entries: ReadonlyMap<string, UnconfirmedMessage> = new Map();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    get: (key: string) => entries.get(key),
    set(key: string, message: UnconfirmedMessage) {
      entries = new Map(entries).set(key, message);
      changed();
    },
    delete(key: string) {
      if (!entries.has(key)) return;
      const next = new Map(entries);
      next.delete(key);
      entries = next;
      changed();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type Unconfirmed = ReturnType<typeof createUnconfirmed>;

/**
 * A thread's unconfirmed message, for its view. It is forgotten once the
 * thread shows a turn (so it arrived), once it is sent again, or when the
 * user dismisses it: it never sits in the composer, ready to go out twice.
 */
export function useUnconfirmed(
  store: Unconfirmed,
  key: string,
  /** The thread shows a turn. */
  arrived: boolean,
  send: (message: UnconfirmedMessage) => Promise<SendOutcome>,
) {
  const message = useSyncExternalStore(store.subscribe, () => store.get(key));
  useEffect(() => {
    if (message !== undefined && arrived) store.delete(key);
  }, [message, arrived, key]);
  return {
    message: arrived ? undefined : message,
    async resend(): Promise<SendOutcome | undefined> {
      if (message === undefined) return undefined;
      const outcome = await send(message);
      // Sent, or a turn runs: either way the thread has a message now.
      if (outcome.kind !== "failed") store.delete(key);
      return outcome;
    },
    dismiss: () => store.delete(key),
  };
}
