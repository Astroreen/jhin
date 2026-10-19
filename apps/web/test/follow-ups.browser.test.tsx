import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import {
  createFollowUpQueues,
  useFollowUps,
  type FollowUpQueues,
  type QueuedMessage,
  type SendOutcome,
} from "../src/plugins/chat/follow-ups.ts";

const message = (text: string): QueuedMessage => ({ id: text, text, attachments: [] });

/** A thread view's use of the queue: its state is set by the test, each send answered by `answer`. */
function mountQueue(
  first: { quiet: boolean; settled: string | undefined },
  queues: FollowUpQueues = createFollowUpQueues(),
) {
  const posts: string[] = [];
  const state: {
    answer: () => SendOutcome;
    api?: ReturnType<typeof useFollowUps>;
    set?: (next: { quiet: boolean; settled: string | undefined }) => void;
  } = { answer: () => ({ kind: "sent" }) };
  function Thread() {
    const [thread, setThread] = useState(first);
    state.set = setThread;
    state.api = useFollowUps({
      queues,
      key: "node|t1",
      ...thread,
      post: async (queued) => {
        posts.push(queued.text);
        // A loop of sends stops here: the test then fails on what was sent instead of hanging.
        if (posts.length > 10) return new Promise<SendOutcome>(() => undefined);
        return state.answer();
      },
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Thread />));
  return {
    posts,
    get api() {
      return state.api!;
    },
    answer(outcome: SendOutcome) {
      state.answer = () => outcome;
    },
    /** Applies a change and lets the sends it starts settle. */
    run: (change: () => void) =>
      act(async () => {
        change();
      }),
    thread: (next: { quiet: boolean; settled: string | undefined }) =>
      act(async () => {
        state.set!(next);
      }),
    unmount: () => act(() => root.unmount()),
  };
}

describe("follow-up queue", () => {
  it("sends the first message once the thread is free, and the next after that turn ends", async () => {
    const queue = mountQueue({ quiet: false, settled: undefined });
    await queue.run(() => {
      queue.api.add(message("first"));
      queue.api.add(message("second"));
    });
    // A turn runs: nothing goes yet.
    expect(queue.posts).toEqual([]);

    await queue.thread({ quiet: true, settled: "t1:completed" });
    expect(queue.posts).toEqual(["first"]);
    expect(queue.api.queue.map((item) => item.text)).toEqual(["second"]);

    // "first" started a turn: "second" waits for it to end.
    await queue.thread({ quiet: false, settled: undefined });
    expect(queue.posts).toEqual(["first"]);
    await queue.thread({ quiet: true, settled: "t2:completed" });
    expect(queue.posts).toEqual(["first", "second"]);
    queue.unmount();
  });

  it("pauses on a failure instead of sending again, until resumed", async () => {
    const queue = mountQueue({ quiet: true, settled: "t1:completed" });
    queue.answer({ kind: "failed", message: "No agent runtime is installed on this node" });
    await queue.run(() => queue.api.add(message("hello")));
    expect(queue.posts).toEqual(["hello"]);
    expect(queue.api.paused).toBe("No agent runtime is installed on this node");

    // Another ending, another render: still no retry.
    await queue.thread({ quiet: true, settled: "t9:completed" });
    expect(queue.posts).toEqual(["hello"]);

    queue.answer({ kind: "sent" });
    await queue.run(() => queue.api.resume());
    expect(queue.posts).toEqual(["hello", "hello"]);
    expect(queue.api.queue).toEqual([]);
    expect(queue.api.paused).toBeUndefined();
    queue.unmount();
  });

  it("lets the rest go when the message that failed is removed", async () => {
    const queue = mountQueue({ quiet: true, settled: "t1:completed" });
    queue.answer({ kind: "failed", message: "Too large" });
    await queue.run(() => {
      queue.api.add(message("big"));
      queue.api.add(message("small"));
    });
    expect(queue.posts).toEqual(["big"]);

    queue.answer({ kind: "sent" });
    await queue.run(() => queue.api.remove("big"));
    expect(queue.posts).toEqual(["big", "small"]);
    expect(queue.api.queue).toEqual([]);
    queue.unmount();
  });

  it("waits for another ending when the thread turns out busy, without a loop", async () => {
    const queue = mountQueue({ quiet: true, settled: "t1:completed" });
    queue.answer({ kind: "busy" });
    await queue.run(() => queue.api.add(message("later")));
    expect(queue.posts).toEqual(["later"]);

    // The same ending, rendered again: it keeps waiting.
    await queue.thread({ quiet: true, settled: "t1:completed" });
    expect(queue.posts).toEqual(["later"]);

    // The turn that kept it busy (started elsewhere) runs and ends.
    queue.answer({ kind: "sent" });
    await queue.thread({ quiet: false, settled: undefined });
    await queue.thread({ quiet: true, settled: "t2:interrupted" });
    expect(queue.posts).toEqual(["later", "later"]);
    expect(queue.api.queue).toEqual([]);
    queue.unmount();
  });
});

describe("follow-up queues", () => {
  it("keep a thread's queue when its view goes away, and send it once the view is back", async () => {
    const queues = createFollowUpQueues();
    const first = mountQueue({ quiet: false, settled: undefined }, queues);
    await first.run(() => first.api.add(message("later")));
    // Another thread is opened: this view unmounts with the turn still running.
    first.unmount();
    expect(queues.get("node|t1").queue.map((item) => item.text)).toEqual(["later"]);

    const back = mountQueue({ quiet: true, settled: "t1:completed" }, queues);
    // Lets the send that mounting started settle.
    await back.run(() => undefined);
    expect(back.posts).toEqual(["later"]);
    expect(queues.get("node|t1").queue).toEqual([]);
    back.unmount();
  });
});
