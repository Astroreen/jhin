import { INBOX_STREAM, MessageEvents, type InboxItem } from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import type { NodeFeeds } from "../src/lib/node-feeds.ts";
import { senderLabel } from "../src/plugins/inbox/route.ts";
import { applyInboxEvent, createInboxStore, openItems } from "../src/plugins/inbox/store.ts";

const item = (messageId: string, sentAt: string, kind: "ask" | "message" = "ask"): InboxItem => ({
  message: {
    messageId,
    kind,
    from: "jhin://node-a/agents/builder",
    to: "jhin://node-a/owner",
    body: `question ${messageId}`,
    traceId: `trace-${messageId}`,
    sentAt,
  },
  status: "open",
});

type Listener = (event: { type: string; payload: unknown }) => void;

/** One open node: its `agents.inbox.list` answer, and its inbox stream to push events into. */
function fakeNode(list: () => Promise<unknown>) {
  const streams = new Map<
    string,
    { after: number; listener: Listener; onError?: ((error: unknown) => void) | undefined }
  >();
  const listeners = new Set<() => void>();
  let state: NodeConnection["state"] = "open";
  const connection = {
    id: "a",
    url: "ws://a",
    label: "a",
    get state() {
      return state;
    },
    client: {
      call: (method: string) =>
        method === "agents.inbox.list" ? list() : Promise.reject(new Error(method)),
      subscribe: (
        stream: string,
        options: { after: number; onError?: (error: unknown) => void },
        listener: Listener,
      ) => {
        streams.set(stream, { after: options.after, listener, onError: options.onError });
        return toDisposable(() => streams.delete(stream));
      },
    },
  } as unknown as NodeConnection;
  const connections = {
    list: () => [connection],
    get: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as Connections;
  return {
    connections,
    streams,
    close() {
      state = "closed" as NodeConnection["state"];
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** Resolves once node `id` has answered (ready, unsupported or failed): a fact, not a wait. */
function settled(store: NodeFeeds<unknown>, id = "a"): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      const status = store.snapshot().get(id)?.status;
      if (status === undefined || status === "loading") return false;
      resolve();
      return true;
    };
    if (done()) return;
    const subscription = store.subscribe(() => {
      if (done()) subscription.dispose();
    });
  });
}
const quiet = { warn() {} };

describe("the owner's inbox (D630)", () => {
  it("lists the open items, follows the stream after its head and tells only new ones", async () => {
    const node = fakeNode(() =>
      Promise.resolve({ head: 4, items: [item("q1", "2026-10-21T10:00:00Z")] }),
    );
    const told: string[] = [];
    const store = createInboxStore(node.connections, quiet, (_connection, arrived) =>
      told.push(arrived.message.messageId),
    );
    await settled(store);
    expect(store.snapshot().get("a")).toMatchObject({ status: "ready" });
    expect(node.streams.get(INBOX_STREAM)?.after).toBe(4);
    expect(told).toEqual([]);

    const push = node.streams.get(INBOX_STREAM)!.listener;
    push({ type: MessageEvents.received, payload: item("q2", "2026-10-21T09:00:00Z", "message") });
    // The same item again (a replayed event) is no second item.
    push({ type: MessageEvents.received, payload: item("q2", "2026-10-21T09:00:00Z", "message") });
    expect(told).toEqual(["q2"]);
    expect(openItems(store.snapshot()).map((entry) => entry.item.message.messageId)).toEqual([
      "q2",
      "q1",
    ]);

    push({ type: MessageEvents.inboxAnswered, payload: { messageId: "q1", answer: "yes" } });
    expect(openItems(store.snapshot()).map((entry) => entry.item.message.messageId)).toEqual([
      "q2",
    ]);

    // A closed connection's items are not live any more.
    node.close();
    expect(store.snapshot().has("a")).toBe(false);
    expect(node.streams.size).toBe(0);
    store.dispose();
  });

  it("takes a node that may not read the inbox as one without it", async () => {
    const node = fakeNode(() =>
      Promise.reject(Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" })),
    );
    const store = createInboxStore(node.connections, quiet, () => {});
    await settled(store);
    expect(store.snapshot().get("a")).toMatchObject({ status: "unsupported", value: [] });
    store.dispose();
  });

  it("keeps the open items, marked not live, when the stream fails after the list", async () => {
    const node = fakeNode(() =>
      Promise.resolve({ head: 1, items: [item("q1", "2026-10-21T10:00:00Z")] }),
    );
    const store = createInboxStore(node.connections, quiet, () => {});
    await settled(store);
    // A stream that drops is read once more (D731); the second drop stays.
    const reread = new Promise<void>((resolve) => {
      const subscription = store.subscribe(() => {
        if (store.snapshot().get("a")?.status !== "ready") return;
        subscription.dispose();
        resolve();
      });
    });
    node.streams.get(INBOX_STREAM)!.onError!(new Error("stream dropped"));
    await reread;
    node.streams.get(INBOX_STREAM)!.onError!(new Error("stream gone"));
    expect(store.snapshot().get("a")).toMatchObject({ status: "error", error: "stream gone" });
    expect(openItems(store.snapshot()).map((entry) => entry.item.message.messageId)).toEqual([
      "q1",
    ]);
    store.dispose();
  });

  it("ignores events that are not an open item's", () => {
    const state: readonly InboxItem[] = [];
    expect(applyInboxEvent(state, { type: MessageEvents.received, payload: null })).toBe(state);
    expect(
      applyInboxEvent(state, { type: MessageEvents.inboxAnswered, payload: { messageId: "x" } }),
    ).toBe(state);
  });

  it("names a sender short", () => {
    expect(senderLabel("jhin://node-a/agents/builder")).toBe("builder@node-a");
    expect(senderLabel("jhin://node-a/owner")).toBe("owner@node-a");
    expect(senderLabel("jhin://node-a/threads/t1")).toBe("a thread@node-a");
    expect(senderLabel("jhin://453867af-e9fe-4274-84eb-f9898a8ece99/agents/lead")).toBe(
      "lead@453867af",
    );
    expect(senderLabel("elsewhere")).toBe("elsewhere");
  });
});
