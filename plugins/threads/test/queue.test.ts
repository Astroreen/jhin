import { ThreadEvents, type AgentRegistry, type AgentRuntime } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  lastTurn?: { turnId: string; status: string };
}
interface QueueView {
  messages: { id: string; text: string; attachments: { name: string }[]; model?: string }[];
  held?: { reason: string; turnId?: string; error?: string };
}

const IMAGE = {
  kind: "image",
  name: "dot.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
} as const;

/** The queue as the thread's stream announced it last. */
const lastQueue = (events: readonly StoredEvent[]) =>
  events.findLast((event) => event.type === ThreadEvents.queueUpdated)?.payload as
    | QueueView
    | undefined;
/** What the turns of a thread were started with, in order. */
const started = (events: readonly StoredEvent[]) =>
  events
    .filter((event) => event.type === ThreadEvents.turnStarted)
    .map((event) => (event.payload as { input: { text: string } }).input.text);
/** The texts of the agent's completed messages. */
const answers = (events: readonly StoredEvent[]) =>
  events
    .filter(
      (event) =>
        event.type === ThreadEvents.itemCompleted &&
        (event.payload as { kind: string }).kind === "message",
    )
    .map((event) => (event.payload as { text: string }).text);
const count = (events: readonly StoredEvent[], type: string) =>
  events.filter((event) => event.type === type).length;

/** Resolves once the thread's stream has had `n` events of `type` (seen or future). */
const untilCount = (watched: ReturnType<typeof watch>, type: string, n: number) =>
  watched.untilMatch(() => count(watched.events, type) >= n);

/** A thread running a `/hold` turn, which holds until it is interrupted or steered. */
async function holding(options: Parameters<typeof node>[0] = {}) {
  const running = await node(options);
  const thread = await running.client.call<Thread>("threads.create", {});
  const watched = watch(running.client, thread.id);
  await running.client.call("threads.send", { threadId: thread.id, text: "/hold on" });
  await watched.until(ThreadEvents.itemDelta);
  return { ...running, thread, watched, ...watched };
}

