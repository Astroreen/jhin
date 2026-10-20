import type { AgentRuntime, TurnRequest } from "@jhin/agent-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin } from "@jhin/sdk";
import { testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { node, watch } from "./support.ts";

function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

interface Thread {
  id: string;
  updatedAt?: string;
  lastTurn?: { turnId: string; status: string; agentId: string; at: string };
}

/** A runtime that answers as the fake one does and keeps the history of every turn. */
function recordingRuntime() {
  const histories: TurnRequest["history"][] = [];
  const runtime: AgentRuntime = {
    agentId: "acme.recording",
    startTurn: (request) => {
      histories.push(request.history);
      return fakeTurn(request);
    },
  };
  return { runtime, histories };
}

/** Runs one turn to its end; resolves with its id. */
async function turn(client: RpcClient, threadId: string, text: string) {
  const { untilMatch } = watch(client, threadId);
  const { turnId } = await client.call<{ turnId: string }>("threads.send", { threadId, text });
  await untilMatch(
    (event) =>
      event.type.startsWith("agent.turn.") &&
      event.type !== "agent.turn.started" &&
      (event.payload as { turnId?: string }).turnId === turnId,
  );
  return turnId;
}

const turnIdsOf = (history: TurnRequest["history"]) => [
  ...new Set(history.map((event) => (event.payload as { turnId?: string } | null)?.turnId)),
];

describe("jhin.threads: rolling back turns (D220, D221)", () => {
  it("drops the turns after a turn, keeping the log, and agents no longer see them", async () => {
    const { runtime, histories } = recordingRuntime();
    const { client } = await node({ runtime });
    const index = watch(client, "stream:threads");
    const thread = await client.call<Thread>("threads.create", {});
    const first = await turn(client, thread.id, "one");
    const second = await turn(client, thread.id, "/fail two");
    const third = await turn(client, thread.id, "three");

    const result = await client.call<{ thread: Thread; turnIds: string[] }>("threads.rollback", {
      threadId: thread.id,
      turnId: first,
    });
    expect(result.turnIds).toEqual([second, third]);
    expect(result.thread.lastTurn).toMatchObject({
      turnId: first,
      status: "completed",
      agentId: "acme.recording",
    });
    // The index tells every client.
    await index.untilMatch(
      (event) =>
        event.type === "threads.thread.updated" &&
        (event.payload as unknown as Thread).lastTurn?.turnId === first,
    );

    // Appended, never rewritten: the dropped turns' events are still in the stream.
    const stream = watch(client, thread.id);
    const rolledBack = await stream.until("threads.thread.rolled-back");
    expect(rolledBack.payload).toEqual({ turnIds: [second, third], toTurnId: first });
    expect(stream.events.some((event) => turnIdsOf([event]).includes(third))).toBe(true);

    await turn(client, thread.id, "four");
    const history = histories.at(-1)!;
    expect(turnIdsOf(history)).toEqual([undefined, first]);
    expect(history.some((event) => event.type === "threads.thread.rolled-back")).toBe(false);
  });

  it("drops every turn without a turn id, and the record forgets its last turn", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const only = await turn(client, thread.id, "hello");

    const result = await client.call<{ thread: Thread; turnIds: string[] }>("threads.rollback", {
      threadId: thread.id,
    });
    expect(result.turnIds).toEqual([only]);
    expect(result.thread.lastTurn).toBeUndefined();
    const { thread: read } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(read.lastTurn).toBeUndefined();
  });

  it("drops nothing after the last turn, and appends nothing", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const only = await turn(client, thread.id, "hello");
    const { head } = await client.call<{ head: number }>("threads.get", { threadId: thread.id });

    expect(
      await client.call("threads.rollback", { threadId: thread.id, turnId: only }),
    ).toMatchObject({ turnIds: [] });
    expect(
      await client.call<{ head: number }>("threads.get", { threadId: thread.id }),
    ).toMatchObject({ head });
  });

  it("mends a record a failed rollback left naming a dropped turn, on the next rollback", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const index = watch(client, "stream:threads");
    const first = await turn(client, thread.id, "one");
    const second = await turn(client, thread.id, "two");
    // The record says the second turn completed before its write fails.
    await index.untilMatch((event) => {
      const last = (event.payload as unknown as Thread).lastTurn;
      return last?.turnId === second && last.status === "completed";
    });
    // The record is written with its index event (D207): that write fails once.
    const log = storage.storage.log;
    const append = log.append.bind(log);
    let fail = true;
    log.append = async (stream, batch, options) => {
      if (fail && options?.records?.some((record) => record.key === `thread/${thread.id}`)) {
        fail = false;
        throw new Error("disk full");
      }
      return append(stream, batch, options);
    };
    await expect(
      client.call("threads.rollback", { threadId: thread.id, turnId: first }),
    ).rejects.toThrow("disk full");
    // The event is written, the record still names the dropped turn.
    const { thread: stale } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(stale.lastTurn?.turnId).not.toBe(first);

    const again = await client.call<{ thread: Thread; turnIds: string[] }>("threads.rollback", {
      threadId: thread.id,
      turnId: first,
    });
    expect(again).toMatchObject({ turnIds: [], thread: { lastTurn: { turnId: first } } });
  });

  it("refuses a running turn, a turn the thread does not show and an archived thread", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const first = await turn(client, thread.id, "one");
    const second = await turn(client, thread.id, "two");
    await client.call("threads.rollback", { threadId: thread.id, turnId: first });

    await expect(
      client.call("threads.rollback", { threadId: thread.id, turnId: second }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    await expect(
      client.call("threads.rollback", { threadId: thread.id, turnId: "nope" }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });

    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await until("agent.item.delta", 2);
    await expect(
      client.call("threads.rollback", { threadId: thread.id, turnId: first }),
    ).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });

    await client.call("threads.archive", { threadId: thread.id });
    await expect(
      client.call("threads.rollback", { threadId: thread.id, turnId: first }),
    ).rejects.toMatchObject({ code: "THREAD_ARCHIVED" });
  });

  it("holds the thread while it rolls back: no turn starts, a deletion comes after it", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    await turn(client, thread.id, "one");
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const recording = latch();
    const recorded = latch();
    log.append = async (stream, batch, options) => {
      if (batch.some((event) => event.type === "threads.thread.rolled-back")) {
        recording.resolve();
        await recorded.promise;
      }
      return append(stream, batch, options);
    };

    const rolling = client.call("threads.rollback", { threadId: thread.id });
    await recording.promise;
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "two" }),
    ).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
    // Not a turn: nothing to interrupt, nothing reported running.
    expect(await client.call("threads.interrupt", { threadId: thread.id })).toEqual({
      interrupted: false,
    });
    expect(
      await client.call<{ running?: string }>("threads.get", { threadId: thread.id }),
    ).not.toHaveProperty("running");
    const deleting = client.call("threads.delete", { threadId: thread.id });
    recorded.resolve();
    await rolling;
    await deleting;

    const { events, until } = watch(client, thread.id);
    await until("threads.thread.deleted");
    expect(events.map((event) => event.type).slice(-2)).toEqual([
      "threads.thread.rolled-back",
      "threads.thread.deleted",
    ]);
  });

  it("queues a message sent while it rolls back, and delivers it once done (D202)", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    await turn(client, thread.id, "one");
    const log = storage.storage.log;
    const append = log.append.bind(log);
    const recording = latch();
    const recorded = latch();
    log.append = async (stream, batch, options) => {
      if (batch.some((event) => event.type === "threads.thread.rolled-back")) {
        recording.resolve();
        await recorded.promise;
      }
      return append(stream, batch, options);
    };
    const rolling = client.call("threads.rollback", { threadId: thread.id });
    await recording.promise;
    const queued = await client.call<{ messageId: string; turnId?: string }>("threads.queue.add", {
      threadId: thread.id,
      text: "after the rollback",
    });
    expect(queued.turnId).toBeUndefined();
    const { untilMatch } = watch(client, thread.id);
    recorded.resolve();
    await rolling;
    const started = await untilMatch(
      (event) =>
        event.type === "agent.turn.started" &&
        (event.payload as { input: { text: string } }).input.text === "after the rollback",
    );
    expect(started).toBeDefined();
  });

  it("runs through the threads.rollback hook, which may refuse it", async () => {
    const seen: unknown[] = [];
    const checkpoints = {
      manifest: testManifest("acme.checkpoints", { side: "server" }),
      definition: definePlugin({
        activate(context) {
          context.hooks.around(
            "threads.rollback",
            async (input: { turnIds: string[]; toTurnId?: string }, next) => {
              seen.push({ turnIds: input.turnIds, toTurnId: input.toTurnId });
              if (input.toTurnId === undefined) throw new Error("files could not be restored");
              return next(input);
            },
          );
        },
      }),
    };
    const { client } = await node({ plugins: [checkpoints] });
    const thread = await client.call<Thread>("threads.create", {});
    const first = await turn(client, thread.id, "one");
    const second = await turn(client, thread.id, "two");

    await expect(client.call("threads.rollback", { threadId: thread.id })).rejects.toThrow(
      "files could not be restored",
    );
    await client.call("threads.rollback", { threadId: thread.id, turnId: first });
    expect(seen).toEqual([
      { turnIds: [first, second], toTurnId: undefined },
      { turnIds: [second], toTurnId: first },
    ]);
    const { events, until } = watch(client, thread.id);
    await until("threads.thread.rolled-back");
    expect(events.filter((event) => event.type === "threads.thread.rolled-back")).toHaveLength(1);
    // The refused rollback held nothing: the thread takes a turn.
    await turn(client, thread.id, "three");
  });
});
