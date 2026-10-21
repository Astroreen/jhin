import type { AgentItem, AgentRuntime } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  title: string;
  parentThreadId?: string;
  relationshipToParent?: string;
  subagentOrigin?: string;
  lastTurn?: { status: string };
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
      { turnId, subagentId: "s2", childThreadId: expect.any(String), title: "Subagent" },
    ]);
    // The turn's own items stay its own.
    expect(
      parentEvents.events
        .filter((event) => event.type === "agent.item.completed")
        .map((event) => event.payload),
    ).toEqual([expect.objectContaining({ text: "done" })]);

    const [first, second] = marks.map(
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

    // One still open when the turn ends stops with it.
    const open = await client.call<{ thread: Thread }>("threads.get", { threadId: second });
    expect(open.thread.lastTurn).toMatchObject({ status: "interrupted" });
  });
});
