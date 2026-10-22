import { describe, expect, it } from "vite-plus/test";

import { createClock, type ClockHost } from "../src/lib/clock.ts";

/** A host whose time and timers the test moves by hand. */
function fakeHost() {
  let now = 1_000;
  let visible = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  let ids = 0;
  const visibility = new Set<() => void>();
  const host: ClockHost = {
    now: () => now,
    setTimeout(run, ms) {
      const id = ++ids;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
    visible: () => visible,
    onVisibilityChange(listener) {
      visibility.add(listener);
      return { dispose: () => visibility.delete(listener) };
    },
  };
  return {
    host,
    timers,
    /** Moves the time on, running the timers that come due. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    hide(hidden: boolean) {
      visible = !hidden;
      for (const listener of visibility) listener();
    },
  };
}

describe("the sidebar's clock: one time for the list and its commands", () => {
  it("gives commands the time the list is drawn with while it is watched", () => {
    const fake = fakeHost();
    const clock = createClock({ intervalMs: 60_000, host: fake.host });
    const seen: number[] = [];
    const subscription = clock.subscribe(() => seen.push(clock.get()));
    fake.advance(30_000);
    // Half a minute on, the list still shows the minute it was drawn: so do commands.
    expect(clock.now()).toBe(clock.get());
    expect(clock.now()).toBe(1_000);
    fake.advance(30_000);
    expect(seen).toEqual([61_000]);
    expect(clock.now()).toBe(61_000);
    subscription.dispose();
    // Nothing shows it: a command reads the time afresh, and nothing ticks.
    fake.advance(5_000);
    expect(clock.now()).toBe(66_000);
    expect(fake.timers.size).toBe(0);
  });

  it("reads the time afresh when asked, as when the threads it draws change", () => {
    const fake = fakeHost();
    const clock = createClock({ intervalMs: 60_000, host: fake.host });
    const seen: number[] = [];
    clock.subscribe(() => seen.push(clock.get()));
    fake.advance(20_000);
    clock.refresh();
    clock.refresh();
    expect(seen).toEqual([21_000]);
    expect(clock.now()).toBe(21_000);
  });

  it("ticks once at a time asked for, such as a snooze ending", () => {
    const fake = fakeHost();
    const clock = createClock({ intervalMs: 60_000, host: fake.host });
    const seen: number[] = [];
    clock.subscribe(() => seen.push(clock.get()));
    clock.wakeAt(11_000);
    fake.advance(10_000);
    expect(seen).toEqual([11_000]);
  });

  it("stops ticking while the page is hidden and catches up when shown", () => {
    const fake = fakeHost();
    const clock = createClock({ intervalMs: 60_000, host: fake.host });
    const seen: number[] = [];
    clock.subscribe(() => seen.push(clock.get()));
    fake.hide(true);
    fake.advance(180_000);
    expect(seen).toEqual([]);
    fake.hide(false);
    expect(seen).toEqual([181_000]);
  });
});