describe("jhin.threads: the queue (D201–D203)", () => {
  it("starts a message at once on a free thread and queues it behind a running turn", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const watched = watch(client, thread.id);
    const { events, until } = watched;

    const first = await client.call<{ messageId: string; turnId?: string }>("threads.queue.add", {
      threadId: thread.id,
      text: "/hold first",
      messageId: "m-1",
    });
    expect(first).toEqual({ messageId: "m-1", turnId: expect.any(String) });
    await until(ThreadEvents.itemDelta);
    const second = await client.call("threads.queue.add", {
      threadId: thread.id,
      text: "second",
      model: "echo",
    });
    expect(second).toEqual({ messageId: expect.any(String) });
    // Asking again with the same id queues nothing more.
    await client.call("threads.queue.add", { threadId: thread.id, text: "x", messageId: "m-2" });
    await client.call("threads.queue.add", { threadId: thread.id, text: "x", messageId: "m-2" });
    expect(lastQueue(events)?.messages.map((message) => message.text)).toEqual(["second", "x"]);
    expect(lastQueue(events)?.messages[0]).toMatchObject({ model: "echo" });

    // The running turn ends: the queue goes out turn by turn.
    await client.call("threads.steer", { threadId: thread.id, text: "go on" });
    await untilCount(watched, ThreadEvents.turnCompleted, 3);
    expect(started(events)).toEqual(["/hold first", "second", "x"]);
    expect(lastQueue(events)).toEqual({ messages: [] });
    const turns = events.filter((event) => event.type === ThreadEvents.turnStarted);
    expect(turns[0]!.payload).toMatchObject({ messageId: "m-1" });
    expect(turns[2]!.payload).toMatchObject({ messageId: "m-2" });
    expect(await client.call("threads.queue.list", { threadId: thread.id })).toEqual({
      messages: [],
    });
  });

  it("edits, reorders and cancels queued messages", async () => {
    const { client, thread, events } = await holding();
    for (const id of ["a", "b", "c"]) {
      await client.call("threads.queue.add", { threadId: thread.id, text: id, messageId: id });
    }
    const target = { threadId: thread.id };

    const edited = await client.call<QueueView>("threads.queue.edit", {
      ...target,
      messageId: "b",
      text: "b, edited",
      attachments: [IMAGE],
    });
    expect(edited.messages[1]).toMatchObject({
      text: "b, edited",
      attachments: [{ kind: "image", name: "dot.png", mimeType: "image/png" }],
    });
    // The event carries the image's name, the queue its data.
    expect(JSON.stringify(lastQueue(events))).not.toContain("base64");
    const listed = await client.call<{ messages: { attachments?: unknown[] }[] }>(
      "threads.queue.list",
      target,
    );
    expect(listed.messages[1]!.attachments).toEqual([IMAGE]);
    await expect(
      client.call("threads.queue.edit", { ...target, messageId: "a", text: " " }),
    ).rejects.toMatchObject({ code: "MESSAGE_EMPTY" });

    const order = (view: QueueView) => view.messages.map((message) => message.id);
    expect(
      order(
        await client.call("threads.queue.reorder", {
          ...target,
          messageId: "c",
          beforeMessageId: "a",
        }),
      ),
    ).toEqual(["c", "a", "b"]);
    expect(
      order(
        await client.call("threads.queue.reorder", {
          ...target,
          messageId: "c",
          beforeMessageId: null,
        }),
      ),
    ).toEqual(["a", "b", "c"]);
    expect(order(await client.call("threads.queue.cancel", { ...target, messageId: "b" }))).toEqual(
      ["a", "c"],
    );
    for (const call of [
      client.call("threads.queue.cancel", { ...target, messageId: "b" }),
      client.call("threads.queue.edit", { ...target, messageId: "b", text: "y" }),
      client.call("threads.queue.reorder", { ...target, messageId: "a", beforeMessageId: "b" }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "QUEUED_MESSAGE_NOT_FOUND" });
    }
    expect(order(lastQueue(events)!)).toEqual(["a", "c"]);
  });

  it("holds the queue after a stopped turn until it is resumed", async () => {
    const { client, thread, events, until, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "next" });

    await client.call("threads.interrupt", { threadId: thread.id });
    await until(ThreadEvents.turnInterrupted);
    const { untilMatch } = watch(client, thread.id);
    await untilMatch(
      (event) =>
        event.type === ThreadEvents.queueUpdated &&
        (event.payload as unknown as QueueView).held !== undefined,
    );
    expect(lastQueue(events)?.held).toMatchObject({
      reason: "interrupted",
      turnId: (
        events.find((event) => event.type === ThreadEvents.turnStarted)!.payload as {
          turnId: string;
        }
      ).turnId,
    });
    // A message added meanwhile waits behind the held one.
    await client.call("threads.queue.add", { threadId: thread.id, text: "later" });
    expect(started(events)).toEqual(["/hold on"]);

    expect(await client.call("threads.queue.resume", { threadId: thread.id })).toMatchObject({
      messages: [{ text: "next" }, { text: "later" }],
    });
    await untilCount(watched, ThreadEvents.turnCompleted, 2);
    expect(started(events)).toEqual(["/hold on", "next", "later"]);
  });

  it("holds a message the node refuses to start, with the reason", async () => {
    const { client, thread, events, until } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "next" });
    await client.call("threads.archive", { threadId: thread.id });
    await until(ThreadEvents.turnInterrupted);
    // Archived: it takes no new messages, and resuming its queue is refused.
    await expect(
      client.call("threads.queue.add", { threadId: thread.id, text: "no" }),
    ).rejects.toMatchObject({ code: "THREAD_ARCHIVED" });
    await client.call("threads.queue.resume", { threadId: thread.id });
    const { untilMatch } = watch(client, thread.id);
    await untilMatch(
      (event) =>
        event.type === ThreadEvents.queueUpdated &&
        (event.payload as unknown as QueueView).held?.reason === "refused",
    );
    expect(lastQueue(events)).toMatchObject({
      messages: [{ text: "next" }],
      held: { reason: "refused", error: expect.stringContaining("archived") },
    });

    await client.call("threads.unarchive", { threadId: thread.id });
    await client.call("threads.queue.resume", { threadId: thread.id });
    await until(ThreadEvents.turnCompleted);
    expect(started(events)).toEqual(["/hold on", "next"]);
  });

  it("keeps the queue across a restart of the node and goes on with it", async () => {
    const first = await holding();
    await first.client.call("threads.queue.add", { threadId: first.thread.id, text: "after" });
    await first.stop();

    // The node stopped the turn: the queue waits, as after any stop.
    const again = await node({ storage: first.storage, data: first.data });
    expect(
      await again.client.call("threads.queue.list", { threadId: first.thread.id }),
    ).toMatchObject({ messages: [{ text: "after" }], held: { reason: "interrupted" } });
    const watched = watch(again.client, first.thread.id);
    const { events, until } = watched;
    await again.client.call("threads.queue.resume", { threadId: first.thread.id });
    await until(ThreadEvents.turnCompleted);
    expect(answers(events)).toContain("Echo: after");
  });

  it("starts a queue that is not held once the node is up", async () => {
    const first = await node();
    const thread = await first.client.call<Thread>("threads.create", {});
    const before = watch(first.client, thread.id);
    await first.client.call("threads.send", { threadId: thread.id, text: "hello" });
    await before.until(ThreadEvents.turnCompleted);
    await first.stop();
    // A queue left behind by a node that stopped between a turn's end and its delivery.
    await first.storage.storage.kv.set("jhin.threads", `queue/${thread.id}`, {
      messages: [{ id: "q", text: "left over", createdAt: new Date().toISOString() }],
    });

    const again = await node({ storage: first.storage, data: first.data });
    const watched = watch(again.client, thread.id);
    await untilCount(watched, ThreadEvents.turnCompleted, 2);
    expect(started(watched.events)).toEqual(["hello", "left over"]);
  });

  it("drops the queue of a deleted thread", async () => {
    const { client, thread, storage } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "never" });
    await client.call("threads.delete", { threadId: thread.id });

    expect(await storage.storage.kv.get("jhin.threads", `queue/${thread.id}`)).toBeUndefined();
    await expect(client.call("threads.queue.list", { threadId: thread.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
    const stream = await storage.storage.log.read(`thread/${thread.id}`);
    expect(stream.at(-1)?.type).toBe(ThreadEvents.threadDeleted);
  });
});

