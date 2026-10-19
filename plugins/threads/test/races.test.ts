import type { AgentItem, AgentRegistry, AgentRuntime } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { STOP_TIMEOUT_MS } from "../src/index.ts";
import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  archivedAt?: string;
  lastTurn?: { turnId: string; status: string };
}

/** A promise with its resolver: something a test or a fake waits for. */
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** A plugin that registers `runtime` through agent.registry@1. */
function registering(runtime: AgentRuntime) {
  return {
    manifest: testManifest(`acme.${runtime.agentId}`, {
      side: "server",
      requires: { "agent.registry": "^1" },
    }),
    definition: definePlugin({
      activate(context) {
        context.subscriptions.add(
          context.services.get<AgentRegistry>("agent.registry").register(runtime),
        );
      },
    }),
  };
}

/** A runtime whose `status()` answers only once `ready` resolves: a send waits on it. */
function slowToAnswer() {
  const ready = latch();
  const asked = latch();
  const runtime: AgentRuntime = {
    agentId: "acme.slow",
    status: async () => {
      asked.resolve();
      await ready.promise;
      return { available: true };
    },
    startTurn: fakeTurn,
  };
  return { runtime, ready, asked };
}

/** The texts of the agent's completed messages. */
const messages = (events: readonly StoredEvent[]) =>
  events
    .filter(
      (event) =>
        event.type === "agent.item.completed" &&
        (event.payload as { kind?: string }).kind === "message",
    )
    .map((event) => (event.payload as { text?: string }).text);

afterEach(() => {
  vi.useRealTimers();
});

