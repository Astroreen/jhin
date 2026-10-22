import { describe, expect, it } from "vite-plus/test";

import { NodeRestarter, restartDelayMs } from "../src/node-restart.ts";

/** A scheduler the test runs by hand: it records each delay and its pending run. */
function manualSchedule() {
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  return {
    delays,
    schedule: (delayMs: number, run: () => void) => {
      delays.push(delayMs);
      pending = run;
      return () => {
        pending = undefined;
      };
    },
    /** Runs the pending restart. */
    fire: () => {
      const run = pending;
      pending = undefined;
      run?.();
    },
    get pending() {
      return pending !== undefined;
    },
  };
}

/** A start whose outcome the test decides, and a promise of its settling. */
function controlledStart() {
  let settle: { resolve: (started: boolean) => void; reject: (error: Error) => void } | undefined;
  let started: Promise<boolean> | undefined;
  let calls = 0;
  /** Settles once the restarter's own handlers of the start ran. */
  const settled = () =>
    started!.then(
      () => undefined,
      () => undefined,
    );
  return {
    start: () => {
      started = new Promise<boolean>((resolve, reject) => {
        calls += 1;
        settle = { resolve, reject };
      });
      return started;
    },
    get calls() {
      return calls;
    },
    succeed: async () => {
      settle!.resolve(true);
      await settled();
    },
    /** The start left the node to another path. */
    skip: async () => {
      settle!.resolve(false);
      await settled();
    },
    fail: async () => {
      settle!.reject(new Error("port 7777 is taken"));
      await settled();
    },
  };
}

describe("restartDelayMs (D1201)", () => {
  it("doubles T3's 500 ms per attempt up to 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(restartDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });
});

describe("NodeRestarter (D1201)", () => {
  it("restarts an exited node after T3's first delay", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    expect(clock.delays).toEqual([500]);
    expect(node.calls).toBe(0);
    clock.fire();
    expect(node.calls).toBe(1);
    expect(restarter.restarting).toBe(true);
    await node.succeed();
    expect(restarter.restarting).toBe(false);
    expect(restarter.attempt).toBe(0);
  });

  it("backs off while starts fail and starts over once one succeeds", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    for (let failures = 0; failures < 3; failures += 1) {
      clock.fire();
      await node.fail();
    }
    expect(clock.delays).toEqual([500, 1_000, 2_000, 4_000]);
    clock.fire();
    await node.succeed();
    restarter.exited("killed again");
    expect(clock.delays.at(-1)).toBe(500);
  });

  it("keeps one restart pending however often the node is reported gone", () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    restarter.exited("killed");
    expect(clock.delays).toEqual([500]);
  });

  it("schedules nothing once stopped, and cancels what is pending", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    restarter.stop();
    expect(clock.pending).toBe(false);
    restarter.exited("killed");
    expect(clock.delays).toEqual([500]);
    expect(node.calls).toBe(0);
  });

  it("does not schedule again when a start fails after the app stopped it", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    clock.fire();
    restarter.stop();
    await node.fail();
    expect(clock.delays).toEqual([500]);
  });

  it("restarts again when the node dies while a restart is starting it", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    clock.fire();
    restarter.exited("died while starting");
    expect(clock.delays).toEqual([500]);
    await node.succeed();
    expect(clock.delays).toEqual([500, 1_000]);
    clock.fire();
    expect(node.calls).toBe(2);
  });

  it("schedules nothing for an exit during a start the app stopped meanwhile", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    clock.fire();
    restarter.exited("died while starting");
    restarter.stop();
    await node.succeed();
    expect(clock.delays).toEqual([500]);
  });

  it("retries once when the node died during a start that then failed", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    clock.fire();
    restarter.exited("died while starting");
    await node.fail();
    expect(clock.delays).toEqual([500, 1_000]);
    expect(restarter.restarting).toBe(true);
  });

  it("restarts again after a quit that did not happen (a failed update install)", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.stop();
    restarter.exited("killed");
    expect(clock.delays).toEqual([]);
    restarter.resume();
    restarter.exited("killed");
    expect(clock.delays).toEqual([500]);
  });

  it("neither counts nor retries a start that left the node to another path", async () => {
    const clock = manualSchedule();
    const node = controlledStart();
    const restarter = new NodeRestarter({ start: node.start, schedule: clock.schedule });
    restarter.exited("killed");
    clock.fire();
    await node.fail();
    clock.fire();
    restarter.exited("died while starting");
    await node.skip();
    expect(clock.delays).toEqual([500, 1_000]);
    expect(restarter.restarting).toBe(false);
    // The count stays: the next exit waits as long as the next failure would.
    expect(restarter.attempt).toBe(2);
  });
});