describe("jhin.threads: the queue under failures (D202)", () => {
  it("holds the queue after a queued message's turn failed", async () => {
    const { client, thread, events, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "/fail now" });
    await client.call("threads.queue.add", { threadId: thread.id, text: "after" });
    await client.call("threads.steer", { threadId: thread.id, text: "end it" });

    await untilCount(watched, ThreadEvents.turnFailed, 1);
    await watched.untilMatch(() => lastQueue(events)?.held !== undefined);
    expect(lastQueue(events)).toMatchObject({
      messages: [{ text: "after" }],
      held: { reason: "failed" },
    });
    expect(started(events)).toEqual(["/hold on", "/fail now"]);
  });

  it("takes a message out of its queue in the write that starts its turn", async () => {
    const { client, thread, storage, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "next" });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const writes: { types: string[]; keys: string[] }[] = [];
    log.append = async (stream, batch, options) => {
      if (stream === `thread/${thread.id}`) {
        writes.push({
          types: batch.map((event) => event.type),
          keys: (options?.records ?? []).map((record) => record.key),
        });
      }
      return append(stream, batch, options);
    };
    await client.call("threads.steer", { threadId: thread.id, text: "go" });
    await untilCount(watched, ThreadEvents.turnCompleted, 2);

    expect(
      writes.find((write) => write.types[0] === ThreadEvents.turnStarted && write.types.length > 1),
    ).toEqual({
      types: [ThreadEvents.turnStarted, ThreadEvents.queueUpdated],
      keys: [`queue/${thread.id}`],
    });
  });

  it("keeps a message whose turn could not be recorded, and holds the queue", async () => {
    const { client, thread, storage, events, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "next" });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    log.append = async (stream, batch, options) => {
      if (
        batch.some(
          (event) => (event.payload as { input?: { text?: string } }).input?.text === "next",
        )
      ) {
        log.append = append;
        throw new Error("disk full");
      }
      return append(stream, batch, options);
    };
    await client.call("threads.steer", { threadId: thread.id, text: "go" });

    await watched.untilMatch(() => lastQueue(events)?.held?.reason === "refused");
    expect(lastQueue(events)).toMatchObject({
      messages: [{ text: "next" }],
      held: { reason: "refused", error: expect.stringContaining("disk full") },
    });
  });

  it("records a stopped turn's end even when its queue cannot be read", async () => {
    const { client, thread, storage, until } = await holding();
    const kv = storage.storage.kv;
    const get = kv.get.bind(kv);
    kv.get = async (namespace, key) => {
      if (key === `queue/${thread.id}`) {
        kv.get = get;
        throw new Error("disk unreadable");
      }
      return get(namespace, key);
    };
    await client.call("threads.interrupt", { threadId: thread.id });
    await until(ThreadEvents.turnInterrupted);
    // The thread is free again.
    await client.call("threads.send", { threadId: thread.id, text: "again" });
  });

  it("refuses to promote a message while the turn is being stopped, and keeps it", async () => {
    const { client, thread, events, until, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "a", messageId: "a" });
    await client.call("threads.interrupt", { threadId: thread.id });
    await expect(
      client.call("threads.queue.steer", { threadId: thread.id, messageId: "a" }),
    ).rejects.toMatchObject({ code: "TURN_NOT_RUNNING" });
    await until(ThreadEvents.turnInterrupted);
    await watched.untilMatch(() => lastQueue(events)?.held !== undefined);
    expect(lastQueue(events)?.messages.map((message) => message.id)).toEqual(["a"]);
    expect(count(events, ThreadEvents.turnSteered)).toBe(0);
  });

  it("removes a queued message's images when edited with none", async () => {
    const { client, thread } = await holding();
    await client.call("threads.queue.add", {
      threadId: thread.id,
      text: "with image",
      attachments: [IMAGE],
      messageId: "img",
    });
    const view = await client.call<QueueView>("threads.queue.edit", {
      threadId: thread.id,
      messageId: "img",
      text: "without",
      attachments: [],
    });
    expect(view.messages[0]).toMatchObject({ text: "without", attachments: [] });
  });
});

