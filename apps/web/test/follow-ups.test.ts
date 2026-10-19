import { visitKey, type NodeCatalog, type ThreadRecord, type TurnStatus } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import {
  createFollowUpQueues,
  type QueuedMessage,
  type SendOutcome,
} from "../src/plugins/chat/follow-ups.ts";

const target = { node: "ws://a/rpc" };
const key = visitKey(target, "th1");
const message = (text: string): QueuedMessage => ({
  id: text,
  text,
  attachments: [],
  settings: { agentId: "jhin.agent-fake", model: "fast" },
});

/** A node's catalog with thread `th1`, whose latest turn the test moves along. */
function fakeNode() {
  let thread: ThreadRecord | undefined = {
    id: "th1",
    projectId: "scratch",
    title: "Thread",
    createdAt: "2026-10-19T00:00:00.000Z",
  };
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    threads: {
      catalog: (): NodeCatalog => ({
        status: "ready",
        projects: [],
        threads: thread === undefined ? [] : [thread],
      }),
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    /** The node records where the thread's latest turn is. */
    turn(turnId: string, status: TurnStatus) {
      thread = {
        ...thread!,
        lastTurn: { turnId, status, at: "2026-10-19T00:00:01.000Z", agentId: "jhin.agent-fake" },
      };
      changed();
    },
    /** The thread is deleted on its node. */
    remove() {
      thread = undefined;
      changed();
    },
    get followers() {
      return listeners.size;
    },
  };
}

/** The page's queues over `node`; each send is answered with what the test says. */
function queuesOf(node: ReturnType<typeof fakeNode>) {
  const sent: QueuedMessage[] = [];
  let answer: SendOutcome = { kind: "sent" };
  let last: Promise<unknown> = Promise.resolve();
  const queues = createFollowUpQueues({
    threads: node.threads,
    post: (_target, threadId, queued) => {
      expect(threadId).toBe("th1");
      sent.push(queued);
      // A loop of sends stops here: the test then fails on what was sent instead of hanging.
      if (sent.length > 10) return new Promise<SendOutcome>(() => undefined);
      const outcome = Promise.resolve(answer);
      last = outcome;
      return outcome;
    },
  });
  return {
    queues,
    texts: () => sent.map((item) => item.text),
    sent,
    answer(next: SendOutcome) {
      answer = next;
    },
    /** Lets the send last made settle, and the queue take its outcome. */
    settled: () => last.then(() => undefined),
    queued: () => queues.get(key).queue.map((item) => item.text),
  };
}

