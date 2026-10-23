import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { ScheduledTask } from "@jhin/scheduler-api";
import { connectInMemory } from "@jhin/testing";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { fakeClock, heldThreads, node, prompts, type Node } from "./support.ts";

/** A local time: Friday 2026-10-23 is weekday 5. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const MINUTE = 60_000;

describe("jhin.scheduler: timers", () => {
  it("runs an interval task into a new thread each time, counting from the end of the last run", async () => {
    fakeClock(local(19, 10));
    const { client, task } = await node();
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Summarize the news\nin three lines",
      schedule: { type: "interval", everyMs: 5 * MINUTE },
    });
    expect(created).toMatchObject({
      title: "Summarize the news",
      enabled: true,
      projectId: "scratch",
      threadId: null,
      lastRunStatus: "never",
      runCount: 0,
      nextRunAt: local(19, 10, 5).toISOString(),
    });

    // Nothing runs before it is due.
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(
      (await client.call<ScheduledTask>("scheduler.tasks.get", { id: created.id })).runCount,
    ).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const first = await task((t) => t.id === created.id && t.runCount === 1);
    expect(first).toMatchObject({
      lastRunStatus: "succeeded",
      lastRunError: null,
      lastRunAt: local(19, 10, 5).toISOString(),
      nextRunAt: local(19, 10, 10).toISOString(),
    });
    const thread = first.lastRunThreadId!;
    expect(await prompts(client, thread)).toEqual(["Summarize the news\nin three lines"]);
    const { thread: record } = await client.call<{ thread: { title: string; projectId: string } }>(
      "threads.get",
      { threadId: thread },
    );
    expect(record).toMatchObject({ title: "Summarize the news", projectId: "scratch" });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const second = await task((t) => t.id === created.id && t.runCount === 2);
    expect(second.lastRunThreadId).not.toBe(thread);
    expect(await prompts(client, second.lastRunThreadId!)).toEqual([
      "Summarize the news\nin three lines",
    ]);
  });

  it("runs a fixed time on chosen weekdays in the node's time zone", async () => {
    fakeClock(local(23, 8, 59));
    const { client, task } = await node();
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      title: "Standup notes",
      prompt: "Write the standup notes",
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    expect(created.nextRunAt).toBe(local(23, 9).toISOString());

    await vi.advanceTimersByTimeAsync(MINUTE);
    const ran = await task((t) => t.id === created.id && t.runCount === 1);
    // Friday's run is done: next is Monday.
    expect(ran).toMatchObject({
      lastRunStatus: "succeeded",
      nextRunAt: local(26, 9).toISOString(),
    });
  });

  it("skips a fixed-time run missed by more than ten minutes, as when the machine slept", async () => {
    fakeClock(local(19, 8, 59));
    const { client, task } = await node();
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Morning digest",
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
    });
    // The clock jumps half an hour without the timer firing, then the timer catches up.
    vi.setSystemTime(local(19, 9, 30));
    await vi.advanceTimersByTimeAsync(MINUTE);
    const rescheduled = await task(
      (t) => t.id === created.id && t.nextRunAt === local(20, 9).toISOString(),
    );
    expect(rescheduled).toMatchObject({ runCount: 0, lastRunStatus: "never" });
  });

  it("keeps the pending run on edits of the title or prompt, restarts it on schedule changes", async () => {
    fakeClock(local(19, 10));
    const { client } = await node();
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Check the build",
      schedule: { type: "interval", everyMs: 10 * MINUTE },
    });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    const renamed = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      title: "Build check",
      prompt: "Check the build on main",
    });
    expect(renamed).toMatchObject({
      title: "Build check",
      prompt: "Check the build on main",
      nextRunAt: created.nextRunAt,
    });

    const paused = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      enabled: false,
    });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(
      (await client.call<ScheduledTask>("scheduler.tasks.get", { id: created.id })).runCount,
    ).toBe(0);

    const resumed = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      enabled: true,
      schedule: { type: "interval", everyMs: 2 * MINUTE },
    });
    expect(resumed.nextRunAt).toBe(local(19, 10, 25).toISOString());
  });

  it("lists, filters by project and deletes tasks; a retried create returns its task", async () => {
    fakeClock(local(19, 10));
    const { client, kernel, storage } = await node();
    const project = await client.call<{ id: string }>("projects.create", {
      path: process.cwd(),
    });
    const first = await client.call<ScheduledTask>("scheduler.tasks.create", {
      projectId: project.id,
      prompt: "One",
      schedule: { type: "interval", everyMs: MINUTE },
      clientRequestId: "request-1",
    });
    const retried = await client.call<ScheduledTask>("scheduler.tasks.create", {
      projectId: project.id,
      prompt: "One",
      schedule: { type: "interval", everyMs: MINUTE },
      clientRequestId: "request-1",
    });
    expect(retried.id).toBe(first.id);
    // Another caller's request id never finds this caller's task.
    const other = connectInMemory(kernel, {
      log: storage.log,
      caller: { id: "someone-else", permissions: ["*"] },
    }).client;
    const theirs = await other.call<ScheduledTask>("scheduler.tasks.create", {
      projectId: project.id,
      prompt: "One",
      schedule: { type: "interval", everyMs: MINUTE },
      clientRequestId: "request-1",
    });
    expect(theirs.id).not.toBe(first.id);
    await other.call("scheduler.tasks.delete", { id: theirs.id });
    other.close();
    // The list is in creation order.
    await vi.advanceTimersByTimeAsync(1);
    const second = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Two",
      schedule: { type: "interval", everyMs: MINUTE },
    });

    const all = await client.call<{ tasks: ScheduledTask[]; head: number }>(
      "scheduler.tasks.list",
      {},
    );
    expect(all.tasks.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(all.head).toBeGreaterThan(0);
    const mine = await client.call<{ tasks: ScheduledTask[] }>("scheduler.tasks.list", {
      projectId: project.id,
    });
    expect(mine.tasks.map((t) => t.id)).toEqual([first.id]);

    expect(await client.call("scheduler.tasks.delete", { id: first.id })).toEqual({
      id: first.id,
      deleted: true,
    });
    expect(await client.call("scheduler.tasks.delete", { id: first.id })).toEqual({
      id: first.id,
      deleted: false,
    });
    await expect(client.call("scheduler.tasks.get", { id: first.id })).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
    // A deleted task does not run.
    await vi.advanceTimersByTimeAsync(MINUTE);
    const { tasks } = await client.call<{ tasks: ScheduledTask[] }>("scheduler.tasks.list", {});
    expect(tasks.map((t) => [t.id, t.runCount])).toEqual([[second.id, 1]]);
  });
});

describe("jhin.scheduler: the scheduler stream", () => {
  it("takes scheduler.read to follow, like the commands that read tasks", async () => {
    fakeClock(local(19, 10));
    const { streams } = await node();
    expect(streams.guardOf("scheduler")).toEqual(["scheduler.read"]);
  });
});

describe("jhin.scheduler: runs into a thread", () => {
  it("queues into its thread's queue: the run is done once queued, the turn follows the running one", async () => {
    fakeClock(local(19, 10));
    const { client, until } = await node();
    const thread = await client.call<{ id: string; projectId: string }>("threads.create", {});
    // A turn waiting for an approval keeps the thread busy.
    await client.call("threads.send", { threadId: thread.id, text: "/approve ls" });
    const opened = await until(`thread/${thread.id}`, (e) => e.type === "agent.request.opened");
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Any news?",
      threadId: thread.id,
      schedule: { type: "interval", everyMs: 60 * MINUTE },
    });
    expect(created).toMatchObject({ threadId: thread.id, projectId: thread.projectId });

    const { task: done, threadId } = await client.call<{
      task: ScheduledTask;
      threadId: string | null;
    }>("scheduler.tasks.run", { id: created.id });
    expect(threadId).toBe(thread.id);
    expect(done).toMatchObject({ lastRunStatus: "succeeded", runCount: 1 });
    const { messages } = await client.call<{ messages: { text: string }[] }>("threads.queue.list", {
      threadId: thread.id,
    });
    expect(messages.map((m) => m.text)).toEqual(["Any news?"]);

    // The running turn ends; the queued run goes next.
    await client.call("threads.respond", {
      threadId: thread.id,
      requestId: (opened.payload as { requestId: string }).requestId,
      response: { kind: "approval", decision: "accept" },
    });
    await until(
      `thread/${thread.id}`,
      (e) =>
        e.type === "agent.turn.started" &&
        (e.payload as { input: { text: string } }).input.text === "Any news?",
    );
    expect(await prompts(client, thread.id)).toEqual(["/approve ls", "Any news?"]);
  });

  it("refuses a second run while one is still going out", async () => {
    fakeClock(local(19, 10));
    const held = heldThreads();
    const { client, task } = await node({ threads: held });
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Any news?",
      threadId: "thread-1",
      schedule: { type: "interval", everyMs: 60 * MINUTE },
    });
    const run = client.call("scheduler.tasks.run", { id: created.id });
    await task((t) => t.id === created.id && t.lastRunStatus === "running");
    await expect(client.call("scheduler.tasks.run", { id: created.id })).rejects.toMatchObject({
      code: "RUN_IN_PROGRESS",
    });
    held.release();
    await run;
    expect(held.queued.map((q) => q.text)).toEqual(["Any news?"]);
  });

  it("records a run that could not send as failed", async () => {
    fakeClock(local(19, 10));
    const { client } = await node();
    const thread = await client.call<{ id: string }>("threads.create", {});
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Any news?",
      threadId: thread.id,
      schedule: { type: "interval", everyMs: 60 * MINUTE },
    });
    await client.call("threads.archive", { threadId: thread.id });
    const { task, threadId } = await client.call<{ task: ScheduledTask; threadId: string | null }>(
      "scheduler.tasks.run",
      { id: created.id },
    );
    expect(threadId).toBeNull();
    expect(task).toMatchObject({ lastRunStatus: "failed", runCount: 1 });
    expect(task.lastRunError).toMatch(/archived/i);
  });

  it("deletes a thread's tasks with the thread", async () => {
    fakeClock(local(19, 10));
    const { client, until } = await node();
    const thread = await client.call<{ id: string }>("threads.create", {});
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Any news?",
      threadId: thread.id,
      schedule: { type: "interval", everyMs: MINUTE },
    });
    await client.call("threads.delete", { threadId: thread.id });
    await until(
      "scheduler",
      (event) =>
        event.type === "scheduler.task.deleted" &&
        (event.payload as { id: string }).id === created.id,
    );
    expect(await client.call("scheduler.tasks.list", {})).toMatchObject({ tasks: [] });
  });

  it("reports the new thread of a run whose first message failed", async () => {
    fakeClock(local(19, 10));
    const { client } = await node();
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Any news?",
      agentId: "no-such-agent",
      schedule: { type: "interval", everyMs: MINUTE },
    });
    const { task, threadId } = await client.call<{ task: ScheduledTask; threadId: string | null }>(
      "scheduler.tasks.run",
      { id: created.id },
    );
    expect(threadId).toBeNull();
    expect(task).toMatchObject({ lastRunStatus: "failed", runCount: 1 });
    expect(task.lastRunError).toMatch(/no-such-agent/);
    // The thread it made is not lost: the run points at it.
    const { thread } = await client.call<{ thread: { title: string } }>("threads.get", {
      threadId: task.lastRunThreadId!,
    });
    expect(thread.title).toBe("Any news?");
  });

  it("refuses a project that does not exist", async () => {
    fakeClock(local(19, 10));
    const { client } = await node();
    await expect(
      client.call("scheduler.tasks.create", {
        projectId: "no-such-project",
        prompt: "Any news?",
        schedule: { type: "interval", everyMs: MINUTE },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("refuses a project that is not the bound thread's", async () => {
    fakeClock(local(19, 10));
    const { client } = await node();
    const thread = await client.call<{ id: string }>("threads.create", {});
    const project = await client.call<{ id: string }>("projects.create", { path: process.cwd() });
    await expect(
      client.call("scheduler.tasks.create", {
        projectId: project.id,
        threadId: thread.id,
        prompt: "Any news?",
        schedule: { type: "interval", everyMs: MINUTE },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_MISMATCH" });
  });

  it("records runs a restart cut short as failed and schedules the next", async () => {
    fakeClock(local(19, 10));
    const held = heldThreads();
    const first = await node({ threads: held });
    const created = await first.client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Any news?",
      threadId: "thread-1",
      schedule: { type: "interval", everyMs: 10 * MINUTE },
    });
    void first.client.call("scheduler.tasks.run", { id: created.id }).catch(() => undefined);
    await first.task((t) => t.id === created.id && t.lastRunStatus === "running");
    // The node goes away mid-run: what it left behind still says running.
    const left = structuredClone(
      await first.storage.kv.get("jhin.scheduler", `task/${created.id}`),
    );
    held.release();
    await first.stop();
    await first.storage.kv.set("jhin.scheduler", `task/${created.id}`, left!);

    const next = heldThreads();
    next.release();
    const second = await node({ storage: first.storage, threads: next });
    const recovered = await second.task(
      (t) => t.id === created.id && t.lastRunError === "Run was interrupted by a node restart.",
    );
    expect(recovered).toMatchObject({
      lastRunStatus: "failed",
      runCount: 1,
      nextRunAt: local(19, 10, 10).toISOString(),
    });

    // A run asked for at once waits for the recovery and is never taken for a stale one.
    const { task: ran } = await second.client.call<{ task: ScheduledTask }>("scheduler.tasks.run", {
      id: created.id,
    });
    expect(ran).toMatchObject({ lastRunStatus: "succeeded", runCount: 2, lastRunError: null });
  });
});

describe("jhin.scheduler: a run's workspace (D983)", () => {
  it("starts each run's thread in the task's workspace, and keeps it on the task", async () => {
    const { client } = await node();
    const checkout = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-checkout-"));
    onTestFinished(() => Fs.rmSync(checkout, { recursive: true, force: true }));
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "Look here",
      schedule: { type: "interval", everyMs: 60 * MINUTE },
      workspaceStrategy: { type: "existing_worktree", worktreePath: checkout },
    });
    expect(created.workspaceStrategy).toEqual({
      type: "existing_worktree",
      worktreePath: checkout,
    });
    const { threadId } = await client.call<{ threadId: string | null }>("scheduler.tasks.run", {
      id: created.id,
    });
    const { thread } = await client.call<{ thread: { worktreePath?: string } }>("threads.get", {
      threadId,
    });
    expect(thread.worktreePath).toBe(checkout);

    const updated = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      workspaceStrategy: { type: "root" },
    });
    expect(updated.workspaceStrategy).toEqual({ type: "root" });

    // A model is chosen, then cleared back to the node's default (D984).
    const chosen = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      agentId: "jhin.agent-fake",
      model: "plain",
    });
    expect(chosen).toMatchObject({ agentId: "jhin.agent-fake", model: "plain" });
    // Another agent named alone leaves the old agent's model behind.
    const other = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      agentId: "jhin.agent-other",
    });
    expect(other.agentId).toBe("jhin.agent-other");
    expect(other.model).toBeUndefined();
    const cleared = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      agentId: null,
      model: null,
    });
    expect(cleared.agentId).toBeUndefined();
    expect(cleared.model).toBeUndefined();
  });
});

describe("jhin.scheduler: a task created from an agent's thread (D1177, D1178)", () => {
  /** Runs a scheduler command as the agent of `threadId` calls it over MCP. */
  const asThread = (kernel: Node["kernel"], threadId: string) => (name: string, input: unknown) =>
    kernel.commands.execute(name, input, { threadId }) as Promise<ScheduledTask>;

  it("binds to the calling thread in its project and takes its settings, as T3 does", async () => {
    const { kernel, client } = await node();
    const caller = await client.call<{ id: string; projectId: string }>("threads.create", {
      agentId: "jhin.agent-fake",
      model: "echo",
      modelOptions: [{ id: "effort", value: "high" }],
      runtimeMode: "auto-accept-edits",
    });
    const call = asThread(kernel, caller.id);
    const bound = await call("scheduler.tasks.create", {
      prompt: "Check in",
      schedule: { type: "interval", everyMs: 60 * MINUTE },
    });
    expect(bound).toMatchObject({
      projectId: caller.projectId,
      threadId: caller.id,
      workspaceStrategy: { type: "root" },
      agentId: "jhin.agent-fake",
      model: "echo",
      modelOptions: [{ id: "effort", value: "high" }],
      runtimeMode: "auto-accept-edits",
    });

    // threadId null asks for a fresh thread per run too.
    expect(
      await call("scheduler.tasks.create", {
        prompt: "Fresh",
        schedule: { type: "interval", everyMs: 60 * MINUTE },
        threadId: null,
      }),
    ).toMatchObject({ threadId: null, workspaceStrategy: { type: "worktree" } });
    // false: a fresh thread per run, in a new worktree of main, as T3 launches it.
    const fresh = await call("scheduler.tasks.create", {
      prompt: "Fresh each time",
      schedule: { type: "interval", everyMs: 60 * MINUTE },
      bindToCurrentThread: false,
    });
    expect(fresh).toMatchObject({
      threadId: null,
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    });

    // Moved into the thread and out again.
    expect(
      await call("scheduler.tasks.update", { id: fresh.id, bindToCurrentThread: true }),
    ).toMatchObject({ threadId: caller.id, workspaceStrategy: { type: "root" } });
    expect(
      await call("scheduler.tasks.update", { id: fresh.id, bindToCurrentThread: false }),
    ).toMatchObject({ threadId: null, workspaceStrategy: { type: "worktree" } });
  });

  it("refuses to bind without a calling thread, to another project, or with threadId too", async () => {
    const { kernel, client } = await node();
    const schedule = { type: "interval", everyMs: 60 * MINUTE };
    await expect(
      client.call("scheduler.tasks.create", { prompt: "x", schedule, bindToCurrentThread: true }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "bindToCurrentThread needs an agent running inside a Jhin thread.",
    });
    const caller = await client.call<{ id: string }>("threads.create", {});
    const folder = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-other-"));
    onTestFinished(() => Fs.rmSync(folder, { recursive: true, force: true }));
    const other = await client.call<{ id: string }>("projects.create", { path: folder });
    const call = asThread(kernel, caller.id);
    await expect(
      call("scheduler.tasks.create", {
        prompt: "x",
        schedule,
        projectId: other.id,
        bindToCurrentThread: true,
      }),
    ).rejects.toMatchObject({
      message: "bindToCurrentThread binds to this thread, which belongs to a different project.",
    });
    // Another project unbinds by default.
    expect(
      await call("scheduler.tasks.create", { prompt: "x", schedule, projectId: other.id }),
    ).toMatchObject({ projectId: other.id, threadId: null });
    await expect(
      call("scheduler.tasks.create", {
        prompt: "x",
        schedule,
        threadId: caller.id,
        bindToCurrentThread: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("starts a run's thread with the task's model options, and drops them with another model", async () => {
    const { client } = await node();
    const created = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "/options",
      schedule: { type: "interval", everyMs: 60 * MINUTE },
      agentId: "jhin.agent-fake",
      model: "echo",
      modelOptions: [{ id: "effort", value: "low" }],
    });
    const { threadId } = await client.call<{ threadId: string }>("scheduler.tasks.run", {
      id: created.id,
    });
    const { thread } = await client.call<{ thread: { modelOptions?: unknown } }>("threads.get", {
      threadId,
    });
    expect(thread.modelOptions).toEqual([{ id: "effort", value: "low" }]);
    const other = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      model: "plain",
    });
    expect(other.modelOptions).toBeUndefined();
    const set = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      modelOptions: [{ id: "fastMode", value: true }],
    });
    expect(set.modelOptions).toEqual([{ id: "fastMode", value: true }]);
    const cleared = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: created.id,
      modelOptions: null,
    });
    expect(cleared.modelOptions).toBeUndefined();
  });
});

