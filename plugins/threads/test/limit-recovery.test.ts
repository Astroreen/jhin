import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  snoozedUntil?: string;
  lastTurn?: {
    turnId: string;
    status: string;
    failure?: { class: string; resetAt?: string };
  };
  limitRecovery?: { turnId: string; resetAt: string; autoResume: boolean; snooze: boolean };
}

afterEach(() => {
  vi.useRealTimers();
});

/** A thread whose turn failed on the fake agent's usage limit, which resets in two hours. */
async function limited(config?: Record<string, unknown>) {
  const started = await node(config === undefined ? {} : { config: { "jhin.threads": config } });
  const { client } = started;
  const thread = await client.call<Thread>("threads.create", {});
  const index = watch(client, "stream:threads");
  const record = async (test: (thread: Thread) => boolean) =>
    (
      await index.untilMatch((event) => {
        const payload = event.payload as unknown as Thread;
        return payload.id === thread.id && test(payload);
      })
    ).payload as unknown as Thread;
  await client.call("threads.send", { threadId: thread.id, text: "/limit" });
  const failed = await record((current) => current.lastTurn?.status === "failed");
  const turnId = failed.lastTurn!.turnId;
  const resetAt = failed.lastTurn!.failure!.resetAt!;
  return { ...started, thread, record, turnId, resetAt };
}

describe("jhin.threads: resuming a thread a usage limit stopped (D1312, D1313)", () => {
  /** Arms the continuation under fake timers: it is the only timer the node holds then. */
  async function armed(started: Awaited<ReturnType<typeof limited>>) {
    const { client, thread, turnId, resetAt } = started;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(vi.getTimerCount()).toBe(0);
    const record = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      autoResume: true,
    });
    expect(vi.getTimerCount()).toBe(1);
    return record;
  }
  /** The reset comes, then the node runs on real timers again. */
  const reset = () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  };

  it("sends T3's continuation at the reset once asked to", async () => {
    const started = await limited();
    const { client, thread, record, turnId, resetAt } = started;
    const stream = watch(client, thread.id);
    // Nothing is armed without the node's settings.
    expect(
      (await client.call<{ thread: Thread }>("threads.get", { threadId: thread.id })).thread,
    ).not.toHaveProperty("limitRecovery");
    expect((await armed(started)).limitRecovery).toEqual({
      turnId,
      resetAt,
      autoResume: true,
      snooze: false,
    });
    reset();
    const second = await stream.until("agent.turn.started", 1);
    expect(second.payload).toMatchObject({ input: { text: "Continue where you left off." } });
    const resumed = await record(
      (current) => current.lastTurn?.turnId !== turnId && current.lastTurn?.status === "completed",
    );
    expect(resumed.limitRecovery).toBeUndefined();
  });

  it("disarms a cancelled continuation", async () => {
    const started = await limited();
    const { client, thread, turnId, resetAt } = started;
    await armed(started);
    const cancelled = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      autoResume: false,
    });
    expect(cancelled.limitRecovery?.autoResume).toBe(false);
    // No timer is left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing to a thread archived before the reset, and arms it again when it comes back", async () => {
    const started = await limited();
    const { client, thread } = started;
    const stream = watch(client, thread.id);
    await armed(started);
    await client.call("threads.archive", { threadId: thread.id });
    reset();
    // The next turn is the user's: the continuation found the thread archived.
    await client.call("threads.unarchive", { threadId: thread.id });
    await client.call("threads.send", { threadId: thread.id, text: "hello" });
    const next = await stream.until("agent.turn.started", 1);
    expect(next.payload).toMatchObject({ input: { text: "hello" } });
  });

  it("arms the continuation again when the node starts", async () => {
    const first = await limited();
    await first.client.call("threads.limit-recovery.set", {
      threadId: first.thread.id,
      turnId: first.turnId,
      resetAt: first.resetAt,
      autoResume: true,
    });
    await first.stop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const second = await node({ storage: first.storage, data: first.data });
    // Armed from the stored record once the node listed its threads.
    await second.client.call("threads.list", {});
    expect(vi.getTimerCount()).toBe(1);
    const stream = watch(second.client, first.thread.id);
    reset();
    await stream.untilMatch(
      (event) =>
        event.type === "agent.turn.started" &&
        (event.payload as { input?: { text?: string } }).input?.text ===
          "Continue where you left off.",
    );
  });

  it("snoozes the thread until the reset, and wakes it when that is undone", async () => {
    const { client, thread, turnId, resetAt } = await limited();
    const snoozed = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      snooze: true,
    });
    expect(snoozed.snoozedUntil).toBe(resetAt);
    const woken = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      snooze: false,
    });
    expect(woken.snoozedUntil).toBeUndefined();
    expect(woken.limitRecovery).toEqual({ turnId, resetAt, autoResume: false, snooze: false });
  });

  it("refuses a turn that is not the latest limited one, or another reset", async () => {
    const { client, thread, turnId, resetAt } = await limited();
    await expect(
      client.call("threads.limit-recovery.set", {
        threadId: thread.id,
        turnId: "another",
        resetAt,
        autoResume: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_LIMITED" });
    await expect(
      client.call("threads.limit-recovery.set", {
        threadId: thread.id,
        turnId,
        resetAt: new Date(Date.parse(resetAt) + 60_000).toISOString(),
        autoResume: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_LIMITED" });
  });

  it("arms both by the node's settings when a turn hits a limit (T3's settings)", async () => {
    const { record, turnId, resetAt } = await limited({
      autoResumeLimitedThreads: true,
      snoozeLimitedThreads: true,
    });
    const armedRecord = await record((current) => current.limitRecovery !== undefined);
    expect(armedRecord.limitRecovery).toEqual({ turnId, resetAt, autoResume: true, snooze: true });
    expect(armedRecord.snoozedUntil).toBe(resetAt);
  });
});
