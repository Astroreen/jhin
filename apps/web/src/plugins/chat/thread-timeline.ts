import type { Connections, HistoryCache, NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { createTimeline, type Timeline } from "../../lib/timeline.ts";
import { followCachedStream, type StreamInfo } from "./cached-stream.ts";

export interface ThreadTimelineState {
  readonly timeline: Timeline;
  /**
   * How many events arrived, also ones delivered again: a marker that changes
   * whenever the timeline may have grown, not a count of its events. It
   * starts over with the timeline when a kept history is dropped.
   */
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
 * frame, never the whole thread again. A thread of the connected node opens
 * from what the history cache keeps of it, then asks only for what is new
 * (loading.md D1589).
 */
export function useThreadTimeline(
  threads: Pick<ThreadsCatalog, "open" | "call">,
  connections: Connections,
  target: NodeTarget,
  threadId: string,
  cache?: HistoryCache,
): ThreadTimelineState {
  const client = useExternal(connections, connections.list).find(
    (node) => node.id === target.node,
  )?.client;
  const [state, setState] = useState<ThreadTimelineState>(NO_TIMELINE);
  useEffect(() => {
    if (client === undefined) {
      setState({ ...NO_TIMELINE, error: "Not connected to this thread's node" });
      return;
    }
    setState(NO_TIMELINE);
    let disposed = false;
    let following: { dispose(): void } | undefined;
    let fold = createTimeline();
    let count = 0;
    const onBatch = (batch: readonly StoredEvent[], reset: boolean) => {
      if (reset) {
        fold = createTimeline();
        count = 0;
      }
      count += batch.length;
      // Events again: whatever went wrong with the stream is over.
      setState({ timeline: fold.apply(batch), count });
    };
    void threads
      .open(target, threadId)
      .then((stream) => {
        if (disposed) return;
        following = followCachedStream({
          client,
          // A remote's thread is this node's copy of it: it opens from 0 (D1606).
          cache: target.remote === undefined ? cache : undefined,
          connection: target.node,
          stream,
          info: () => threads.call<StreamInfo>(target, "threads.get", { threadId }),
          schedule: (flush) => {
            const frame = requestAnimationFrame(flush);
            return () => cancelAnimationFrame(frame);
          },
          onBatch,
          onError: (error) =>
            !disposed && setState((previous) => ({ ...previous, error: error.message })),
        });
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
      following?.dispose();
    };
  }, [threads, client, cache, target.node, target.remote, threadId]);
  return state;
}
