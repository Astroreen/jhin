import type { AgentItem, AgentRegistry, AgentRuntime } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import type { EventLog, StoredEvent } from "@jhin/storage-api";
import { testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { STOP_TIMEOUT_MS } from "../src/index.ts";
import { node, onRecordWrite, watch } from "./support.ts";

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
    onRecordWrite(storage.storage, async (key, value) => {
      if (key === `thread/${thread.id}` && value === undefined) await removal.promise;
    });

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
    onRecordWrite(storage.storage, async (key, value) => {
      if (key === `thread/${thread.id}` && (value as { archivedAt?: unknown })?.archivedAt) {
        reached.resolve();
        await write.promise;
      }
    });

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

  it("keeps a thread being deleted closed, though an archive came meanwhile", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    // The thread's deleted event is written once the test says so.
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const deleting = latch();
    const write = latch();
    log.append = async (stream, batch, options) => {
      if (
        stream === `thread/${thread.id}` &&
        batch.some((event) => event.type === "threads.thread.deleted")
      ) {
        deleting.resolve();
        await write.promise;
      }
      return append(stream, batch, options);
    };

    const deletion = client.call("threads.delete", { threadId: thread.id });
    await deleting.promise;
    await expect(client.call("threads.archive", { threadId: thread.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "hi" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    write.resolve();
    expect(await deletion).toEqual({ deleted: true });
  });

  it("lets no change of a thread's record bring it back after its deletion", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    // The renamed record is written once the test says so.
    const renaming = latch();
    const write = latch();
    onRecordWrite(storage.storage, async (key, value) => {
      if (key === `thread/${thread.id}` && (value as { title?: string })?.title === "Renamed") {
        renaming.resolve();
        await write.promise;
      }
    });

    const renamed = client.call("threads.update", { threadId: thread.id, title: "Renamed" });
    await renaming.promise;
    const deletion = client.call("threads.delete", { threadId: thread.id });
    await until("threads.thread.deleted");
    write.resolve();

    await renamed;
    expect(await deletion).toEqual({ deleted: true });
    expect(await client.call("threads.list", {})).toEqual([]);
    await expect(client.call("threads.get", { threadId: thread.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
  });

  it("archives a thread once when it is archived twice at once", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});

    const [first, second] = await Promise.all([
      client.call<Thread>("threads.archive", { threadId: thread.id }),
      client.call<Thread>("threads.archive", { threadId: thread.id }),
    ]);
    expect(second).toEqual(first);
    const updates = (await storage.storage.log.read("threads")).filter(
      (event) =>
        event.type === "threads.thread.updated" &&
        (event.payload as { id?: string }).id === thread.id,
    );
    expect(updates).toHaveLength(1);
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

describe("jhin.threads: deletions that fail or overlap", () => {
  /** Makes storage fail the first append of a thread's deleted event (to `only` that stream). */
  function failFirstDeletedEvent(log: EventLog, only?: string) {
    const append = log.append.bind(log);
    let failed = false;
    log.append = (stream, batch, options) => {
      if (
        !failed &&
        (only === undefined || stream === only) &&
        batch.some((event) => event.type === "threads.thread.deleted")
      ) {
        failed = true;
        return Promise.reject(new Error("disk full"));
      }
      return append(stream, batch, options);
    };
  }
  const deletedEvents = async (log: EventLog, stream: string) =>
    (await log.read(stream)).filter((event) => event.type === "threads.thread.deleted").length;

  it("leaves a thread as it was when its deletion fails before it is recorded", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    failFirstDeletedEvent(storage.storage.log);

    await expect(client.call("threads.delete", { threadId: thread.id })).rejects.toThrow(
      "disk full",
    );
    // Still listed, and it takes messages.
    expect((await client.call<Thread[]>("threads.list", {})).map((item) => item.id)).toEqual([
      thread.id,
    ]);
    await client.call("threads.send", { threadId: thread.id, text: "still here" });
    await until("agent.turn.completed");
  });

  it("finishes a deletion that failed after it was recorded, with one deleted event", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    let failed = false;
    onRecordWrite(storage.storage, (key, value) => {
      if (!failed && key === `thread/${thread.id}` && value === undefined) {
        failed = true;
        throw new Error("disk full");
      }
    });

    await expect(client.call("threads.delete", { threadId: thread.id })).rejects.toThrow(
      "disk full",
    );
    // Its stream says deleted: it takes no more messages.
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "hi" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });

    expect(await client.call("threads.delete", { threadId: thread.id })).toEqual({ deleted: true });
    expect(await client.call<Thread[]>("threads.list", {})).toEqual([]);
    expect(await deletedEvents(storage.storage.log, `thread/${thread.id}`)).toBe(1);
    expect(await deletedEvents(storage.storage.log, "threads")).toBe(1);
  });

  it("finishes a deletion whose announcement failed, its record kept until then", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    failFirstDeletedEvent(storage.storage.log, "threads");

    await expect(client.call("threads.delete", { threadId: thread.id })).rejects.toThrow(
      "disk full",
    );
    // The record goes with its announcement (D208): still listed, closed to messages.
    expect((await client.call<Thread[]>("threads.list", {})).map((item) => item.id)).toEqual([
      thread.id,
    ]);
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "hi" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect(await client.call("threads.delete", { threadId: thread.id })).toEqual({ deleted: true });
    expect(await deletedEvents(storage.storage.log, `thread/${thread.id}`)).toBe(1);
    expect(await deletedEvents(storage.storage.log, "threads")).toBe(1);
  });

  it("deletes a thread once when it is deleted twice at once", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    // The deleted event is written once the test says so.
    const recording = latch();
    const write = latch();
    const log = storage.storage.log;
    const append = log.append.bind(log);
    log.append = async (stream, batch, options) => {
      if (stream === `thread/${thread.id}`) {
        recording.resolve();
        await write.promise;
      }
      return append(stream, batch, options);
    };

    const deleting = Promise.all([
      client.call("threads.delete", { threadId: thread.id }),
      client.call("threads.delete", { threadId: thread.id }),
    ]);
    await recording.promise;
    write.resolve();

    expect(await deleting).toEqual([{ deleted: true }, { deleted: true }]);
    expect(await deletedEvents(log, `thread/${thread.id}`)).toBe(1);
    expect(await deletedEvents(log, "threads")).toBe(1);
  });

  it("removes a project once when it is removed twice at once", async () => {
    const { client, storage, data } = await node();
    const project = await client.call<{ id: string }>("projects.create", { path: data });
    await client.call("threads.create", { projectId: project.id });

    const results = await Promise.all([
      client.call("projects.delete", { projectId: project.id }),
      client.call("projects.delete", { projectId: project.id }),
    ]);
    expect(results).toEqual([{ deletedThreads: 1 }, { deletedThreads: 1 }]);
    const index = await storage.storage.log.read("threads");
    expect(index.filter((event) => event.type === "threads.project.deleted")).toHaveLength(1);
  });

  it("deletes a thread whose creation was under way when its project's removal began", async () => {
    const { client, storage, data } = await node();
    const project = await client.call<{ id: string }>("projects.create", { path: data });
    // The new thread's record is stored once the test says so.
    const storing = latch();
    const store = latch();
    onRecordWrite(storage.storage, async (key) => {
      if (key.startsWith("thread/")) {
        storing.resolve();
        await store.promise;
      }
    });

    const creating = client.call<Thread>("threads.create", { projectId: project.id });
    await storing.promise;
    const removing = client.call("projects.delete", { projectId: project.id });
    // The removal has begun once a new thread in the project is refused.
    await expect(client.call("threads.create", { projectId: project.id })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    store.resolve();

    await creating;
    expect(await removing).toEqual({ deletedThreads: 1 });
    expect(await client.call("threads.list", {})).toEqual([]);
  });

  it("lets no rename bring a project back after its removal", async () => {
    const { client, storage, data } = await node();
    const project = await client.call<{ id: string }>("projects.create", { path: data });
    // The renamed project is written once the test says so.
    const renaming = latch();
    const write = latch();
    onRecordWrite(storage.storage, async (key, value) => {
      if (key === `project/${project.id}` && (value as { name?: string })?.name === "Renamed") {
        renaming.resolve();
        await write.promise;
      }
    });

    const renamed = client.call("projects.update", { projectId: project.id, name: "Renamed" });
    await renaming.promise;
    const removing = client.call("projects.delete", { projectId: project.id });
    // The removal has begun once a new thread in the project is refused.
    await expect(client.call("threads.create", { projectId: project.id })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    write.resolve();

    await renamed;
    expect(await removing).toEqual({ deletedThreads: 0 });
    expect((await client.call<{ id: string }[]>("projects.list")).map((item) => item.id)).toEqual([
      "scratch",
    ]);
  });

  it("creates threads again in a project whose removal failed", async () => {
    const { kernel, data, storage } = await node();
    const project = (await kernel.commands.execute("projects.create", { path: data })) as {
      id: string;
    };
    await kernel.commands.execute("threads.create", { projectId: project.id });
    failFirstDeletedEvent(storage.storage.log);

    await expect(
      kernel.commands.execute("projects.delete", { projectId: project.id }),
    ).rejects.toThrow("disk full");
    await kernel.commands.execute("threads.create", { projectId: project.id });
    expect((await kernel.commands.execute("threads.list", {})) as Thread[]).toHaveLength(2);
  });
});

