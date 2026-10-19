import type { Connections, NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { createTimeline, type Timeline } from "../../lib/timeline.ts";

export interface ThreadTimelineState {
  readonly timeline: Timeline;
  /** How many events were folded in: changes whenever the timeline grows. */
  readonly count: number;
  readonly error?: string;
}

const NO_TIMELINE: ThreadTimelineState = { timeline: { turns: [], deleted: false }, count: 0 };

/**
 * A thread's timeline, kept current from the thread's stream (or this node's
 * copy of a remote one, D26), on the node's connection as it is now: when the
 * node gets another client (a new token, a change in another tab) the stream
 * is read again on that one. The client itself waits for the node and resumes
 * after a reconnect. Events are folded in as they arrive, one batch per
 * frame, never the whole thread again.
 */
export function useThreadTimeline(
  threads: Pick<ThreadsCatalog, "open">,
  connections: Connections,
  target: NodeTarget,
  threadId: string,
): ThreadTimelineState {
  const client = useExternal(connections, connections.list).find(
    (node) => node.id === target.node,
  )?.client;
  const [state, setState] = useState<ThreadTimelineState>(NO_TIMELINE);
  useEffect(() => {
    setState(NO_TIMELINE);
    if (client === undefined) return;
    let disposed = false;
    let subscription: { dispose(): void } | undefined;
    const fold = createTimeline();
    let count = 0;
    // Events arrive one by one; they are batched into one update per frame.
    let pending: StoredEvent[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const batch = pending;
      pending = [];
      count += batch.length;
      const timeline = fold.apply(batch);
      setState((previous) => ({ ...previous, timeline, count }));
    };
    void threads
      .open(target, threadId)
      .then((stream) => {
        if (disposed) return;
        subscription = client.subscribe(
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
        if (!disposed) {
          setState({
            ...NO_TIMELINE,
            error: `Cannot open this thread: ${(failure as Error).message}`,
          });
        }
      });
    return () => {
      disposed = true;
      subscription?.dispose();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [threads, client, target.node, target.remote, threadId]);
  return state;
}
