import { describe, expect, it, vi } from "vite-plus/test";

import { childTitle } from "../src/index.ts";
import { node as threadsNode } from "../../threads/test/support.ts";
import {
  node,
  orchestrationFeed,
  parentThread,
  scriptedRuntime,
  watch,
  type TaskView,
} from "./support.ts";

const FAKE = { "jhin.threads": { defaultAgent: "jhin.agent-fake" } };

describe("delegated tasks", () => {
  it("runs a child thread, publishes its result and wakes the parent", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const parentEvents = watch(client, parent.id);
    const task = await client.call<TaskView>("tasks.delegate", {
      task: "look around",
      parentThreadId: parent.id,
    });
    expect(task).toMatchObject({
      parentThreadId: parent.id,
      title: "look around",
      agentId: "jhin.agent-fake",
      runtimeMode: "full-access",
      interactionMode: "default",
      waitTimedOut: false,
    });
    const child = await client.call<{ thread: Record<string, unknown> }>("threads.get", {
      threadId: task.childThreadId,
    });
    expect(child.thread).toMatchObject({
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      projectId: parent.projectId,
    });

    const delivered = await feed.task(task.taskId, (record) => record.delivery === "delivered");
    expect(delivered).toMatchObject({ status: "completed", summary: "Echo: look around" });
    const wake = await parentEvents.until("agent.turn.started");
    expect((wake.payload as { input: { text: string } }).input.text).toBe(
      `Delegated task ${task.taskId} reached a terminal state. Use tasks_status with taskId ${task.taskId} to read the result.`,
    );

    const status = await client.call<TaskView>("tasks.status", {
      taskId: task.taskId,
      parentThreadId: parent.id,
    });
    expect(status).toMatchObject({
      status: "completed",
      workState: "result_available",
      summary: "Echo: look around",
      delivery: "acknowledged",
      hasPendingChildRuns: false,
    });
    expect(await client.call<TaskView[]>("tasks.list", { parentThreadId: parent.id })).toHaveLength(
      1,
    );
  });

  it("waits for the result, or gives up on the wait without stopping the task", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const waited = await client.call<TaskView>("tasks.delegate", {
      task: "quick one",
      mode: "wait",
      role: "review",
      parentThreadId: parent.id,
    });
    expect(waited).toMatchObject({
      status: "completed",
      summary: "Echo: Act as the review sub-agent for this task.\n\nquick one",
      waitTimedOut: false,
      delivery: "none",
    });

    // The wait's timer is caught when armed and fired by hand: no real time passes.
    const WAIT = 123_456;
    const realSetTimeout = globalThis.setTimeout;
    const armed = new Promise<() => void>((resolve) => {
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
        if (ms === WAIT) {
          resolve(handler);
          return realSetTimeout(() => undefined, 0);
        }
        return realSetTimeout(handler, ms);
      }) as typeof globalThis.setTimeout);
    });
    const waiting = client.call<TaskView>("tasks.delegate", {
      task: "/hold on",
      mode: "wait",
      timeoutMs: WAIT,
      parentThreadId: parent.id,
    });
    (await armed)();
    vi.restoreAllMocks();
    const held = await waiting;
    expect(held).toMatchObject({ status: "running", waitTimedOut: true, summary: null });
    // The task goes on; cancelling it stops the child like a Stop.
    expect(
      await client.call("tasks.cancel", { taskId: held.taskId, parentThreadId: parent.id }),
    ).toEqual({ taskId: held.taskId, status: "cancel_requested" });
    const ended = await feed.task(held.taskId, (record) => record.endedAt !== undefined);
    expect(ended).toMatchObject({
      status: "cancelled",
      summary: "Child task ended with status cancelled.",
    });
    // A cancelled task never wakes the parent, and cancelling it again returns its status.
    expect(ended.delivery).toBe("none");
    expect(
      await client.call("tasks.cancel", { taskId: held.taskId, parentThreadId: parent.id }),
    ).toEqual({ taskId: held.taskId, status: "cancelled" });
  });

  it("reports a pending question to a waiting caller", async () => {
    const { client } = await node();
    const parent = await parentThread(client);
    const asked = await client.call<TaskView>("tasks.delegate", {
      task: "/ask",
      mode: "wait",
      parentThreadId: parent.id,
    });
    expect(asked).toMatchObject({
      status: "waiting",
      hasPendingQuestion: true,
      waitTimedOut: false,
    });
    await client.call("tasks.cancel", { taskId: asked.taskId, parentThreadId: parent.id });
  });

  it("wakes a busy parent only after its turn, and not at all once the result was read", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const parentEvents = watch(client, parent.id);
    await client.call("threads.send", { threadId: parent.id, text: "/hold" });
    await parentEvents.until("agent.item.delta");

    const read = await client.call<TaskView>("tasks.delegate", {
      task: "first",
      parentThreadId: parent.id,
    });
    const woken = await client.call<TaskView>("tasks.delegate", {
      task: "second",
      parentThreadId: parent.id,
    });
    await feed.task(read.taskId, (record) => record.delivery === "pending");
    await feed.task(woken.taskId, (record) => record.delivery === "pending");
    // Read first: its wake-up is acknowledged and leaves the message.
    expect(
      (
        await client.call<TaskView>("tasks.status", {
          taskId: read.taskId,
          parentThreadId: parent.id,
        })
      ).delivery,
    ).toBe("acknowledged");

    await client.call("threads.interrupt", { threadId: parent.id });
    const wake = await parentEvents.until("agent.turn.started", 1);
    expect((wake.payload as { input: { text: string } }).input.text).toBe(
      `Delegated task ${woken.taskId} reached a terminal state. Use tasks_status with taskId ${woken.taskId} to read the result.`,
    );
    await feed.task(woken.taskId, (record) => record.delivery === "delivered");
  });

  it("inherits the parent's agent, model and modes, and refuses broader modes", async () => {
    const { client } = await node({
      config: FAKE,
      plugins: [
        scriptedRuntime("narrow", () => "narrow answer", { runtimeModes: ["approval-required"] }),
        scriptedRuntime("signed-out", () => "", { available: false, message: "Not signed in." }),
      ],
    });
    const parent = await parentThread(client, {
      agentId: "jhin.agent-fake",
      model: "echo",
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });
    const inherited = await client.call<TaskView>("tasks.delegate", {
      task: "same",
      mode: "wait",
      parentThreadId: parent.id,
    });
    expect(inherited).toMatchObject({
      agentId: "jhin.agent-fake",
      model: "echo",
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });
    // Another agent: its own default model, and the inherited mode steps down to what it offers.
    const other = await client.call<TaskView>("tasks.delegate", {
      task: "other",
      mode: "wait",
      target: { agentId: "narrow" },
      parentThreadId: parent.id,
    });
    expect(other).toMatchObject({
      agentId: "narrow",
      model: null,
      runtimeMode: "approval-required",
      summary: "narrow answer",
    });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        runtimeMode: "full-access",
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_MODE_ESCALATION_DENIED",
      message: "Child runtime mode full-access is broader than parent mode auto-accept-edits.",
    });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        interactionMode: "default",
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "INTERACTION_MODE_ESCALATION_DENIED" });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        target: { agentId: "narrow" },
        runtimeMode: "auto-accept-edits",
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        target: { model: "nope" },
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        target: { agentId: "signed-out" },
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: "Agent signed-out cannot run a child task: Not signed in.",
    });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        target: { agentId: "ghost" },
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await expect(client.call("tasks.delegate", { task: "x" })).rejects.toMatchObject({
      code: "THREAD_REQUIRED",
    });
    await expect(
      client.call("tasks.delegate", { task: "x", parentThreadId: "nope" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        isolation: "worktree",
        parentThreadId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
  });

  it("returns the same task for a retried clientRequestId", async () => {
    const { client } = await node();
    const parent = await parentThread(client);
    const request = { task: "/hold once", clientRequestId: "round-1", parentThreadId: parent.id };
    const [first, again] = await Promise.all([
      client.call<TaskView>("tasks.delegate", request),
      client.call<TaskView>("tasks.delegate", request),
    ]);
    const later = await client.call<TaskView>("tasks.delegate", request);
    expect(again.taskId).toBe(first.taskId);
    expect(later.taskId).toBe(first.taskId);
    const other = await client.call<TaskView>("tasks.delegate", {
      ...request,
      clientRequestId: "round-2",
    });
    expect(other.taskId).not.toBe(first.taskId);
    for (const task of [first, other]) {
      await client.call("tasks.cancel", { taskId: task.taskId, parentThreadId: parent.id });
    }
  });

  it("cancels the tasks a child delegated, and keeps tasks to their parent", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const outer = await client.call<TaskView>("tasks.delegate", {
      task: "/hold outer",
      parentThreadId: parent.id,
    });
    const inner = await client.call<TaskView>("tasks.delegate", {
      task: "/hold inner",
      parentThreadId: outer.childThreadId,
    });
    expect(
      (
        await client.call<TaskView>("tasks.status", {
          taskId: outer.taskId,
          parentThreadId: parent.id,
        })
      ).status,
    ).toBe("running");
    await expect(
      client.call("tasks.status", { taskId: inner.taskId, parentThreadId: parent.id }),
    ).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
      message: `Delegated task ${inner.taskId} does not belong to thread ${parent.id}.`,
    });
    await client.call("tasks.cancel", { taskId: outer.taskId, parentThreadId: parent.id });
    expect(await feed.task(inner.taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "cancelled",
    });
    expect(await feed.task(outer.taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "cancelled",
    });
  });

  it("reconciles a task whose child turn ended while the node was down", async () => {
    const first = await node();
    const parent = await parentThread(first.client);
    const task = await first.client.call<TaskView>("tasks.delegate", {
      task: "/hold across",
      parentThreadId: parent.id,
    });
    await first.stop();
    const second = await node({ storage: first.storage, data: first.data });
    const feed = orchestrationFeed(second.client);
    expect(await feed.task(task.taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "interrupted",
      delivery: "pending",
    });
  });

  it("resolves a task from its child's stream after a restart, also when the child moved on", async () => {
    const first = await node();
    const parent = await parentThread(first.client);
    const task = await first.client.call<TaskView>("tasks.delegate", {
      task: "/hold across",
      parentThreadId: parent.id,
    });
    await first.stop();
    // The child takes another turn while orchestration is not running.
    const bare = await threadsNode({ storage: first.storage, data: first.data });
    const childEvents = watch(bare.client, task.childThreadId);
    await bare.client.call("threads.send", { threadId: task.childThreadId, text: "later" });
    await childEvents.until("agent.turn.completed");
    await bare.stop();
    const second = await node({ storage: first.storage, data: first.data });
    const feed = orchestrationFeed(second.client);
    expect(await feed.task(task.taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "interrupted",
      summary: "Child task ended with status interrupted.",
    });
  });

  it("fails a task the node recorded before its turn started", async () => {
    const first = await node();
    const parent = await parentThread(first.client);
    const child = await first.client.call<{ id: string }>("threads.create", {
      title: "Child",
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
    });
    await first.stop();
    const at = new Date(0).toISOString();
    await first.storage.storage.kv.set("jhin.orchestration", "task/never", {
      taskId: "never",
      parentThreadId: parent.id,
      childThreadId: child.id,
      title: "Child",
      agentId: "jhin.agent-fake",
      runtimeMode: "full-access",
      interactionMode: "default",
      status: "running",
      hasPendingQuestion: false,
      wake: "always",
      delivery: "none",
      createdAt: at,
      updatedAt: at,
    });
    const second = await node({ storage: first.storage, data: first.data });
    const feed = orchestrationFeed(second.client);
    expect(await feed.task("never", (record) => record.endedAt !== undefined)).toMatchObject({
      status: "failed",
      summary: "The node stopped before the child task started.",
    });
  });

  it("stops a deleted parent's tasks and workflows", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const task = await client.call<TaskView>("tasks.delegate", {
      task: "/hold",
      parentThreadId: parent.id,
    });
    const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
      script: "export const meta = { name: 'w', description: 'd' }\nreturn agent('/hold')",
      parentThreadId: parent.id,
    });
    await feed.workflow(workflowId, (record) =>
      (record.agents as { status: string }[]).some((agent) => agent.status === "running"),
    );
    await client.call("threads.delete", { threadId: parent.id });
    expect(await feed.task(task.taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "cancelled",
    });
    expect(await feed.workflow(workflowId, (record) => record.status !== "running")).toMatchObject({
      status: "stopped",
    });
  });

  it("keeps a child thread in its parent's project", async () => {
    const { client, data } = await node();
    const parent = await parentThread(client);
    const other = await client.call<{ id: string }>("projects.create", {
      name: "Other",
      path: data,
    });
    await expect(
      client.call("threads.create", { projectId: other.id, title: "x", parentThreadId: parent.id }),
    ).rejects.toMatchObject({ code: "PARENT_PROJECT_MISMATCH" });
    await expect(
      client.call("threads.create", { title: "x", parentThreadId: "nope" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("titles a child after its prompt", () => {
    expect(childTitle(undefined, "  fix   the bug  ", "P", 1)).toBe("fix the bug");
    expect(childTitle("   ", "", "Parent", 3)).toBe("Parent subagent 3");
    expect(childTitle("x".repeat(100), "", "P", 1)).toBe(`${"x".repeat(69)}...`);
  });
});

describe("capabilities and launches", () => {
  it("lists agents with their constraints and the caller's settings", async () => {
    const { client } = await node({
      config: FAKE,
      plugins: [
        scriptedRuntime("signed-out", () => "", { available: false, message: "Not signed in." }),
      ],
    });
    const parent = await parentThread(client, { runtimeMode: "approval-required" });
    const capabilities = await client.call<{
      parentThreadId: string;
      inheritedAgentId: string;
      inheritedModel: string;
      runtimeMode: string;
      agents: { agentId: string; canRunChildTask: boolean; constraints: string[] }[];
      features: Record<string, unknown>;
    }>("orchestration.capabilities", { threadId: parent.id });
    expect(capabilities).toMatchObject({
      parentThreadId: parent.id,
      inheritedAgentId: "jhin.agent-fake",
      inheritedModel: "echo",
      runtimeMode: "approval-required",
      features: { workflows: true, scheduledTasks: false, workspaceStrategies: ["root"] },
    });
    expect(
      capabilities.agents.map(({ agentId, canRunChildTask, constraints }) => ({
        agentId,
        canRunChildTask,
        constraints,
      })),
    ).toEqual([
      { agentId: "signed-out", canRunChildTask: false, constraints: ["Not signed in."] },
      { agentId: "jhin.agent-fake", canRunChildTask: true, constraints: [] },
    ]);
  });

  it("launches a top-level thread, with or without a first message", async () => {
    const { client } = await node();
    const caller = await parentThread(client, { runtimeMode: "auto-accept-edits" });
    const launched = await client.call<{
      threadId: string;
      turnId: string | null;
      status: string | null;
    }>("orchestration.launch", { title: "Side quest", message: "go", callerThreadId: caller.id });
    expect(launched.status).toBe("running");
    const events = watch(client, launched.threadId);
    expect((await events.until("agent.item.completed")).payload).toMatchObject({
      text: "Echo: go",
    });
    const thread = await client.call<{ thread: Record<string, unknown> }>("threads.get", {
      threadId: launched.threadId,
    });
    expect(thread.thread).toMatchObject({ title: "Side quest", runtimeMode: "auto-accept-edits" });
    expect(thread.thread.parentThreadId).toBeUndefined();

    const idle = await client.call<{
      turnId: string | null;
      status: string | null;
      projectId: string;
    }>("orchestration.launch", { title: "Idle", scratch: true });
    expect(idle).toMatchObject({ turnId: null, status: null, projectId: "scratch" });

    await expect(
      client.call("orchestration.launch", {
        title: "x",
        runtimeMode: "full-access",
        callerThreadId: caller.id,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MODE_ESCALATION_DENIED" });
    await expect(
      client.call("orchestration.launch", { title: "x", scratch: true, projectId: "scratch" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message:
        "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
    });
    await expect(client.call("orchestration.launch", { title: "x" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      client.call("orchestration.launch", {
        title: "x",
        callerThreadId: caller.id,
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
    await expect(
      client.call("orchestration.launch", { title: "x", projectId: "nope" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // A plain root is the default anyway.
    await client.call("orchestration.launch", {
      title: "Root",
      callerThreadId: caller.id,
      workspaceStrategy: { type: "root" },
    });
  });
});
