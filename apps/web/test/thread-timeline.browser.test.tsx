import { ThreadEvents } from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import {
  useThreadTimeline,
  type ThreadTimelineState,
} from "../src/plugins/chat/thread-timeline.ts";

const target = { node: "ws://a/rpc" };

/** An RPC client that hands the test what it subscribes to. */
function fakeClient() {
  const subscribers: ((event: StoredEvent) => void)[] = [];
  let disposed = 0;
  const client = {
    subscribe(_stream: string, _options: unknown, onEvent: (event: StoredEvent) => void) {
      subscribers.push(onEvent);
      return { lastSequence: 0, dispose: () => (disposed += 1) };
    },
  } as unknown as NodeConnection["client"];
  return {
    client,
    /** The node appends a turn to the thread's stream. */
    turn(sequence: number, turnId: string, text: string) {
      subscribers.at(-1)!({
        stream: "thread/t1",
        sequence,
        type: ThreadEvents.turnStarted,
        payload: { turnId, agentId: "jhin.agent-fake", input: { text } },
        at: "2026-10-19T00:00:00.000Z",
      });
    },
    get subscriptions() {
      return subscribers.length;
    },
    get disposed() {
      return disposed;
    },
  };
}

/** The saved connections, with one node whose client the test replaces. */
function fakeConnections(client: NodeConnection["client"]) {
  let list: readonly NodeConnection[] = [
    { id: target.node, url: target.node, label: "a", state: "open", client },
  ];
  const listeners = new Set<() => void>();
  return {
    connections: {
      list: () => list,
      get: (id: string) => list.find((node) => node.id === id),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    } as unknown as Connections,
    /** Another tab saved a new token: the node gets another client. */
    replace(next: NodeConnection["client"]) {
      list = list.map((node) => ({ ...node, client: next }));
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** Lets the frame that folds the events in pass, and React render it. */
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe("a thread's timeline", () => {
  it("is read again on the node's new client when the old one is replaced", async () => {
    const first = fakeClient();
    const second = fakeClient();
    const nodes = fakeConnections(first.client);
    const threads = { open: async (_target: unknown, threadId: string) => `thread/${threadId}` };
    const seen: { state?: ThreadTimelineState } = {};
    function View() {
      seen.state = useThreadTimeline(threads, nodes.connections, target, "t1");
      return null;
    }
    const texts = () => seen.state?.timeline.turns.map((turn) => turn.text);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<View />));
    expect(first.subscriptions).toBe(1);
    first.turn(1, "u1", "hello");
    await nextFrame();
    expect(texts()).toEqual(["hello"]);

    await act(async () => nodes.replace(second.client));
    expect(first.disposed).toBe(1);
    expect(second.subscriptions).toBe(1);
    // The new client reads the stream from its start: nothing is folded twice.
    second.turn(1, "u1", "hello");
    second.turn(2, "u2", "again");
    await nextFrame();
    expect(texts()).toEqual(["hello", "again"]);
    act(() => root.unmount());
  });
});
