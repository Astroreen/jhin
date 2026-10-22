import type { AgentRuntime, TurnRequest } from "@jhin/agent-api";
import type { RpcClient } from "@jhin/rpc";
import type { AgentRegistry } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import { testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { buildSearchSnippet } from "../src/history.ts";
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
    const waiting = await client.call<{ messageId: string; turnId?: string }>("threads.queue.add", {
      threadId: thread.id,
      text: "after the rollback",
    });
    expect(waiting.turnId).toBeUndefined();
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

describe("jhin.threads: regenerating a turn (D224)", () => {
  it("drops the latest turn and runs its message again with its settings", async () => {
    const { runtime, histories } = recordingRuntime();
    const requests: TurnRequest[] = [];
    const tracked: AgentRuntime = {
      ...runtime,
      startTurn: (request) => {
        requests.push(request);
        return runtime.startTurn(request);
      },
    };
    const { client } = await node({ runtime: tracked });
    const thread = await client.call<Thread>("threads.create", {});
    const first = await turn(client, thread.id, "one");
    const image = {
      kind: "image",
      name: "dot.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
    };
    const { untilMatch } = watch(client, thread.id);
    const { turnId: second } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "/fail two",
      attachments: [image],
      runtimeMode: "approval-required",
    });
    await untilMatch((event) => event.type === "agent.turn.failed");

    const result = await client.call<{ turnId: string; turnIds: string[] }>("threads.regenerate", {
      threadId: thread.id,
    });
    expect(result.turnIds).toEqual([second]);
    expect(result.turnId).not.toBe(second);
    expect(requests.at(-1)).toMatchObject({
      turnId: result.turnId,
      input: { text: "/fail two", attachments: [image] },
      runtimeMode: "approval-required",
    });
    // The agent sees the kept turn only.
    expect(turnIdsOf(histories.at(-1)!)).toEqual([undefined, first]);
  });

  it("regenerates an earlier turn, dropping every later one", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const first = await turn(client, thread.id, "one");
    const second = await turn(client, thread.id, "two");
    const third = await turn(client, thread.id, "three");
    const { untilMatch } = watch(client, thread.id);

    const result = await client.call<{ turnId: string; turnIds: string[] }>("threads.regenerate", {
      threadId: thread.id,
      turnId: second,
    });
    expect(result.turnIds).toEqual([second, third]);
    const started = await untilMatch(
      (event) =>
        event.type === "agent.turn.started" &&
        (event.payload as { turnId: string }).turnId === result.turnId,
    );
    expect(started.payload).toMatchObject({ input: { text: "two" } });
    await expect(
      client.call("threads.regenerate", { threadId: thread.id, turnId: third }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    const rolledBack = await untilMatch((event) => event.type === "threads.thread.rolled-back");
    expect(rolledBack.payload).toEqual({ turnIds: [second, third], toTurnId: first });
  });

  it("regenerates the first turn, and keeps the record on the new turn", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const only = await turn(client, thread.id, "hello");
    const { untilMatch } = watch(client, thread.id);
    const result = await client.call<{ turnId: string; turnIds: string[] }>("threads.regenerate", {
      threadId: thread.id,
    });
    expect(result.turnIds).toEqual([only]);
    await untilMatch(
      (event) =>
        event.type === "agent.turn.completed" &&
        (event.payload as { turnId: string }).turnId === result.turnId,
    );
    const index = watch(client, "stream:threads");
    await index.untilMatch((event) => {
      const last = (event.payload as unknown as Thread).lastTurn;
      return last?.turnId === result.turnId && last.status === "completed";
    });
    const { thread: after } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(after.lastTurn).toMatchObject({ turnId: result.turnId, status: "completed" });
  });

  it("runs the turn on the thread's agent when its own agent is gone from the node", async () => {
    const gone: AgentRuntime = { agentId: "acme.gone", startTurn: fakeTurn };
    const first = await node({ plugins: [registering(gone)] });
    const thread = await first.client.call<Thread>("threads.create", { agentId: "acme.gone" });
    await turn(first.client, thread.id, "hello");
    await first.stop();
    const second = await node({ storage: first.storage, data: first.data });
    const { untilMatch } = watch(second.client, thread.id);
    const { turnId } = await second.client.call<{ turnId: string }>("threads.regenerate", {
      threadId: thread.id,
    });
    const started = await untilMatch(
      (event) =>
        event.type === "agent.turn.started" &&
        (event.payload as { turnId: string }).turnId === turnId,
    );
    expect(started.payload).toMatchObject({ agentId: "jhin.agent-fake", input: { text: "hello" } });
  });

  it("tells a turn's message and settings, and rolls back to before a turn", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const first = await turn(client, thread.id, "one");
    const second = await turn(client, thread.id, "two");
    expect(
      await client.call("threads.turn", { threadId: thread.id, turnId: second }),
    ).toMatchObject({
      turnId: second,
      agentId: "jhin.agent-fake",
      input: { text: "two" },
      previousTurnId: first,
    });
    expect(
      await client.call("threads.rollback", { threadId: thread.id, beforeTurnId: second }),
    ).toMatchObject({ turnIds: [second], thread: { lastTurn: { turnId: first } } });
    await expect(
      client.call("threads.turn", { threadId: thread.id, turnId: second }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    await expect(
      client.call("threads.rollback", { threadId: thread.id, beforeTurnId: second }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    await expect(
      client.call("threads.rollback", { threadId: thread.id, turnId: first, beforeTurnId: first }),
    ).rejects.toBeDefined();
  });

  it("refuses a thread without turns or with a turn running, dropping nothing", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    await expect(client.call("threads.regenerate", { threadId: thread.id })).rejects.toMatchObject({
      code: "TURN_NOT_FOUND",
    });
    await expect(client.call("threads.regenerate", { threadId: "nope" })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });

    const { until, events } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await until("agent.item.delta");
    await expect(client.call("threads.regenerate", { threadId: thread.id })).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
    });
    expect(events.some((event) => event.type === "threads.thread.rolled-back")).toBe(false);
  });
});

