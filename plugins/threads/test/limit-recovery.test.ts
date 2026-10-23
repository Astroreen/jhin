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
  it("sends T3's continuation at the reset once asked to", async () => {
    const { client, thread, record, turnId, resetAt } = await limited();
    const stream = watch(client, thread.id);
    // Nothing is armed without the node's settings.
    expect(
      (await client.call<{ thread: Thread }>("threads.get", { threadId: thread.id })).thread,
    ).not.toHaveProperty("limitRecovery");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const armed = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      autoResume: true,
    });
    expect(armed.limitRecovery).toEqual({ turnId, resetAt, autoResume: true, snooze: false });
    // The reset comes: the continuation is the only timer armed meanwhile.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();

    const second = await stream.until("agent.turn.started", 1);
    expect(second.payload).toMatchObject({ input: { text: "Continue where you left off." } });
    const resumed = await record(
      (current) => current.lastTurn?.turnId !== turnId && current.lastTurn?.status === "completed",
    );
    expect(resumed.limitRecovery).toBeUndefined();
  });

  it("does not send it once the user cancelled it", async () => {
    const { client, thread, turnId, resetAt } = await limited();
    const stream = watch(client, thread.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await client.call("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      autoResume: true,
    });
    const cancelled = await client.call<Thread>("threads.limit-recovery.set", {
      threadId: thread.id,
      turnId,
      resetAt,
      autoResume: false,
    });
    expect(cancelled.limitRecovery?.autoResume).toBe(false);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    // A message of the user's is the next turn: the cancelled continuation never came first.
    await client.call("threads.send", { threadId: thread.id, text: "hello" });
    const next = await stream.until("agent.turn.started", 1);
    expect(next.payload).toMatchObject({ input: { text: "hello" } });
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

  it("refuses a turn that is not the latest limited one", async () => {
    const { client, thread, resetAt } = await limited();
    await expect(
      client.call("threads.limit-recovery.set", {
        threadId: thread.id,
        turnId: "another",
        resetAt,
        autoResume: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_LIMITED" });
  });

  it("arms both by the node's settings when a turn hits a limit (T3's settings)", async () => {
    const { record, turnId, resetAt } = await limited({
      autoResumeLimitedThreads: true,
      snoozeLimitedThreads: true,
    });
    const armed = await record((current) => current.limitRecovery !== undefined);
    expect(armed.limitRecovery).toEqual({ turnId, resetAt, autoResume: true, snooze: true });
    expect(armed.snoozedUntil).toBe(resetAt);
  });
});