describe("follow-up queues", () => {
  it("send the first message once the turn ended, and the next after another ending", async () => {
    const node = fakeNode();
    node.turn("u1", "running");
    const page = queuesOf(node);
    page.queues.add(target, "th1", message("first"));
    page.queues.add(target, "th1", message("second"));
    // A turn runs: nothing goes yet.
    expect(page.texts()).toEqual([]);

    node.turn("u1", "completed");
    await page.settled();
    expect(page.texts()).toEqual(["first"]);
    // With what it was typed with.
    expect(page.sent[0]?.settings).toEqual({ agentId: "jhin.agent-fake", model: "fast" });
    expect(page.queued()).toEqual(["second"]);

    // "first" started a turn: "second" waits for it to end, and for an answer it asks.
    node.turn("u2", "running");
    node.turn("u2", "waiting");
    expect(page.texts()).toEqual(["first"]);
    node.turn("u2", "completed");
    await page.settled();
    expect(page.texts()).toEqual(["first", "second"]);
    expect(page.queued()).toEqual([]);
  });

  it("pause on a failure instead of sending again, until resumed", async () => {
    const node = fakeNode();
    node.turn("u1", "completed");
    const page = queuesOf(node);
    page.answer({ kind: "failed", message: "No agent runtime is installed on this node" });
    page.queues.add(target, "th1", message("hello"));
    await page.settled();
    expect(page.texts()).toEqual(["hello"]);
    expect(page.queues.get(key).paused).toEqual({
      kind: "failed",
      message: "No agent runtime is installed on this node",
    });

    // Another ending: still no retry.
    node.turn("u9", "completed");
    expect(page.texts()).toEqual(["hello"]);

    page.answer({ kind: "sent" });
    page.queues.resume(key);
    await page.settled();
    expect(page.texts()).toEqual(["hello", "hello"]);
    expect(page.queues.get(key)).toEqual({ queue: [], sending: false });
  });

  it("let the rest go when the message that failed is removed", async () => {
    const node = fakeNode();
    node.turn("u1", "completed");
    const page = queuesOf(node);
    page.answer({ kind: "failed", message: "Too large" });
    page.queues.add(target, "th1", message("big"));
    page.queues.add(target, "th1", message("small"));
    await page.settled();
    expect(page.texts()).toEqual(["big"]);

    page.answer({ kind: "sent" });
    page.queues.remove(key, "big");
    await page.settled();
    expect(page.texts()).toEqual(["big", "small"]);
    expect(page.queued()).toEqual([]);
  });

  it("wait for another ending when the thread turns out busy, without a loop", async () => {
    const node = fakeNode();
    // The record still shows the last ending: a turn started elsewhere is not in it yet.
    node.turn("u1", "completed");
    const page = queuesOf(node);
    page.answer({ kind: "busy" });
    page.queues.add(target, "th1", message("later"));
    await page.settled();
    expect(page.texts()).toEqual(["later"]);

    // The same ending, told again: it keeps waiting.
    node.turn("u1", "completed");
    expect(page.texts()).toEqual(["later"]);

    // The turn that kept it busy runs and ends.
    page.answer({ kind: "sent" });
    node.turn("u2", "running");
    node.turn("u2", "completed");
    await page.settled();
    expect(page.texts()).toEqual(["later", "later"]);
    expect(page.queued()).toEqual([]);
  });

  it("hold after a turn that was stopped or failed, until resumed", async () => {
    for (const status of ["interrupted", "failed"] as const) {
      const node = fakeNode();
      node.turn("u1", "running");
      const page = queuesOf(node);
      page.queues.add(target, "th1", message("later"));

      node.turn("u1", status);
      expect(page.texts()).toEqual([]);
      expect(page.queues.get(key).paused).toEqual({
        kind: "held",
        message: status === "interrupted" ? "The turn was stopped" : "The turn failed",
      });

      page.queues.resume(key);
      await page.settled();
      expect(page.texts()).toEqual(["later"]);
      expect(page.queued()).toEqual([]);
    }
  });

  it("are not held by a stop that came before them", async () => {
    const node = fakeNode();
    // Stopped before: the record still shows it while a turn started elsewhere runs.
    node.turn("u1", "interrupted");
    const page = queuesOf(node);
    page.answer({ kind: "busy" });
    page.queues.add(target, "th1", message("later"));
    await page.settled();
    expect(page.queues.get(key).paused).toBeUndefined();

    page.answer({ kind: "sent" });
    node.turn("u2", "running");
    node.turn("u2", "completed");
    await page.settled();
    expect(page.texts()).toEqual(["later", "later"]);
  });

  it("tell while the first message is on its way", () => {
    const node = fakeNode();
    node.turn("u1", "completed");
    const page = queuesOf(node);
    page.queues.add(target, "th1", message("now"));
    expect(page.queues.get(key)).toMatchObject({ queue: [message("now")], sending: true });
  });

  it("drop the queue of a thread gone from its node", () => {
    const node = fakeNode();
    node.turn("u1", "running");
    const page = queuesOf(node);
    page.queues.add(target, "th1", message("later"));
    node.remove();
    expect(page.queues.get(key)).toEqual({ queue: [], sending: false });
    expect(node.followers).toBe(0);
    expect(page.texts()).toEqual([]);
  });

  it("follow a node's catalog only while they hold messages for it, with no view needed", async () => {
    const node = fakeNode();
    node.turn("u1", "running");
    const page = queuesOf(node);
    expect(node.followers).toBe(0);

    page.queues.add(target, "th1", message("later"));
    expect(node.followers).toBe(1);
    node.turn("u1", "completed");
    await page.settled();
    expect(page.texts()).toEqual(["later"]);
    expect(node.followers).toBe(0);

    page.queues.add(target, "th1", message("again"));
    page.queues.dispose();
    expect(node.followers).toBe(0);
  });
});
