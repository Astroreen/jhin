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

  it("disarms an archived thread, and arms it again when it comes back before the reset", async () => {
    const started = await limited();
    const { client, thread } = started;
    await armed(started);
    await client.call("threads.archive", { threadId: thread.id });
    // Archived, it holds no timer: nothing can be sent to it.
    expect(vi.getTimerCount()).toBe(0);
    // Back from the archive before the reset: its continuation waits for it again.
    await client.call("threads.unarchive", { threadId: thread.id });
    expect(vi.getTimerCount()).toBe(1);
    vi.clearAllTimers();
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

  it("turns the resume off when its send fails", async () => {
    const first = await limited();
    await first.client.call("threads.limit-recovery.set", {
      threadId: first.thread.id,
      turnId: first.turnId,
      resetAt: first.resetAt,
      autoResume: true,
    });
    await first.stop();
    // The node starts again without the thread's agent: the continuation cannot be sent.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const second = await node({ storage: first.storage, data: first.data, agent: false });
    await second.client.call("threads.list", {});
    expect(vi.getTimerCount()).toBe(1);
    const index = watch(second.client, "stream:threads");
    reset();
    const off = (
      await index.untilMatch((event) => {
        const payload = event.payload as unknown as Thread;
        return payload.id === first.thread.id && payload.limitRecovery?.autoResume === false;
      })
    ).payload as unknown as Thread;
    // The banner offers it again; the turn that hit the limit is still the latest.
    expect(off.limitRecovery).toMatchObject({ turnId: first.turnId, autoResume: false });
    expect(off.lastTurn).toMatchObject({ turnId: first.turnId, status: "failed" });
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

  it("arms only a recovery still of its thread's latest turn when the node starts", async () => {
    const first = await limited();
    const { client } = first;
    const arm = (threadId: string, turnId: string, resetAt: string) =>
      client.call("threads.limit-recovery.set", { threadId, turnId, resetAt, autoResume: true });
    await arm(first.thread.id, first.turnId, first.resetAt);
    // The thread went on: its recovery is an old one.
    await client.call("threads.send", { threadId: first.thread.id, text: "hello" });
    await first.record(
      (current) =>
        current.lastTurn?.turnId !== first.turnId && current.lastTurn?.status === "completed",
    );
    // Another thread's recovery is still its latest turn's: the one armed.
    const other = await client.call<Thread>("threads.create", {});
    const index = watch(client, "stream:threads");
    await client.call("threads.send", { threadId: other.id, text: "/limit" });
    const failed = (
      await index.untilMatch((event) => {
        const payload = event.payload as unknown as Thread;
        return payload.id === other.id && payload.lastTurn?.status === "failed";
      })
    ).payload as unknown as Thread;
    await arm(other.id, failed.lastTurn!.turnId, failed.lastTurn!.failure!.resetAt!);
    await first.stop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const second = await node({ storage: first.storage, data: first.data });
    await second.client.call("threads.list", {});
    // Exactly one: the arming ran, and left the old one out.
    expect(vi.getTimerCount()).toBe(1);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not send a continuation whose reset passed while the thread was archived", async () => {
    const started = await limited();
    const { client, thread, resetAt } = started;
    await armed(started);
    await client.call("threads.archive", { threadId: thread.id });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    // Later than the reset: unarchiving arms nothing.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse(resetAt) + 60_000);
    const back = await client.call<Thread>("threads.unarchive", { threadId: thread.id });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    // Nothing was sent.
    expect(back.lastTurn?.status).toBe("failed");
    // Its resume is off, so the banner offers it again instead of claiming one is armed.
    expect(back.limitRecovery).toMatchObject({ autoResume: false });
  });

  it("keeps a snooze of the user's that ends after the reset", async () => {
    const { client, thread, turnId, resetAt } = await limited();
    const later = new Date(Date.parse(resetAt) + 24 * 3_600_000).toISOString();
    await client.call("threads.snooze", { threadId: thread.id, until: later });
    const snoozed = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      snooze: true,
    });
    expect(snoozed.snoozedUntil).toBe(later);
    // The recovery's own snooze was not taken: the banner still offers it.
    expect(snoozed.limitRecovery?.snooze).toBe(false);
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
