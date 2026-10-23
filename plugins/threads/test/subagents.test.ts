import type { AgentItem, AgentRuntime } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  title: string;
  parentThreadId?: string;
  relationshipToParent?: string;
  subagentOrigin?: string;
  lastTurn?: { status: string; progress?: string };
}

/** A runtime whose turn starts two subagents, works in one, ends it and leaves the other open. */
const runtime: AgentRuntime = {
  agentId: "acme.subagents",
  startTurn(request) {
    async function* items(): AsyncGenerator<AgentItem> {
      yield { kind: "subagent.started", subagentId: "s1", title: "Explore", prompt: "look around" };
      yield {
        kind: "subagent.item",
        subagentId: "s1",
        item: { kind: "message.completed", itemId: "s1:1", text: "found it" },
      };
      yield { kind: "subagent.ended", subagentId: "s1", status: "completed" };
      yield { kind: "subagent.started", subagentId: "s3", title: "Break", prompt: "fail" };
      yield { kind: "subagent.ended", subagentId: "s3", status: "failed", error: "boom" };
      yield { kind: "subagent.started", subagentId: "s2", title: "", prompt: "keep going" };
      yield { kind: "message.completed", itemId: `${request.turnId}:1`, text: "done" };
    }
    return { items: items(), interrupt() {} };
  },
};

describe("jhin.threads: subagents of a turn (D877)", () => {
  it("shows each subagent as a child thread with one turn of its own", async () => {
    const { client } = await node({ runtime });
    const parent = await client.call<Thread>("threads.create", {});
    const parentEvents = watch(client, parent.id);
    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: parent.id,
      text: "go",
    });
    await parentEvents.until("agent.turn.completed");

    const marks = parentEvents.events.filter((event) => event.type === "threads.subagent.started");
    expect(marks.map((event) => event.payload)).toEqual([
      { turnId, subagentId: "s1", childThreadId: expect.any(String), title: "Explore" },
      { turnId, subagentId: "s3", childThreadId: expect.any(String), title: "Break" },
      { turnId, subagentId: "s2", childThreadId: expect.any(String), title: "Subagent" },
    ]);
    // The turn's own items stay its own.
    expect(
      parentEvents.events
        .filter((event) => event.type === "agent.item.completed")
        .map((event) => event.payload),
    ).toEqual([expect.objectContaining({ text: "done" })]);

    const [first, broken, second] = marks.map(
      (event) => (event.payload as { childThreadId: string }).childThreadId,
    );
    const child = await client.call<{ thread: Thread; events?: unknown }>("threads.get", {
      threadId: first,
    });
    expect(child.thread).toMatchObject({
      title: "Explore",
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      subagentOrigin: "provider",
      lastTurn: { status: "completed" },
    });
    const childEvents = watch(client, first!);
    await childEvents.until("agent.turn.completed");
    expect(childEvents.events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "agent.turn.started",
      "agent.item.completed",
      "agent.turn.completed",
    ]);
    expect((childEvents.events[1]!.payload as { input: { text: string } }).input.text).toBe(
      "look around",
    );

    // A failed one fails its turn with the error.
    const failed = await client.call<{ thread: Thread }>("threads.get", { threadId: broken });
    expect(failed.thread.lastTurn).toMatchObject({ status: "failed" });
    const failedEvents = watch(client, broken!);
    expect((await failedEvents.until("agent.turn.failed")).payload).toMatchObject({
      error: "boom",
    });

    // One still open when the turn ends stops with it.
    const open = await client.call<{ thread: Thread }>("threads.get", { threadId: second });
    expect(open.thread.lastTurn).toMatchObject({ status: "interrupted" });
  });
});

/** Two subagents in the background: one works after the turn until it is stopped, one never ends. */
function backgroundRuntime() {
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const asked: { threadId: string; subagentId: string }[] = [];
  const backgroundAgent: AgentRuntime = {
    agentId: "acme.background",
    async stopSubagent(request) {
      asked.push(request);
      if (request.subagentId !== "b1") return false;
      stop();
      return true;
    },
    startTurn(request) {
      async function* items(): AsyncGenerator<AgentItem> {
        yield { kind: "subagent.started", subagentId: "b1", title: "Dig", prompt: "dig" };
        yield { kind: "subagent.backgrounded", subagentId: "b1" };
        yield { kind: "subagent.started", subagentId: "b2", title: "Wait", prompt: "wait" };
        yield { kind: "subagent.backgrounded", subagentId: "b2" };
        yield { kind: "message.completed", itemId: `${request.turnId}:1`, text: "started" };
      }
      async function* afterwards(): AsyncGenerator<
        Extract<AgentItem, { kind: "subagent.item" | "subagent.progress" | "subagent.ended" }>
      > {
        // Cut to one line of 280 characters on the record (D1344).
        yield { kind: "subagent.progress", subagentId: "b1", progress: `  ${"x".repeat(300)}  ` };
        yield {
          kind: "subagent.item",
          subagentId: "b1",
          item: { kind: "message.completed", itemId: "b1:1", text: "dug" },
        };
        await stopped;
        yield { kind: "subagent.ended", subagentId: "b1", status: "interrupted" };
      }
      return { items: items(), afterwards: afterwards(), interrupt() {} };
    },
  };
  return { runtime: backgroundAgent, asked };
}

describe("jhin.threads: subagents in the background (D1164, D1166)", () => {
  it("keeps their threads running past the turn, and stops one through its runtime", async () => {
    const { runtime: background, asked } = backgroundRuntime();
    const { client } = await node({ runtime: background });
    const parent = await client.call<Thread>("threads.create", {});
    const parentEvents = watch(client, parent.id);
    await client.call("threads.send", { threadId: parent.id, text: "go" });
    await parentEvents.until("agent.turn.completed");
    const [dig, wait] = parentEvents.events
      .filter((event) => event.type === "threads.subagent.started")
      .map((event) => (event.payload as { childThreadId: string }).childThreadId);

    // Its work after the turn goes to its thread, which still runs.
    const digEvents = watch(client, dig!);
    expect((await digEvents.until("agent.item.completed")).payload).toMatchObject({ text: "dug" });
    const running = await client.call<{ thread: Thread }>("threads.get", { threadId: dig });
    // What it is doing now is on its running turn (D1344).
    expect(running.thread.lastTurn).toMatchObject({ status: "running", progress: "x".repeat(280) });

    // One its runtime no longer knows (it ended meanwhile), a thread that is no subagent.
    await expect(client.call("threads.subagent.stop", { threadId: wait })).rejects.toMatchObject({
      code: "SUBAGENT_NOT_RUNNING",
    });
    await expect(
      client.call("threads.subagent.stop", { threadId: parent.id }),
    ).rejects.toMatchObject({ code: "SUBAGENT_STOP_UNSUPPORTED" });

    expect(await client.call("threads.subagent.stop", { threadId: dig })).toEqual({
      stopped: true,
    });
    expect(asked).toContainEqual({ threadId: parent.id, subagentId: "b1" });
    await digEvents.until("agent.turn.interrupted");
    // The runtime followed them no further: the one still open ends with that.
    await watch(client, wait!).until("agent.turn.interrupted");
    // Its end (recorded before the other's) keeps its last progress on that turn.
    const ended = await client.call<{ thread: Thread }>("threads.get", { threadId: dig });
    expect(ended.thread.lastTurn).toMatchObject({
      status: "interrupted",
      progress: "x".repeat(280),
    });
    await expect(client.call("threads.subagent.stop", { threadId: dig })).rejects.toMatchObject({
      code: "SUBAGENT_NOT_RUNNING",
    });
  });
});