describe("jhin.scheduler: the calling thread's ceiling on a task's modes (D1352)", () => {
  const asThread = (kernel: Node["kernel"], threadId: string) => (name: string, input: unknown) =>
    kernel.commands.execute(name, input, { threadId }) as Promise<ScheduledTask>;
  const schedule = { type: "interval", everyMs: 60 * MINUTE };

  it("refuses modes broader than the thread's, and tasks that run broader, as T3's limits", async () => {
    const { kernel, client } = await node();
    const caller = await client.call<{ id: string }>("threads.create", {
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    const call = asThread(kernel, caller.id);
    // What it leaves out comes from the thread, so it fits.
    const own = await call("scheduler.tasks.create", { prompt: "x", schedule });
    expect(own).toMatchObject({ runtimeMode: "approval-required", interactionMode: "plan" });
    await expect(
      call("scheduler.tasks.create", { prompt: "x", schedule, runtimeMode: "full-access" }),
    ).rejects.toMatchObject({
      code: "RUNTIME_MODE_ESCALATION_DENIED",
      message:
        "Scheduled task runtime mode full-access is broader than this thread's mode approval-required.",
    });
    await expect(
      call("scheduler.tasks.create", { prompt: "x", schedule, interactionMode: "default" }),
    ).rejects.toMatchObject({ code: "INTERACTION_MODE_ESCALATION_DENIED" });
    // Nor may an update widen its own task.
    await expect(
      call("scheduler.tasks.update", { id: own.id, runtimeMode: "auto-accept-edits" }),
    ).rejects.toMatchObject({ code: "RUNTIME_MODE_ESCALATION_DENIED" });

    // A task the user made broader (the settings page has no calling thread) is out of its reach.
    const broad = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "deploy",
      schedule: { type: "webhook" },
      runtimeMode: "full-access",
    });
    expect(broad.webhook?.path).toEqual(expect.any(String));
    for (const [name, input] of [
      ["scheduler.tasks.update", { id: broad.id, prompt: "rm -rf" }],
      ["scheduler.tasks.run", { id: broad.id }],
      ["scheduler.tasks.delete", { id: broad.id }],
      ["scheduler.webhooks.rotate", { id: broad.id }],
    ] as const) {
      await expect(call(name, input)).rejects.toMatchObject({
        code: "RUNTIME_MODE_ESCALATION_DENIED",
      });
    }
    // Its URL starts runs: the thread does not see it, the user still does.
    const seen = (await call("scheduler.tasks.get", { id: broad.id })) as ScheduledTask;
    expect(seen.webhook?.path).toBeNull();
    const listed = (await call("scheduler.tasks.list", {})) as unknown as {
      tasks: ScheduledTask[];
    };
    expect(listed.tasks.find((task) => task.id === broad.id)?.webhook?.path).toBeNull();
    expect(
      (await client.call<ScheduledTask>("scheduler.tasks.get", { id: broad.id })).webhook?.path,
    ).toEqual(broad.webhook?.path);
    // Its own task it may still change and delete.
    expect(await call("scheduler.tasks.update", { id: own.id, prompt: "y" })).toMatchObject({
      prompt: "y",
    });
    expect(await call("scheduler.tasks.delete", { id: own.id })).toMatchObject({ deleted: true });
  });

  it("counts the modes of the thread a task posts into", async () => {
    const { kernel, client } = await node();
    const narrow = await client.call<{ id: string }>("threads.create", {
      runtimeMode: "approval-required",
    });
    const wide = await client.call<{ id: string }>("threads.create", {
      runtimeMode: "full-access",
    });
    const task = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "x",
      schedule,
      threadId: wide.id,
      runtimeMode: "approval-required",
    });
    await expect(
      asThread(kernel, narrow.id)("scheduler.tasks.run", { id: task.id }),
    ).rejects.toMatchObject({ code: "RUNTIME_MODE_ESCALATION_DENIED" });
  });
});