describe("jhin.threads: answering requests", () => {
  it("refuses an answer of the wrong kind and keeps the request open", async () => {
    const { client, kernel } = await node();
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
    // A caller held to a runtime mode cannot approve (security.md D1370).
    await expect(
      kernel.commands.execute(
        "threads.respond",
        { threadId: thread.id, requestId, response: { kind: "approval", decision: "accept" } },
        { caller: { id: "client:agent", permissions: ["*", "threads.mode.approval-required"] } },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_ALLOWED" });
    // At every level, "Full access" included, as T3's MCP clients.
    await expect(
      kernel.commands.execute(
        "threads.respond",
        { threadId: thread.id, requestId, response: { kind: "approval", decision: "accept" } },
        {
          caller: {
            id: "client:agent",
            permissions: ["threads.write", "threads.mode.full-access"],
          },
        },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_ALLOWED" });
    await expect(
      kernel.commands.execute(
        "threads.respond",
        {
          threadId: thread.id,
          requestId,
          response: { kind: "approval", decision: "accept-always" },
        },
        { caller: { id: "client:agent", permissions: ["*", "threads.mode.approval-required"] } },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_ALLOWED" });
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

describe("jhin.threads: answers and what a turn waits for", () => {
  const approval = {
    kind: "approval" as const,
    tool: { name: "Bash", kind: "command" as const, title: "Run command", detail: "make" },
  };
  const question = {
    kind: "user-input" as const,
    questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
  };
  /** A runtime that opens `requests` in order, then ends once each one is answered. */
  function asking(...requests: (typeof approval | typeof question)[]) {
    const answers = new Map<string, () => void>();
    const runtime: AgentRuntime = {
      agentId: "acme.asking",
      startTurn: ({ turnId }) => ({
        items: (async function* (): AsyncGenerator<AgentItem> {
          const waits: Promise<void>[] = [];
          for (const [index, request] of requests.entries()) {
            const requestId = `${turnId}:${index}`;
            waits.push(new Promise<void>((done) => answers.set(requestId, done)));
            yield { kind: "request.opened", requestId, request };
          }
          await Promise.all(waits);
          yield { kind: "message.completed", itemId: `${turnId}:m`, text: "Done" };
        })(),
        interrupt: () => undefined,
        respond: (requestId) => answers.get(requestId)?.(),
      }),
    };
    return runtime;
  }

  it("records an answer after the request it answers, even when it comes first", async () => {
    const { client, storage } = await node({
      agent: false,
      plugins: [registering(asking(approval))],
    });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    // The request's opened event is written once the test says so. The test
    // learns when the answer waits for it, or is recorded before it.
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const recording = latch();
    const release = latch();
    const answerWaits = latch();
    const answeredFirst = latch();
    let held = false;
    log.append = (stream, batch, options) => {
      const types = new Set(batch.map((event) => event.type));
      if (types.has("agent.request.opened")) {
        held = true;
        recording.resolve();
        const done = release.promise.then(() => append(stream, batch, options));
        let waiting = 0;
        return {
          // oxlint-disable-next-line unicorn/no-thenable -- it stands for the append, counting who awaits it
          then(
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) {
            waiting += 1;
            if (waiting === 2) answerWaits.resolve();
            return done.then(onFulfilled, onRejected);
          },
        } as unknown as ReturnType<typeof append>;
      }
      if (held && types.has("agent.request.resolved")) answeredFirst.resolve();
      return append(stream, batch, options);
    };

    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "go",
    });
    await recording.promise;
    // The id is known before the request is recorded, e.g. from an agent that numbers them.
    const answering = client.call("threads.respond", {
      threadId: thread.id,
      requestId: `${turnId}:0`,
      response: { kind: "approval", decision: "accept" },
    });
    await Promise.race([answerWaits.promise, answeredFirst.promise]);
    release.resolve();

    expect(await answering).toEqual({ resolved: true });
    await until("agent.turn.completed");
    const recorded = (await log.read(`thread/${thread.id}`))
      .map((event) => event.type)
      .filter((type) => type.startsWith("agent.request."));
    expect(recorded).toEqual(["agent.request.opened", "agent.request.resolved"]);
  });

  it("says what the turn waits for while several requests are open", async () => {
    const { client } = await node({
      agent: false,
      plugins: [registering(asking(approval, question))],
    });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "go",
    });
    await until("agent.request.opened", 1);

    await client.call("threads.respond", {
      threadId: thread.id,
      requestId: `${turnId}:0`,
      response: { kind: "approval", decision: "accept" },
    });
    const { thread: waiting } = await client.call<{
      thread: Thread & { lastTurn?: { waitingFor?: string } };
    }>("threads.get", { threadId: thread.id });
    // The approval is answered: only the question is open.
    expect(waiting.lastTurn).toMatchObject({ status: "waiting", waitingFor: "user-input" });

    await client.call("threads.respond", {
      threadId: thread.id,
      requestId: `${turnId}:1`,
      response: { kind: "user-input", answers: { color: "Blue" } },
    });
    await until("agent.turn.completed");
  });
});

describe("jhin.threads: hooks that never answer", () => {
  it("holds no thread while its title hook never answers", async () => {
    const called = latch();
    const titles = {
      manifest: testManifest("acme.titles", { side: "server" }),
      definition: definePlugin({
        activate(context) {
          context.hooks.around("threads.title", () => {
            called.resolve();
            return new Promise(() => undefined);
          });
        },
      }),
    };
    const { client } = await node({ plugins: [titles] });
    const thread = await client.call<Thread>("threads.create", {});

    void client.call("threads.send", { threadId: thread.id, text: "hi" }).catch(() => undefined);
    await called.promise;
    // The message waits for its title, but the thread is not taken meanwhile.
    expect(await client.call<Thread>("threads.archive", { threadId: thread.id })).toMatchObject({
      archivedAt: expect.any(String),
    });
  });
});

describe("jhin.threads: agents that fail to take an answer", () => {
  it("records the answer once and takes no second one", async () => {
    const stopped = latch();
    const broken: AgentRuntime = {
      agentId: "acme.broken",
      startTurn: ({ turnId }) => ({
        items: (async function* (): AsyncGenerator<AgentItem> {
          yield {
            kind: "request.opened",
            requestId: `${turnId}:r`,
            request: {
              kind: "approval",
              tool: { name: "Bash", kind: "command", title: "Run command", detail: "make" },
            },
          };
          await stopped.promise;
        })(),
        interrupt: () => stopped.resolve(),
        respond: () => {
          throw new Error("broken pipe");
        },
      }),
    };
    const { client, storage } = await node({ agent: false, plugins: [registering(broken)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    const { requestId } = (await until("agent.request.opened")).payload as { requestId: string };
    const answer = {
      threadId: thread.id,
      requestId,
      response: { kind: "approval", decision: "accept" },
    };

    await expect(client.call("threads.respond", answer)).rejects.toMatchObject({
      code: "AGENT_FAILED",
    });
    await expect(client.call("threads.respond", answer)).rejects.toMatchObject({
      code: "REQUEST_NOT_FOUND",
    });
    await client.call("threads.interrupt", { threadId: thread.id });
    await until("agent.turn.interrupted");
    const resolved = (await storage.storage.log.read(`thread/${thread.id}`)).filter(
      (event) => event.type === "agent.request.resolved",
    );
    expect(resolved.map((event) => (event.payload as { response?: unknown }).response)).toEqual([
      { kind: "approval", decision: "accept" },
    ]);
  });
});

describe("jhin.threads: agents that ignore an interrupt", () => {
  /** A runtime that opens `request` (if given), then never ends, whatever it is told. */
  function stubbornRuntime(request?: Extract<AgentItem, { kind: "request.opened" }>["request"]) {
    const interrupted = latch();
    const runtime: AgentRuntime = {
      agentId: "acme.stubborn",
      startTurn: ({ turnId }) => ({
        items: (async function* (): AsyncGenerator<AgentItem> {
          if (request !== undefined)
            yield { kind: "request.opened", requestId: `${turnId}:r`, request };
          else yield { kind: "message.delta", itemId: `${turnId}:1`, text: "Working" };
          await new Promise(() => undefined);
        })(),
        interrupt: () => interrupted.resolve(),
      }),
    };
    return { runtime, interrupted };
  }

  it("stops waiting for an agent it gave up on, and closes the agent's items", async () => {
    const interrupted = latch();
    const closed = latch();
    let asked = 0;
    // Items that never come after the first: the agent neither ends nor answers.
    const silent: AgentRuntime = {
      agentId: "acme.silent",
      startTurn: ({ turnId }) => ({
        items: {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              asked += 1;
              return asked === 1
                ? Promise.resolve({
                    done: false as const,
                    value: {
                      kind: "message.delta" as const,
                      itemId: `${turnId}:1`,
                      text: "Working",
                    },
                  })
                : new Promise<IteratorResult<AgentItem>>(() => undefined);
            },
            return: () => {
              closed.resolve();
              return Promise.resolve({ done: true as const, value: undefined });
            },
          }),
        },
        interrupt: () => interrupted.resolve(),
      }),
    };
    const { kernel, client } = await node({ agent: false, plugins: [registering(silent)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until("agent.item.delta");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const archiving = kernel.commands.execute("threads.archive", { threadId: thread.id });
    await interrupted.promise;
    vi.advanceTimersByTime(STOP_TIMEOUT_MS);
    await archiving;
    // The loop let go of the agent: it closed the items it was waiting on.
    await closed.promise;
    expect(asked).toBe(2);
  });

  it("records a request opened before the stop that gave up on its agent closes it", async () => {
    const stubborn = stubbornRuntime({
      kind: "approval",
      tool: { name: "Bash", kind: "command", title: "Run command", detail: "make" },
    });
    const { kernel, client, storage } = await node({
      agent: false,
      plugins: [registering(stubborn.runtime)],
    });
    const thread = await client.call<Thread>("threads.create", {});
    // The request's opened event is recorded once the test says so. The test
    // learns when the turn's end waits for it, or closes the request first.
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const recording = latch();
    const release = latch();
    const endWaits = latch();
    const closedFirst = latch();
    let held = false;
    log.append = (stream, batch, options) => {
      const types = new Set(batch.map((event) => event.type));
      if (types.has("agent.request.opened")) {
        held = true;
        recording.resolve();
        const done = release.promise.then(() => append(stream, batch, options));
        let waiting = 0;
        return {
          // oxlint-disable-next-line unicorn/no-thenable -- it stands for the append, counting who awaits it
          then(
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) {
            waiting += 1;
            if (waiting === 2) endWaits.resolve();
            return done.then(onFulfilled, onRejected);
          },
        } as unknown as ReturnType<typeof append>;
      }
      if (held && types.has("agent.request.resolved")) closedFirst.resolve();
      return append(stream, batch, options);
    };

    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await recording.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const archiving = kernel.commands.execute("threads.archive", { threadId: thread.id });
    await stubborn.interrupted.promise;
    vi.advanceTimersByTime(STOP_TIMEOUT_MS);
    await Promise.race([endWaits.promise, closedFirst.promise]);
    release.resolve();
    await archiving;

    const recorded = (await log.read(`thread/${thread.id}`))
      .map((event) => event.type)
      .filter((type) => type.startsWith("agent.request.") || type === "agent.turn.interrupted");
    expect(recorded).toEqual([
      "agent.request.opened",
      "agent.request.resolved",
      "agent.turn.interrupted",
    ]);
  });

  it("closes no request whose opened event could not be recorded", async () => {
    const stubborn = stubbornRuntime({
      kind: "approval",
      tool: { name: "Bash", kind: "command", title: "Run command", detail: "make" },
    });
    const { client, storage } = await node({
      agent: false,
      plugins: [registering(stubborn.runtime)],
    });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    const log = storage.storage.log;
    const append = log.append.bind(log);
    log.append = (stream, batch, options) =>
      batch.some((event) => event.type === "agent.request.opened")
        ? Promise.reject(new Error("disk full"))
        : append(stream, batch, options);

    await client.call("threads.send", { threadId: thread.id, text: "go" });
    expect((await until("agent.turn.failed")).payload).toMatchObject({ error: "Error: disk full" });
    const types = (await log.read(`thread/${thread.id}`)).map((event) => event.type);
    expect(types.filter((type) => type.startsWith("agent.request."))).toEqual([]);
  });

  it("gives up on an agent that starts after the stop's deadline", async () => {
    const stubborn = stubbornRuntime();
    const { kernel, client, storage } = await node({
      agent: false,
      plugins: [registering(stubborn.runtime)],
    });
    const thread = await client.call<Thread>("threads.create", {});
    // The turn's start is recorded once the test says so.
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const starting = latch();
    const start = latch();
    log.append = async (stream, batch, options) => {
      if (batch.some((event) => event.type === "agent.turn.started")) {
        starting.resolve();
        await start.promise;
      }
      return append(stream, batch, options);
    };

    const sending = client.call("threads.send", { threadId: thread.id, text: "go" });
    await starting.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const archiving = kernel.commands.execute("threads.archive", { threadId: thread.id });
    // The stop's deadline passes while the turn is still starting.
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    start.resolve();
    await sending;

    expect(await archiving).toMatchObject({
      archivedAt: expect.any(String),
      lastTurn: { status: "interrupted" },
    });
    expect((await log.read(`thread/${thread.id}`)).at(-1)).toMatchObject({
      type: "agent.turn.interrupted",
      payload: { reason: "The agent did not stop when interrupted" },
    });
  });

  it("archives the thread anyway, recording the turn as interrupted", async () => {
    const stubborn = stubbornRuntime();
    const { kernel, client } = await node({
      agent: false,
      plugins: [registering(stubborn.runtime)],
    });
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until("agent.item.delta");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const archiving = kernel.commands.execute("threads.archive", { threadId: thread.id });
    // The interrupt and the stop's deadline are set in the same step.
    await stubborn.interrupted.promise;
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