interface Fork extends Thread {
  title: string;
  projectId: string;
  agentId?: string;
  runtimeMode?: string;
  forkedFrom?: { threadId: string; turnId: string };
  pendingMergeBack?: { id: string; threadId: string; turnId: string; at: string };
}

describe("jhin.threads: forking a thread (D225)", () => {
  it("copies the turns up to a turn, with their times, into a new thread of the same project", async () => {
    const { runtime, histories } = recordingRuntime();
    const { client } = await node({ runtime });
    const parent = await client.call<Fork>("threads.create", { runtimeMode: "approval-required" });
    const first = await turn(client, parent.id, "one");
    const second = await turn(client, parent.id, "two");
    await turn(client, parent.id, "three");
    const index = watch(client, "stream:threads");

    const fork = await client.call<Fork>("threads.fork", { threadId: parent.id, turnId: second });
    expect(fork).toMatchObject({
      title: "one fork",
      projectId: parent.projectId,
      agentId: "acme.recording",
      runtimeMode: "approval-required",
      forkedFrom: { threadId: parent.id, turnId: second },
    });
    expect(fork.lastTurn).toBeUndefined();
    await index.untilMatch(
      (event) =>
        event.type === "threads.thread.created" &&
        (event.payload as unknown as Fork).id === fork.id,
    );

    const parentEvents = watch(client, parent.id);
    await parentEvents.until("agent.turn.completed", 2);
    const forkEvents = watch(client, fork.id);
    const marker = await forkEvents.until("threads.thread.forked");
    expect(marker.payload).toEqual({ threadId: parent.id, turnId: second });
    const copied = forkEvents.events.filter((event) => event.sequence < marker.sequence).slice(1);
    const original = parentEvents.events.filter((event) =>
      [first, second].includes((event.payload as { turnId?: string }).turnId ?? ""),
    );
    expect(copied.map((event) => [event.type, event.payload])).toEqual(
      original.map((event) => [
        event.type,
        { ...(event.payload as object), inheritedAt: event.at },
      ]),
    );

    // The fork's agent gets the copied turns as its history.
    await turn(client, fork.id, "four");
    expect(turnIdsOf(histories.at(-1)!).filter(Boolean)).toEqual([first, second]);
  });

  it("forks at the latest ended turn by default, and never at a running one", async () => {
    const { client } = await node();
    const parent = await client.call<Fork>("threads.create", {});
    await expect(client.call("threads.fork", { threadId: parent.id })).rejects.toMatchObject({
      code: "TURN_NOT_FOUND",
    });
    const first = await turn(client, parent.id, "one");
    const { until } = watch(client, parent.id);
    const { turnId: holding } = await client.call<{ turnId: string }>("threads.send", {
      threadId: parent.id,
      text: "/hold on",
    });
    await until("agent.item.delta", 1);

    expect(
      await client.call<Fork>("threads.fork", { threadId: parent.id, title: "Side quest" }),
    ).toMatchObject({ title: "Side quest", forkedFrom: { threadId: parent.id, turnId: first } });
    await expect(
      client.call("threads.fork", { threadId: parent.id, turnId: holding }),
    ).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
  });
});