describe("jhin.scheduler: moving a task between threads (D1177, D1178)", () => {
  const asThread = (kernel: Node["kernel"], threadId: string) => (name: string, input: unknown) =>
    kernel.commands.execute(name, input, { threadId }) as Promise<ScheduledTask>;
  const schedule = { type: "interval", everyMs: 60 * MINUTE };

  it("refuses to move a task into no thread, another project's thread, or with threadId too", async () => {
    const { kernel, client } = await node();
    const task = await client.call<ScheduledTask>("scheduler.tasks.create", {
      prompt: "x",
      schedule,
    });
    await expect(
      client.call("scheduler.tasks.update", { id: task.id, bindToCurrentThread: true }),
    ).rejects.toMatchObject({
      message: "bindToCurrentThread needs an agent running inside a Jhin thread.",
    });
    const folder = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-elsewhere-"));
    onTestFinished(() => Fs.rmSync(folder, { recursive: true, force: true }));
    const other = await client.call<{ id: string }>("projects.create", { path: folder });
    const elsewhere = await client.call<{ id: string }>("threads.create", { projectId: other.id });
    await expect(
      asThread(kernel, elsewhere.id)("scheduler.tasks.update", {
        id: task.id,
        bindToCurrentThread: true,
      }),
    ).rejects.toMatchObject({
      message: "bindToCurrentThread binds to this thread, which belongs to a different project.",
    });
    await expect(
      client.call("scheduler.tasks.update", {
        id: task.id,
        threadId: null,
        bindToCurrentThread: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // Unbinding needs no calling thread, as T3's; a workspace given wins over T3's default.
    expect(
      await client.call<ScheduledTask>("scheduler.tasks.update", {
        id: task.id,
        bindToCurrentThread: false,
        workspaceStrategy: { type: "root" },
      }),
    ).toMatchObject({ threadId: null, workspaceStrategy: { type: "root" } });
  });

  it("inherits the caller's options only for its own agent and model", async () => {
    const { kernel, client } = await node();
    const caller = await client.call<{ id: string }>("threads.create", {
      agentId: "jhin.agent-fake",
      model: "echo",
      modelOptions: [{ id: "effort", value: "high" }],
    });
    const call = asThread(kernel, caller.id);
    const otherModel = await call("scheduler.tasks.create", {
      prompt: "x",
      schedule,
      model: "plain",
      bindToCurrentThread: false,
      workspaceStrategy: { type: "root" },
    });
    expect(otherModel).toMatchObject({ agentId: "jhin.agent-fake", model: "plain" });
    expect(otherModel.modelOptions).toBeUndefined();
    expect(otherModel.workspaceStrategy).toEqual({ type: "root" });
    const otherAgent = await call("scheduler.tasks.create", {
      prompt: "x",
      schedule,
      agentId: "jhin.agent-other",
    });
    expect(otherAgent.agentId).toBe("jhin.agent-other");
    expect(otherAgent.model).toBeUndefined();
    expect(otherAgent.modelOptions).toBeUndefined();
    // Its own agent and model: the options come along; another agent named alone drops them.
    const same = await call("scheduler.tasks.create", { prompt: "x", schedule });
    expect(same.modelOptions).toEqual([{ id: "effort", value: "high" }]);
    const moved = await client.call<ScheduledTask>("scheduler.tasks.update", {
      id: same.id,
      agentId: "jhin.agent-other",
    });
    expect(moved.modelOptions).toBeUndefined();
  });
});