describe("jhin.threads: writes that go together (D202, D205)", () => {
  it("takes a promoted message out of its queue in the write that records the steer", async () => {
    const { client, thread, storage, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "a", messageId: "a" });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const writes: { types: string[]; keys: string[] }[] = [];
    log.append = async (stream, batch, options) => {
      writes.push({
        types: batch.map((event) => event.type),
        keys: (options?.records ?? []).map((record) => record.key),
      });
      return append(stream, batch, options);
    };
    await client.call("threads.queue.steer", { threadId: thread.id, messageId: "a" });
    await untilCount(watched, ThreadEvents.turnCompleted, 1);

    expect(writes.find((write) => write.types[0] === ThreadEvents.turnSteered)).toEqual({
      types: [ThreadEvents.turnSteered, ThreadEvents.queueUpdated],
      keys: [`queue/${thread.id}`],
    });
  });

  it("takes a promoted message out of its queue even when the steer's record fails", async () => {
    const { client, thread, storage, events, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "a", messageId: "a" });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    log.append = async (stream, batch, options) => {
      if (batch.some((event) => event.type === ThreadEvents.turnSteered)) {
        log.append = append;
        throw new Error("disk full");
      }
      return append(stream, batch, options);
    };
    await client.call("threads.queue.steer", { threadId: thread.id, messageId: "a" });
    await untilCount(watched, ThreadEvents.turnCompleted, 1);

    // The agent had it: it never runs again as a turn of its own.
    expect(lastQueue(events)).toEqual({ messages: [] });
    expect(started(events)).toEqual(["/hold on"]);
  });

  it("never sends a steered message again when its queue cannot be written either", async () => {
    const { client, thread, storage, events, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "a", messageId: "a" });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    let failures = 2;
    log.append = async (stream, batch, options) => {
      if (
        failures > 0 &&
        (options?.records ?? []).some((record) => record.key.startsWith("queue/"))
      ) {
        failures--;
        throw new Error("disk full");
      }
      return append(stream, batch, options);
    };
    await client.call("threads.queue.steer", { threadId: thread.id, messageId: "a" });
    await untilCount(watched, ThreadEvents.turnCompleted, 1);
    await watched.untilMatch(() => lastQueue(events)?.messages.length === 0);

    expect(started(events)).toEqual(["/hold on"]);
  });

  it("lets the fake agent take a steer that came before its turn waits", async () => {
    const turn = fakeTurn({
      threadId: "t",
      turnId: "u",
      input: { text: "/hold" },
      history: [],
      cwd: "/",
    });
    turn.steer!({ text: "early" });
    const texts: string[] = [];
    for await (const item of turn.items) {
      if (item.kind === "message.completed") texts.push(item.text);
    }
    expect(texts).toEqual(["Echo: early"]);
  });

  it("does not hold again on restart a queue the user resumed", async () => {
    const first = await holding();
    await first.client.call("threads.queue.add", { threadId: first.thread.id, text: "after" });
    await first.client.call("threads.interrupt", { threadId: first.thread.id });
    await first.watched.untilMatch(() => lastQueue(first.events)?.held !== undefined);
    await first.stop();
    // Resumed just before the node stopped, before its next turn started.
    const key = `queue/${first.thread.id}`;
    const kept = (await first.storage.storage.kv.get("jhin.threads", key)) as {
      messages: unknown[];
      held: { turnId: string };
    };
    await first.storage.storage.kv.set("jhin.threads", key, {
      messages: kept.messages,
      resumedPast: kept.held.turnId,
    } as never);

    const again = await node({ storage: first.storage, data: first.data });
    const watched = watch(again.client, first.thread.id);
    await untilCount(watched, ThreadEvents.turnCompleted, 1);
    expect(started(watched.events)).toEqual(["/hold on", "after"]);
  });
});

