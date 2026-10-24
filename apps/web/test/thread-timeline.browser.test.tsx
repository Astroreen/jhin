import { ThreadEvents } from "@jhin/agent-api";
import type { Connections, HistoryCache, NodeConnection, ThreadsCatalog } from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { messageText } from "@jhin/agent-api";
import { UserMessage } from "../src/plugins/chat/timeline.tsx";
import { DATABASE, openHistoryStore } from "../src/plugins/history-cache/store.ts";
import {
  useThreadTimeline,
  type ThreadTimelineState,
} from "../src/plugins/chat/thread-timeline.ts";

const target = { node: "ws://a/rpc" };

/** An RPC client that hands the test what it subscribes to. */
function fakeClient() {
  const subscribers: ((event: StoredEvent) => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  let disposed = 0;
  const client = {
    subscribe(
      _stream: string,
      options: { onError?: (error: Error) => void },
      onEvent: (event: StoredEvent) => void,
    ) {
      subscribers.push(onEvent);
      if (options.onError !== undefined) failures.push(options.onError);
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
    /** The stream fails, e.g. the node refused it after a reconnect. */
    fail(message: string) {
      failures.at(-1)!(new Error(message));
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
    const threads = {
      open: async (_target: unknown, threadId: string) => `thread/${threadId}`,
      call: () => Promise.reject(new Error("not asked without a history cache")),
    } as unknown as Pick<ThreadsCatalog, "open" | "call">;
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

describe("a thread's timeline from the history cache (loading.md D1589)", () => {
  /** A client that records each subscription's `after` and hands the test its events. */
  function recordingClient() {
    const subscriptions: { after: number; push(event: StoredEvent): void }[] = [];
    const waiters: (() => void)[] = [];
    const client = {
      subscribe(
        _stream: string,
        options: { after?: number },
        onEvent: (event: StoredEvent) => void,
      ) {
        subscriptions.push({ after: options.after ?? 0, push: onEvent });
        for (const waiter of waiters.splice(0)) waiter();
        return { lastSequence: 0, dispose: () => undefined };
      },
    } as unknown as NodeConnection["client"];
    const subscribed = () =>
      new Promise<void>((resolve) =>
        subscriptions.length > 0 ? resolve() : waiters.push(resolve),
      );
    return { client, subscriptions, subscribed };
  }
  const turn = (sequence: number, turnId: string, text: string): StoredEvent => ({
    stream: "thread/t1",
    sequence,
    type: ThreadEvents.turnStarted,
    payload: { turnId, agentId: "jhin.agent-fake", input: { text } },
    at: "2026-10-19T00:00:00.000Z",
  });
  /** The real IndexedDB store, as the plugin serves it; `written` settles every write so far. */
  function cacheOnDisk() {
    const store = openHistoryStore();
    const writes: Promise<void>[] = [];
    const cache: HistoryCache = {
      enabled: () => true,
      read: (connection, stream) => store.read(connection, stream, Date.now()),
      append: (connection, stream, epoch, events) => {
        const write = store.append(connection, stream, epoch, events, Date.now());
        writes.push(write);
        return write;
      },
      drop: (connection, stream) => store.drop(connection, stream),
    };
    return { cache, store, written: () => Promise.all(writes) };
  }
  const threads = {
    open: async (_target: unknown, threadId: string) => `thread/${threadId}`,
    call: async () => ({ epoch: "e1", head: 2 }),
  } as unknown as Pick<ThreadsCatalog, "open" | "call">;

  it("after a reload shows the kept turns at once and asks only for what follows them", async () => {
    // The first visit reads the thread from 0 and keeps it.
    const before = recordingClient();
    const disk = cacheOnDisk();
    const seen: { state?: ThreadTimelineState } = {};
    const texts = () => seen.state?.timeline.turns.map((item) => item.text);
    let nodes = fakeConnections(before.client);
    let cache = disk.cache;
    function View() {
      seen.state = useThreadTimeline(threads, nodes.connections, target, "t1", cache);
      return null;
    }
    let root = createRoot(document.createElement("div"));
    await act(async () => root.render(<View />));
    await before.subscribed();
    expect(before.subscriptions[0]!.after).toBe(0);
    before.subscriptions[0]!.push(turn(1, "u1", "hello"));
    before.subscriptions[0]!.push(turn(2, "u2", "again"));
    await nextFrame();
    await disk.written();
    act(() => root.unmount());
    disk.store.close();

    // The page again, with the database opened anew.
    const after = recordingClient();
    const reopened = cacheOnDisk();
    nodes = fakeConnections(after.client);
    cache = reopened.cache;
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<View />));
    await act(() => after.subscribed());
    expect(after.subscriptions[0]!.after).toBe(2);
    expect(texts()).toEqual(["hello", "again"]);
    after.subscriptions[0]!.push(turn(3, "u3", "new"));
    await nextFrame();
    expect(texts()).toEqual(["hello", "again", "new"]);
    act(() => root.unmount());
    reopened.store.close();
    await new Promise<void>((resolve) => {
      const deleting = indexedDB.deleteDatabase(DATABASE);
      deleting.addEventListener("success", () => resolve());
    });
  });
});

describe("a thread's timeline errors", () => {
  it("clear once the stream delivers again", async () => {
    const node = fakeClient();
    const nodes = fakeConnections(node.client);
    const threads = {
      open: async (_target: unknown, threadId: string) => `thread/${threadId}`,
      call: () => Promise.reject(new Error("not asked without a history cache")),
    } as unknown as Pick<ThreadsCatalog, "open" | "call">;
    const seen: { state?: ThreadTimelineState } = {};
    function View() {
      seen.state = useThreadTimeline(threads, nodes.connections, target, "t1");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<View />));

    await act(async () => node.fail("Connection closed before the call completed"));
    expect(seen.state?.error).toBe("Connection closed before the call completed");
    node.turn(1, "u1", "hello");
    await nextFrame();
    expect(seen.state?.error).toBeUndefined();
    expect(seen.state?.timeline.turns.map((turn) => turn.text)).toEqual(["hello"]);
    act(() => root.unmount());
  });

  it("say so when the thread's node is not connected", async () => {
    const nodes = fakeConnections(fakeClient().client);
    const threads = {
      open: async (_target: unknown, threadId: string) => `thread/${threadId}`,
      call: () => Promise.reject(new Error("not asked without a history cache")),
    } as unknown as Pick<ThreadsCatalog, "open" | "call">;
    const seen: { state?: ThreadTimelineState } = {};
    function View() {
      seen.state = useThreadTimeline(threads, nodes.connections, { node: "ws://other/rpc" }, "t1");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<View />));
    expect(seen.state?.error).toBe("Not connected to this thread's node");
    act(() => root.unmount());
  });
});

describe("a message between agents in the transcript (D1381)", () => {
  const base = {
    text: "Please review the slice",
    attachments: [],
    startedAt: "2026-10-19T00:00:00.000Z",
  };
  const render = async (node: React.ReactElement) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(node));
    return { host, unmount: () => act(() => root.unmount()) };
  };

  it("is labelled with its sender, not You, and links back to an agent", async () => {
    const opened: string[] = [];
    const { host, unmount } = await render(
      <UserMessage
        format="locale"
        onOpenSender={(origin) => () => opened.push(origin.from)}
        turn={{
          ...base,
          origin: {
            messageId: "m1",
            kind: "ask",
            from: "jhin://n1/agents/builder",
            traceId: "tr1",
          },
        }}
      />,
    );
    expect(host.querySelector("article")?.getAttribute("aria-label")).toBe("builder, question");
    const link = host.querySelector<HTMLButtonElement>("[data-message-sender] button");
    expect(link?.textContent).toBe("builder · question");
    act(() => link?.click());
    expect(opened).toEqual(["jhin://n1/agents/builder"]);
    unmount();
  });

  it("shows a delivered message without its header line and trailer (D1396)", async () => {
    const message = {
      messageId: "m1",
      kind: "ask" as const,
      from: "jhin://n1/agents/builder",
      to: "jhin://n1/agents/lead",
      body: "Is slice 3 done?",
      traceId: "tr1",
      sentAt: "2026-10-19T00:00:00.000Z",
    };
    const { host, unmount } = await render(
      <UserMessage
        format="locale"
        turn={{
          ...base,
          text: messageText(message),
          origin: { messageId: "m1", kind: "ask", from: message.from, traceId: "tr1" },
        }}
      />,
    );
    const article = host.querySelector("article")!;
    expect(article.textContent).toContain("Is slice 3 done?");
    expect(article.textContent).not.toContain("Question from");
    expect(article.textContent).not.toContain("Your last message in this turn");
    unmount();
    // A user's own prompt that merely looks like a header is shown whole.
    const own = await render(
      <UserMessage format="locale" turn={{ ...base, text: messageText(message) }} />,
    );
    expect(own.host.querySelector("article")?.textContent).toContain("Question from");
    own.unmount();
  });

  it("shows the sender without a link when it cannot be reached, and a user's message as You", async () => {
    const from = await render(
      <UserMessage
        format="locale"
        onOpenSender={() => undefined}
        turn={{
          ...base,
          origin: { messageId: "m2", kind: "message", from: "jhin://n1/owner", traceId: "tr2" },
        }}
      />,
    );
    expect(from.host.querySelector("article")?.getAttribute("aria-label")).toBe("Owner, message");
    expect(from.host.querySelector("[data-message-sender] button")).toBeNull();
    expect(from.host.querySelector("[data-message-sender]")?.textContent).toBe("Owner · message");
    from.unmount();
    const own = await render(<UserMessage format="locale" turn={base} />);
    expect(own.host.querySelector("article")?.getAttribute("aria-label")).toBe("You");
    expect(own.host.querySelector("[data-message-sender]")).toBeNull();
    own.unmount();
  });
});