describe("jhin.threads: merging a fork back (D226)", () => {
  it("gives the parent's next turn the fork's own turns, once, keeping the user's text", async () => {
    const { runtime } = recordingRuntime();
    const requests: TurnRequest[] = [];
    const tracked: AgentRuntime = {
      ...runtime,
      startTurn: (request) => {
        requests.push(request);
        return runtime.startTurn(request);
      },
    };
    const { client } = await node({ runtime: tracked });
    const parent = await client.call<Fork>("threads.create", {});
    await turn(client, parent.id, "plan the work");
    const fork = await client.call<Fork>("threads.fork", { threadId: parent.id });
    await expect(client.call("threads.merge-back", { threadId: fork.id })).rejects.toMatchObject({
      code: "TURN_NOT_FOUND",
    });
    await turn(client, fork.id, "try   the risky\nidea");
    const tried = await turn(client, fork.id, "it worked");

    const merged = await client.call<Fork>("threads.merge-back", { threadId: fork.id });
    expect(merged).toMatchObject({
      id: parent.id,
      pendingMergeBack: { threadId: fork.id, turnId: tried, at: expect.any(String) },
    });

    const { untilMatch } = watch(client, parent.id);
    const next = await turn(client, parent.id, "go on");
    const text = requests.at(-1)!.input.text;
    expect(text.split("\n")).toEqual([
      "Context handoff (merge_back / fork_delta_summary):",
      "Merge-back context from forked conversation.",
      `Source thread: plan the work fork (${fork.id})`,
      `Target thread: plan the work (${parent.id})`,
      "Covered fork turns: 2",
      "",
      "Fork delta:",
      "- User: try the risky idea",
      "- Assistant: Echo: try the risky idea",
      "- User: it worked",
      "- Assistant: Echo: it worked",
      "",
      "User message:",
      "go on",
    ]);
    // The thread records what the user typed, and where the rest came from.
    const started = await untilMatch(
      (event) =>
        event.type === "agent.turn.started" &&
        (event.payload as { turnId: string }).turnId === next,
    );
    expect(started.payload).toMatchObject({
      input: { text: "go on" },
      handoff: { kind: "merge-back", threadId: fork.id, turnId: tried },
    });
    const { thread: after } = await client.call<{ thread: Fork }>("threads.get", {
      threadId: parent.id,
    });
    expect(after.pendingMergeBack).toBeUndefined();
    await turn(client, parent.id, "and again");
    expect(requests.at(-1)!.input.text).toBe("and again");
  });

  /** A thread with a fork that ran one turn of its own, and a runtime keeping requests. */
  async function forked() {
    const requests: TurnRequest[] = [];
    const tracked: AgentRuntime = {
      agentId: "acme.tracked",
      startTurn: (request) => {
        requests.push(request);
        return fakeTurn(request);
      },
    };
    const started = await node({ runtime: tracked });
    const parent = await started.client.call<Fork>("threads.create", {});
    const planned = await turn(started.client, parent.id, "plan");
    const fork = await started.client.call<Fork>("threads.fork", { threadId: parent.id });
    const tried = await turn(started.client, fork.id, "try it");
    return { ...started, requests, parent, fork, planned, tried };
  }
  const pendingOf = async (client: RpcClient, threadId: string) =>
    (await client.call<{ thread: Fork }>("threads.get", { threadId })).thread.pendingMergeBack;

  it("replaces a merge not yet delivered with a newer one", async () => {
    const { client, parent, fork, requests } = await forked();
    const first = await client.call<Fork>("threads.merge-back", { threadId: fork.id });
    const latest = await turn(client, fork.id, "and more");
    const second = await client.call<Fork>("threads.merge-back", { threadId: fork.id });
    expect(second.pendingMergeBack?.id).not.toBe(first.pendingMergeBack?.id);
    expect(second.pendingMergeBack?.turnId).toBe(latest);
    await turn(client, parent.id, "go on");
    expect(requests.at(-1)!.input.text).toContain("Covered fork turns: 2");
  });

  it("drops the mark of a fork deleted since, and the message goes alone", async () => {
    const { client, parent, fork, requests } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    await client.call("threads.delete", { threadId: fork.id });
    await turn(client, parent.id, "go on");
    expect(requests.at(-1)!.input.text).toBe("go on");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
  });

  it("drops the mark of a merged turn rolled back in the fork since", async () => {
    const { client, parent, fork, requests } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    // The fork drops its own turn, and every copied one with it.
    await client.call("threads.rollback", { threadId: fork.id });
    await turn(client, parent.id, "go on");
    expect(requests.at(-1)!.input.text).toBe("go on");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
  });

  it("keeps the mark when the parent's turn cannot start, and gives it back on a rollback", async () => {
    const { client, storage, parent, fork, requests } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    let fail = true;
    log.append = async (stream, batch, options) => {
      if (fail && batch.some((event) => event.type === "agent.turn.started")) {
        fail = false;
        throw new Error("disk full");
      }
      return append(stream, batch, options);
    };
    await expect(
      client.call("threads.send", { threadId: parent.id, text: "go on" }),
    ).rejects.toThrow("disk full");
    expect(await pendingOf(client, parent.id)).toBeDefined();

    const delivered = await turn(client, parent.id, "go on");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
    // Edited away: the merge waits for the next message again.
    await client.call("threads.rollback", { threadId: parent.id, beforeTurnId: delivered });
    expect(await pendingOf(client, parent.id)).toMatchObject({ threadId: fork.id });
    await turn(client, parent.id, "once more");
    expect(requests.at(-1)!.input.text).toContain("Merge-back context from forked conversation.");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
  });

  it("gives no mark to a fork whose copied turn delivered a merge to its parent", async () => {
    const { client, parent, fork } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    await turn(client, parent.id, "go on");
    const second = await client.call<Fork>("threads.fork", { threadId: parent.id });
    // Dropping the copied turn that carried the parent's merge gives this fork nothing.
    await client.call("threads.rollback", { threadId: second.id });
    expect(await pendingOf(client, second.id)).toBeUndefined();
  });

  it("never delivers a merge twice when clearing its mark could not be written", async () => {
    const { client, storage, parent, fork, requests } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    const log = storage.storage.log;
    const append = log.append.bind(log);
    let fail = true;
    log.append = async (stream, batch, options) => {
      const clearing = options?.records?.some(
        (record) =>
          record.key === `thread/${parent.id}` &&
          "value" in record &&
          (record.value as { pendingMergeBack?: unknown }).pendingMergeBack === undefined,
      );
      if (fail && clearing) {
        fail = false;
        throw new Error("disk full");
      }
      return append(stream, batch, options);
    };
    await turn(client, parent.id, "go on");
    expect(requests.at(-1)!.input.text).toContain("Merge-back context from forked conversation.");
    expect(await pendingOf(client, parent.id)).toBeDefined();
    // The mark outlived its delivery: the next message goes alone and the mark goes.
    await turn(client, parent.id, "and then");
    expect(requests.at(-1)!.input.text).toBe("and then");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
  });

  it("refuses merging again what the parent already got, until the fork goes on", async () => {
    const { client, parent, fork, tried } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    await turn(client, parent.id, "go on");
    await expect(client.call("threads.merge-back", { threadId: fork.id })).rejects.toMatchObject({
      code: "NOTHING_TO_MERGE",
    });
    const more = await turn(client, fork.id, "and more");
    expect(await client.call<Fork>("threads.merge-back", { threadId: fork.id })).toMatchObject({
      pendingMergeBack: { turnId: more },
    });
    await turn(client, parent.id, "once more");
    // An earlier turn than the one the parent got is refused too.
    await expect(
      client.call("threads.merge-back", { threadId: fork.id, turnId: tried }),
    ).rejects.toMatchObject({ code: "NOTHING_TO_MERGE" });
    // The fork rolled back past what the parent got: its new turn merges again.
    await client.call("threads.rollback", { threadId: fork.id });
    const again = await turn(client, fork.id, "start over");
    expect(await client.call<Fork>("threads.merge-back", { threadId: fork.id })).toMatchObject({
      pendingMergeBack: { turnId: again },
    });
    // An archived parent that already got the turn is THREAD_ARCHIVED, not NOTHING_TO_MERGE.
    await turn(client, parent.id, "take it");
    await client.call("threads.archive", { threadId: parent.id });
    await expect(client.call("threads.merge-back", { threadId: fork.id })).rejects.toMatchObject({
      code: "THREAD_ARCHIVED",
    });
  });

  it("delivers no mark for a fork turn the parent already got (two merges raced)", async () => {
    const { client, storage, parent, fork, tried, requests } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    await turn(client, parent.id, "go on");
    // A second mark for the same turn, as a merge-back that passed its check just before.
    const { thread: record } = await client.call<{ thread: Fork }>("threads.get", {
      threadId: parent.id,
    });
    await storage.storage.kv.set("jhin.threads", `thread/${parent.id}`, {
      ...record,
      pendingMergeBack: {
        id: "raced",
        threadId: fork.id,
        turnId: tried,
        at: new Date().toISOString(),
      },
    } as never);
    await turn(client, parent.id, "and then");
    expect(requests.at(-1)!.input.text).toBe("and then");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
  });

  it("regenerates no turn whose start recorded no message", async () => {
    const { client, storage } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    await turn(client, thread.id, "one");
    // A start without its input, as an older or broken writer could leave it.
    await storage.storage.log.append(`thread/${thread.id}`, [
      { type: "agent.turn.started", payload: { turnId: "bare", agentId: "jhin.agent-fake" } },
      { type: "agent.turn.completed", payload: { turnId: "bare" } },
    ]);
    await expect(
      client.call("threads.regenerate", { threadId: thread.id, turnId: "bare" }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
  });

  it("merges again into a regenerated turn, leaving no mark", async () => {
    const { client, parent, fork, requests } = await forked();
    await client.call("threads.merge-back", { threadId: fork.id });
    await turn(client, parent.id, "go on");
    const { untilMatch } = watch(client, parent.id);
    const { turnId } = await client.call<{ turnId: string }>("threads.regenerate", {
      threadId: parent.id,
    });
    await untilMatch(
      (event) =>
        event.type === "agent.turn.completed" &&
        (event.payload as { turnId: string }).turnId === turnId,
    );
    expect(requests.at(-1)!.input.text).toContain("Merge-back context from forked conversation.");
    expect(await pendingOf(client, parent.id)).toBeUndefined();
  });

  it("counts copied turns as inherited after the fork point is rolled back, and refuses them", async () => {
    const { client, fork, planned } = await forked();
    const { untilMatch } = watch(client, fork.id);
    // Regenerating the fork's copied turn drops the fork point and its own turn.
    const { turnId } = await client.call<{ turnId: string }>("threads.regenerate", {
      threadId: fork.id,
      turnId: planned,
    });
    await untilMatch(
      (event) =>
        event.type === "agent.turn.completed" &&
        (event.payload as { turnId: string }).turnId === turnId,
    );
    const merged = await client.call<Fork>("threads.merge-back", { threadId: fork.id });
    expect(merged.pendingMergeBack?.turnId).toBe(turnId);
    await expect(
      client.call("threads.merge-back", { threadId: fork.id, turnId: planned }),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
  });

  it("forks a fork with the first parent's times and one marker", async () => {
    const { client, fork, planned } = await forked();
    const first = watch(client, fork.id);
    const copiedAt = (await first.until("agent.turn.started")).payload as { inheritedAt: string };
    const grandchild = await client.call<Fork>("threads.fork", { threadId: fork.id });
    const second = watch(client, grandchild.id);
    await second.until("threads.thread.forked");
    const started = second.events.filter((event) => event.type === "agent.turn.started");
    const copiedTurn = started.find(
      (event) => (event.payload as { turnId: string }).turnId === planned,
    );
    expect((copiedTurn?.payload as { inheritedAt?: string } | undefined)?.inheritedAt).toBe(
      copiedAt.inheritedAt,
    );
    expect(second.events.filter((event) => event.type === "threads.thread.forked")).toHaveLength(1);
  });

  it("refuses a thread that is not a fork, and a fork whose parent is gone", async () => {
    const { client } = await node();
    const parent = await client.call<Fork>("threads.create", {});
    await turn(client, parent.id, "one");
    await expect(client.call("threads.merge-back", { threadId: parent.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FORK",
    });
    const fork = await client.call<Fork>("threads.fork", { threadId: parent.id });
    await turn(client, fork.id, "two");
    await client.call("threads.archive", { threadId: parent.id });
    await expect(client.call("threads.merge-back", { threadId: fork.id })).rejects.toMatchObject({
      code: "THREAD_ARCHIVED",
    });
    await client.call("threads.delete", { threadId: parent.id });
    await expect(client.call("threads.merge-back", { threadId: fork.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
  });
});

interface SearchResult {
  matches: {
    threadId: string;
    projectId: string;
    source: "user" | "assistant";
    snippet: string;
    at: string;
    updatedAt: string;
  }[];
}

/** Matches of one source in D227's order: the thread changed last first, then by id. */
const byChange = (matches: SearchResult["matches"]) =>
  matches.every(
    (match, index) =>
      index === 0 ||
      matches[index - 1]!.updatedAt > match.updatedAt ||
      (matches[index - 1]!.updatedAt === match.updatedAt &&
        matches[index - 1]!.threadId < match.threadId),
  );

describe("jhin.threads: searching thread contents (D227)", () => {
  it("finds one match per thread, user matches first, then the latest changed thread", async () => {
    const { client } = await node();
    const older = await client.call<Fork>("threads.create", {});
    await turn(client, older.id, "about Lisbon trams");
    const answered = await client.call<Fork>("threads.create", {});
    await turn(client, answered.id, "/think something");
    const newer = await client.call<Fork>("threads.create", {});
    await turn(client, newer.id, "LISBON again");
    await turn(client, newer.id, "lisbon once more");
    await client.call<Fork>("threads.create", {});

    const { matches } = await client.call<SearchResult>("threads.search", { query: "lisbon" });
    expect(matches.map((match) => [match.threadId, match.source, match.snippet])).toEqual([
      // The newest user message of the thread changed last, then the older thread.
      [newer.id, "user", "lisbon once more"],
      [older.id, "user", "about Lisbon trams"],
    ]);
    // Answers match too, after every user match; "Echo: …" holds the user's word.
    const echoes = await client.call<SearchResult>("threads.search", { query: "echo: about" });
    expect(echoes.matches).toEqual([
      expect.objectContaining({ threadId: older.id, source: "assistant" }),
    ]);
    await expect(client.call("threads.search", { query: " a " })).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(
      (await client.call<SearchResult>("threads.search", { query: "lisbon", limit: 1 })).matches,
    ).toHaveLength(1);
  });

  it("leaves out archived threads, other projects and dropped turns, and sees new turns", async () => {
    const { client, data } = await node();
    const thread = await client.call<Fork>("threads.create", {});
    const first = await turn(client, thread.id, "keep this one");
    await turn(client, thread.id, "drop this one");
    const search = async (query: string, projectId?: string) =>
      (
        await client.call<SearchResult>("threads.search", {
          query,
          ...(projectId === undefined ? {} : { projectId }),
        })
      ).matches.map((match) => match.snippet);

    expect(await search("this one")).toEqual(["drop this one"]);
    await client.call("threads.rollback", { threadId: thread.id, turnId: first });
    expect(await search("this one")).toEqual(["keep this one"]);
    await turn(client, thread.id, "a new one");
    expect(await search("new one")).toEqual(["a new one"]);

    const project = await client.call<{ id: string }>("projects.create", { path: data });
    expect(await search("this one", project.id)).toEqual([]);
    await client.call("threads.archive", { threadId: thread.id });
    expect(await search("this one")).toEqual([]);
  });
});

describe("jhin.threads: the search's cache of texts (D227)", () => {
  const snippets = async (client: RpcClient, query: string) =>
    (await client.call<SearchResult>("threads.search", { query })).matches.map((match) => [
      match.threadId,
      match.snippet,
    ]);

  it("follows a rollback and a new turn that both came between two searches", async () => {
    const { client } = await node();
    const thread = await client.call<Fork>("threads.create", {});
    const first = await turn(client, thread.id, "alpha first");
    await turn(client, thread.id, "alpha second");
    expect(await snippets(client, "alpha")).toEqual([[thread.id, "alpha second"]]);

    await client.call("threads.rollback", { threadId: thread.id, turnId: first });
    await turn(client, thread.id, "alpha third");
    expect(await snippets(client, "alpha")).toEqual([[thread.id, "alpha third"]]);
    expect(await snippets(client, "second")).toEqual([]);
  });

  it("finds a fork's inherited messages at their time, and nothing of a deleted thread", async () => {
    const { client } = await node();
    const parent = await client.call<Fork>("threads.create", {});
    await turn(client, parent.id, "inherited words");
    expect(await snippets(client, "inherited")).toEqual([[parent.id, "inherited words"]]);
    const fork = await client.call<Fork>("threads.fork", { threadId: parent.id });
    const { matches } = await client.call<SearchResult>("threads.search", { query: "inherited" });
    const [forkMatch, parentMatch] = [fork.id, parent.id].map((id) =>
      matches.find((match) => match.threadId === id),
    );
    expect(forkMatch?.at).toBe(parentMatch?.at);

    // Deleted after its texts were read: none of them comes back.
    await client.call("threads.delete", { threadId: parent.id });
    expect(await snippets(client, "inherited")).toEqual([[fork.id, "inherited words"]]);
  });

  it("prefers a thread's newest user message over a newer answer, and orders users by updatedAt", async () => {
    const { client } = await node();
    const first = await client.call<Fork>("threads.create", {});
    await turn(client, first.id, "zebra once");
    // A later turn whose answer holds the word: the user message still wins.
    await turn(client, first.id, "/think zebra");
    const second = await client.call<Fork>("threads.create", {});
    await turn(client, second.id, "a zebra too");
    const { matches } = await client.call<SearchResult>("threads.search", { query: "zebra" });
    expect(matches.map((match) => match.source)).toEqual(["user", "user"]);
    expect(byChange(matches)).toBe(true);
    // Changed last now: the first thread is not behind the second any more.
    await client.call("threads.update", { threadId: first.id, title: "renamed" });
    const again = await client.call<SearchResult>("threads.search", { query: "zebra" });
    expect(byChange(again.matches)).toBe(true);
    const renamed = again.matches.find((match) => match.threadId === first.id)!;
    const other = again.matches.find((match) => match.threadId === second.id)!;
    expect(renamed.updatedAt >= other.updatedAt).toBe(true);
  });

  it("orders threads matched by answers only by their updatedAt, and returns it", async () => {
    const { client } = await node();
    const older = await client.call<Fork>("threads.create", {});
    await turn(client, older.id, "/think hi");
    const newer = await client.call<Fork>("threads.create", {});
    await turn(client, newer.id, "/think hi");
    const { matches } = await client.call<SearchResult>("threads.search", { query: "thought" });
    expect(matches.map((match) => match.source)).toEqual(["assistant", "assistant"]);
    expect(matches.map((match) => match.threadId).toSorted()).toEqual(
      [newer.id, older.id].toSorted(),
    );
    expect(byChange(matches)).toBe(true);
  });

  it("matches across line breaks and runs of spaces, as the snippet shows them", async () => {
    const { client } = await node();
    const thread = await client.call<Fork>("threads.create", {});
    await turn(client, thread.id, "foo\n\nbar   baz");
    expect(await snippets(client, "foo bar  baz")).toEqual([[thread.id, "foo bar baz"]]);
  });
});

describe("search snippets (T3's buildSearchSnippet)", () => {
  it("collapses whitespace and keeps short texts whole", () => {
    expect(buildSearchSnippet("  a\n\n b  ", "a")).toBe("a b");
  });

  it("cuts a long text to a window from 72 characters before the match", () => {
    const text = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
    const snippet = buildSearchSnippet(text, "NEEDLE");
    expect(snippet).toBe(`…${"x".repeat(71)} needle ${"y".repeat(236 - 72 - 7)}…`);
    expect(buildSearchSnippet(`needle ${"y".repeat(300)}`, "needle")).toMatch(/^needle y+…$/);
    expect(buildSearchSnippet(`${"x".repeat(300)} needle`, "needle")).toMatch(/^…x+ needle$/);
  });
});