describe("jhin.threads: steering (D204, D205)", () => {
  it("steers a message into the running turn and records it before the answer", async () => {
    const { client, thread, events, until } = await holding();

    const steered = await client.call("threads.steer", {
      threadId: thread.id,
      text: "change course",
      messageId: "s-1",
    });
    expect(steered).toEqual({ messageId: "s-1", turnId: expect.any(String), outcome: "steered" });
    await until(ThreadEvents.turnCompleted);

    const types = events.map((event) => event.type);
    const steer = events.find((event) => event.type === ThreadEvents.turnSteered)!;
    expect(steer.payload).toEqual({
      turnId: (steered as { turnId: string }).turnId,
      messageId: "s-1",
      input: { text: "change course" },
    });
    expect(types.indexOf(ThreadEvents.turnSteered)).toBeLessThan(
      types.indexOf(ThreadEvents.itemCompleted),
    );
    expect(answers(events)).toEqual(["Echo: change course"]);
    expect(count(events, ThreadEvents.turnStarted)).toBe(1);
  });

  it("starts a turn with a steer on a free thread", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const watched = watch(client, thread.id);
    const { events, until } = watched;
    expect(await client.call("threads.steer", { threadId: thread.id, text: "hi" })).toMatchObject({
      outcome: "started",
      turnId: expect.any(String),
    });
    await until(ThreadEvents.turnCompleted);
    expect(answers(events)).toEqual(["Echo: hi"]);
  });

  it("starts a steer on a free thread at once, past a held queue", async () => {
    const { client, thread, events, until, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "held" });
    await client.call("threads.interrupt", { threadId: thread.id });
    await until(ThreadEvents.turnInterrupted);
    await watched.untilMatch(() => lastQueue(events)?.held !== undefined);

    expect(await client.call("threads.steer", { threadId: thread.id, text: "now" })).toMatchObject({
      outcome: "started",
    });
    await untilCount(watched, ThreadEvents.turnCompleted, 1);
    expect(started(events)).toEqual(["/hold on", "now"]);
    // The held message still waits for the user.
    expect(lastQueue(events)).toMatchObject({ messages: [{ text: "held" }], held: {} });
  });

  it("promotes a queued message to a steer", async () => {
    const { client, thread, events, until, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "a", messageId: "a" });
    await client.call("threads.queue.add", { threadId: thread.id, text: "b", messageId: "b" });

    await client.call("threads.queue.steer", { threadId: thread.id, messageId: "b" });
    expect(lastQueue(events)?.messages.map((message) => message.id)).toEqual(["a"]);
    await untilCount(watched, ThreadEvents.turnCompleted, 2);
    expect(started(events)).toEqual(["/hold on", "a"]);
    expect(events.find((event) => event.type === ThreadEvents.turnSteered)?.payload).toMatchObject({
      messageId: "b",
      input: { text: "b" },
    });

    // No turn runs now (the next one was stopped): nothing to steer into, and
    // the message stays where it is.
    await client.call("threads.queue.add", { threadId: thread.id, text: "/hold" });
    await watched.untilMatch(
      () =>
        events.filter((event) => (event.payload as { text?: string }).text === "Holding").length ===
        2,
    );
    await client.call("threads.queue.add", { threadId: thread.id, text: "c", messageId: "c" });
    await client.call("threads.interrupt", { threadId: thread.id });
    await until(ThreadEvents.turnInterrupted);
    await expect(
      client.call("threads.queue.steer", { threadId: thread.id, messageId: "c" }),
    ).rejects.toMatchObject({ code: "TURN_NOT_RUNNING" });
    await expect(
      client.call("threads.queue.steer", { threadId: thread.id, messageId: "gone" }),
    ).rejects.toMatchObject({ code: "QUEUED_MESSAGE_NOT_FOUND" });
    expect(lastQueue(events)?.messages.map((message) => message.id)).toEqual(["c"]);
  });

  it("promotes a queued message once when asked twice at once", async () => {
    const { client, thread, events, watched } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "a", messageId: "a" });
    const results = await Promise.allSettled([
      client.call("threads.queue.steer", { threadId: thread.id, messageId: "a" }),
      client.call("threads.queue.steer", { threadId: thread.id, messageId: "a" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await untilCount(watched, ThreadEvents.turnCompleted, 1);
    expect(count(events, ThreadEvents.turnSteered)).toBe(1);
    expect(started(events)).toEqual(["/hold on"]);
  });

  it("refuses to steer an agent that cannot, and lists which agents can", async () => {
    const plain: AgentRuntime = { agentId: "acme.plain", startTurn: fakeTurn };
    const { client } = await node({
      plugins: [
        {
          manifest: testManifest("acme.plain", {
            side: "server",
            requires: { "agent.registry": "^1" },
          }),
          definition: definePlugin({
            activate(context) {
              context.subscriptions.add(
                context.services.get<AgentRegistry>("agent.registry").register(plain),
              );
            },
          }),
        },
      ],
    });
    const agents = await client.call<{ agentId: string; steering: boolean }[]>("agents.list");
    expect(Object.fromEntries(agents.map((agent) => [agent.agentId, agent.steering]))).toEqual({
      "acme.plain": false,
      "jhin.agent-fake": true,
    });
    const thread = await client.call<Thread>("threads.create", { agentId: "acme.plain" });
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/hold" });
    await until(ThreadEvents.itemDelta);
    await expect(
      client.call("threads.steer", { threadId: thread.id, text: "no" }),
    ).rejects.toMatchObject({ code: "STEER_UNSUPPORTED" });
  });

  it("queues a steer first when the turn ends before the agent took it", async () => {
    const { client, thread, events, until } = await holding();
    await client.call("threads.queue.add", { threadId: thread.id, text: "queued" });
    // The turn is being stopped: it takes no steer.
    await client.call("threads.interrupt", { threadId: thread.id });
    const sent = await client.call("threads.steer", { threadId: thread.id, text: "too late" });
    expect(sent).toMatchObject({ outcome: "queued" });
    await until(ThreadEvents.turnInterrupted);
    const queue = await client.call<{ messages: { text: string }[] }>("threads.queue.list", {
      threadId: thread.id,
    });
    expect(queue.messages.map((message) => message.text)).toEqual(["too late", "queued"]);
    expect(count(events, ThreadEvents.turnSteered)).toBe(0);
  });
});