describe("jhin.threads: concurrent changes", () => {
  it("starts one turn when a thread gets two messages at once", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);

    // A new thread has no agent yet: both sends look for the default one first.
    const results = await Promise.allSettled([
      client.call("threads.send", { threadId: thread.id, text: "/hold first" }),
      client.call("threads.send", { threadId: thread.id, text: "/hold second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "TURN_IN_PROGRESS" },
    });

    await until("agent.turn.started");
    await client.call("threads.interrupt", { threadId: thread.id });
    await until("agent.turn.interrupted");
    expect(events.filter((event) => event.type === "agent.turn.started")).toHaveLength(1);
  });

  it("starts no turn on a thread being deleted, even before its record is gone", async () => {
    const slow = slowToAnswer();
    const { client, storage } = await node({ agent: false, plugins: [registering(slow.runtime)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);
    // The record is removed only once the test says so: the deleted event comes first.
    const removal = latch();
    const kv = storage.storage.kv;
    const remove = kv.delete.bind(kv);
    kv.delete = async (namespace, key) => {
      if (key === `thread/${thread.id}`) await removal.promise;
      return remove(namespace, key);
    };

    const sending = client.call("threads.send", { threadId: thread.id, text: "hi" });
    await slow.asked.promise;
    const deleting = client.call("threads.delete", { threadId: thread.id });
    await until("threads.thread.deleted");
    // The send goes on between the deleted event and the record's removal.
    slow.ready.resolve();

    await expect(sending).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    removal.resolve();
    await deleting;
    expect(events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "threads.thread.deleted",
    ]);
  });

  it("starts no turn on a thread being archived, even before it is marked archived", async () => {
    const slow = slowToAnswer();
    const { client, storage } = await node({ agent: false, plugins: [registering(slow.runtime)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { events } = watch(client, thread.id);
    // The archived record is written only once the test says so.
    const reached = latch();
    const write = latch();
    const kv = storage.storage.kv;
    const set = kv.set.bind(kv);
    kv.set = async (namespace, key, value) => {
      if (key === `thread/${thread.id}` && (value as { archivedAt?: unknown }).archivedAt) {
        reached.resolve();
        await write.promise;
      }
      return set(namespace, key, value);
    };

    const sending = client.call("threads.send", { threadId: thread.id, text: "hi" });
    await slow.asked.promise;
    const archiving = client.call<Thread>("threads.archive", { threadId: thread.id });
    await reached.promise;
    // The send goes on while the archive is being recorded.
    slow.ready.resolve();

    await expect(sending).rejects.toMatchObject({ code: "THREAD_ARCHIVED" });
    write.resolve();
    expect((await archiving).archivedAt).toEqual(expect.any(String));
    // And afterwards it takes no message until it is unarchived.
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "again" }),
    ).rejects.toMatchObject({ code: "THREAD_ARCHIVED" });
    expect(events.map((event) => event.type)).toEqual(["threads.thread.created"]);
  });

  it("starts no turn on a thread archived while a message was on its way", async () => {
    const slow = slowToAnswer();
    const { client } = await node({ agent: false, plugins: [registering(slow.runtime)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { events } = watch(client, thread.id);

    const sending = client.call("threads.send", { threadId: thread.id, text: "hi" });
    await slow.asked.promise;
    await client.call("threads.archive", { threadId: thread.id });
    slow.ready.resolve();

    await expect(sending).rejects.toMatchObject({ code: "THREAD_ARCHIVED" });
    expect(events.map((event) => event.type)).toEqual(["threads.thread.created"]);
  });

  it("creates no thread in a project while it is removed", async () => {
    const { kernel, data } = await node();
    const project = (await kernel.commands.execute("projects.create", { path: data })) as {
      id: string;
    };
    const removing = kernel.commands.execute("projects.delete", { projectId: project.id });
    const creating = kernel.commands.execute("threads.create", { projectId: project.id });

    await expect(creating).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await removing).toEqual({ deletedThreads: 0 });
    expect(await kernel.commands.execute("threads.list", {})).toEqual([]);
  });

  it("stores a new thread before the index announces it", async () => {
    const { client, storage } = await node();
    const read: Promise<unknown>[] = [];
    // Storage tells its subscribers during the append: read the record right then.
    storage.storage.log.subscribe("threads", (event) => {
      if (event.type !== "threads.thread.created") return;
      const { id } = event.payload as { id: string };
      read.push(storage.storage.kv.get("jhin.threads", `thread/${id}`));
    });

    const thread = await client.call<Thread>("threads.create", {});
    expect(await Promise.all(read)).toEqual([expect.objectContaining({ id: thread.id })]);
  });
});

describe("jhin.threads: answering requests", () => {
  it("refuses an answer of the wrong kind and keeps the request open", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/approve rm -rf build" });
    const { requestId } = (await until("agent.request.opened")).payload as { requestId: string };

    await expect(
      client.call("threads.respond", {
        threadId: thread.id,
        requestId,
        response: { kind: "user-input", answers: { color: "Blue" } },
      }),
    ).rejects.toMatchObject({
      code: "RESPONSE_MISMATCH",
      details: { expected: "approval", received: "user-input" },
    });
    expect(
      await client.call("threads.respond", {
        threadId: thread.id,
        requestId,
        response: { kind: "approval", decision: "accept" },
      }),
    ).toEqual({ resolved: true });
    await until("agent.turn.completed");
    expect(messages(events)).toEqual(["Approved and ran rm -rf build"]);
  });

  it("keeps a request open when its answer cannot be recorded, so it can be sent again", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/approve make" });
    const { requestId } = (await until("agent.request.opened")).payload as { requestId: string };

    // The next record of an answer fails, as on a full disk.
    const log = storage.storage.log;
    const append = log.append.bind(log);
    let failures = 1;
    log.append = (stream, batch, options) => {
      if (failures > 0 && batch.some((event) => event.type === "agent.request.resolved")) {
        failures -= 1;
        return Promise.reject(new Error("disk full"));
      }
      return append(stream, batch, options);
    };
    const answer = {
      threadId: thread.id,
      requestId,
      response: { kind: "approval", decision: "accept" },
    };

    await expect(client.call("threads.respond", answer)).rejects.toThrow("disk full");
    expect(await client.call("threads.respond", answer)).toEqual({ resolved: true });
    await until("agent.turn.completed");
    expect(events.filter((event) => event.type === "agent.request.resolved")).toHaveLength(1);
    expect(messages(events)).toEqual(["Approved and ran make"]);
  });
  it("does not report an answer as delivered when its turn ended while it was recorded", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/approve make" });
    const { requestId } = (await until("agent.request.opened")).payload as { requestId: string };

    // The record of the answer is held until the turn's end waits for it too:
    // it is a thenable that counts who waits on it (the answer, then the end).
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const recording = latch();
    const endWaits = latch();
    const release = latch();
    log.append = (stream, batch, options) => {
      const answer = batch.some(
        (event) =>
          event.type === "agent.request.resolved" &&
          (event.payload as { response?: unknown }).response !== undefined,
      );
      if (!answer) return append(stream, batch, options);
      recording.resolve();
      const held = release.promise.then(() => append(stream, batch, options));
      let waiting = 0;
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- it stands for the append, counting who awaits it
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
          waiting += 1;
          if (waiting === 2) endWaits.resolve();
          return held.then(onFulfilled, onRejected);
        },
      } as unknown as ReturnType<typeof append>;
    };

    const answering = client.call("threads.respond", {
      threadId: thread.id,
      requestId,
      response: { kind: "approval", decision: "accept" },
    });
    await recording.promise;
    await client.call("threads.interrupt", { threadId: thread.id });
    await endWaits.promise;
    release.resolve();

    await expect(answering).rejects.toMatchObject({ code: "REQUEST_NOT_FOUND" });
    await until("agent.turn.interrupted");
    // Recorded as answered, then closed by the turn's end: the agent never got it.
    expect(
      events
        .filter((event) => event.type === "agent.request.resolved")
        .map((event) => (event.payload as { response?: unknown }).response),
    ).toEqual([{ kind: "approval", decision: "accept" }, undefined]);
    expect(messages(events)).toEqual([]);
  });
});

describe("jhin.threads: agents that ignore an interrupt", () => {
  it("archives the thread anyway, recording the turn as interrupted", async () => {
    const interrupted = latch();
    const stubborn: AgentRuntime = {
      agentId: "acme.stubborn",
      startTurn: ({ turnId }) => ({
        items: (async function* (): AsyncGenerator<AgentItem> {
          yield { kind: "message.delta", itemId: `${turnId}:1`, text: "Working" };
          // Never ends, whatever happens.
          await new Promise(() => undefined);
        })(),
        interrupt: () => interrupted.resolve(),
      }),
    };
    const { kernel, client } = await node({ agent: false, plugins: [registering(stubborn)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until("agent.item.delta");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const archiving = kernel.commands.execute("threads.archive", { threadId: thread.id });
    // The interrupt and the stop's deadline are set in the same step.
    await interrupted.promise;
    vi.advanceTimersByTime(STOP_TIMEOUT_MS);

    expect(await archiving).toMatchObject({
      archivedAt: expect.any(String),
      lastTurn: { status: "interrupted" },
    });
    expect((await until("agent.turn.interrupted")).payload).toMatchObject({
      reason: "The agent did not stop when interrupted",
    });
    // The thread is free again: nothing is left running on it.
    await client.call("threads.unarchive", { threadId: thread.id });
    expect(
      (await client.call<{ running?: string }>("threads.get", { threadId: thread.id })).running,
    ).toBeUndefined();
    expect(events.at(-1)?.type).toBe("agent.turn.interrupted");
  });
});
