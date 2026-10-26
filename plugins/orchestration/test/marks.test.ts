import { describe, expect, it } from "vite-plus/test";

import { node, orchestrationFeed, parentThread, watch, type TaskView } from "./support.ts";

interface ThreadSnapshot {
  tasks: { taskId: string; status: string }[];
  workflows: { workflowId: string; agents: { childThreadId?: string }[] }[];
  head: number;
}

describe("delegated work in the calling thread (D862, D863)", () => {
  it("marks a delegated task in the parent's stream and lists it without acknowledging", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const parentEvents = watch(client, parent.id);
    const task = await client.call<TaskView>("tasks.delegate", {
      task: "look around",
      parentThreadId: parent.id,
    });
    // The parent runs no turn: the mark names none, and the chat shows it in the latest turn (D407).
    const marked = await parentEvents.until("orchestration.task.delegated");
    expect(marked.payload).toEqual({
      taskId: task.taskId,
      childThreadId: task.childThreadId,
      title: "look around",
      agentId: "jhin.agent-fake",
    });
    expect(marked.payload).not.toHaveProperty("turnId");

    await feed.task(task.taskId, (record) => record.delivery === "delivered");
    const snapshot = await client.call<ThreadSnapshot>("orchestration.thread", {
      threadId: parent.id,
    });
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({ taskId: task.taskId, status: "completed", delivery: "delivered" }),
    ]);
    expect(snapshot.head).toBeGreaterThan(0);
    // Reading it acknowledged nothing: tasks_status still does.
    expect(
      await client.call<TaskView>("tasks.status", {
        taskId: task.taskId,
        parentThreadId: parent.id,
      }),
    ).toMatchObject({ delivery: "acknowledged" });
    await expect(client.call("orchestration.thread", {})).rejects.toMatchObject({
      code: "THREAD_REQUIRED",
    });
    await expect(
      client.call("orchestration.thread", { threadId: "no-such-thread" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("gives a fork its source's records made before it, so its rows are live (D1510)", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const parentEvents = watch(client, parent.id);
    const before = await client.call<TaskView>("tasks.delegate", {
      task: "look around",
      parentThreadId: parent.id,
    });
    await feed.task(before.taskId, (record) => record.delivery === "delivered");
    // The wake-up's turn ends, so there is a turn to fork at.
    await parentEvents.until("agent.turn.completed");
    const fork = await client.call<{ id: string }>("threads.fork", { threadId: parent.id });
    const after = await client.call<TaskView>("tasks.delegate", {
      task: "later",
      parentThreadId: parent.id,
    });

    const snapshot = await client.call<ThreadSnapshot & { inherited: string[] }>(
      "orchestration.thread",
      { threadId: fork.id },
    );
    expect(snapshot.inherited).toEqual([parent.id]);
    expect(snapshot.tasks.map((task) => task.taskId)).toEqual([before.taskId]);
    expect(snapshot.tasks.map((task) => task.taskId)).not.toContain(after.taskId);
    const own = await client.call<ThreadSnapshot & { inherited: string[] }>(
      "orchestration.thread",
      { threadId: parent.id },
    );
    expect(own.inherited).toEqual([]);
  });

  it("marks a workflow with its script, and its agents' threads in its record", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const parentEvents = watch(client, parent.id);
    const script = `export const meta = { name: 'one', description: 'One agent', phases: [{ title: 'Look' }] }
phase('Look')
return await agent('look', { label: 'looker' })`;
    const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
      script,
      parentThreadId: parent.id,
    });
    expect((await parentEvents.until("orchestration.workflow.started")).payload).toEqual({
      workflowId,
      name: "one",
      description: "One agent",
      phases: [{ title: "Look" }],
      script,
    });
    const done = await feed.workflow(workflowId, (record) => record.status === "completed");
    const [member] = done.agents as { childThreadId?: string; label?: string }[];
    expect(member).toMatchObject({ label: "looker", childThreadId: expect.any(String) });
    // A workflow's agents are not marked one by one.
    expect(
      parentEvents.events.filter((event) => event.type === "orchestration.task.delegated"),
    ).toEqual([]);
  });

  it("marks a launched thread in the caller's stream", async () => {
    const { client } = await node();
    const caller = await parentThread(client);
    const callerEvents = watch(client, caller.id);
    const launched = await client.call<{ threadId: string }>("orchestration.launch", {
      title: "Side quest",
      callerThreadId: caller.id,
    });
    expect((await callerEvents.until("orchestration.thread.launched")).payload).toEqual({
      threadId: launched.threadId,
      title: "Side quest",
    });
  });
});
