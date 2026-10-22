import { describe, expect, it } from "vite-plus/test";

import { MAX_TIMER_MS, onExpiry, type Clock } from "../src/expiry.ts";

/** A clock the test moves by hand; timers fire when it passes them. */
function manualClock(start: number) {
  let now = start;
  const timers: { at: number; run: () => void; ms: number }[] = [];
  const clock: Clock = {
    now: () => now,
    setTimer(run, ms) {
      const timer = { at: now + ms, run, ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((entry) => entry.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  return { clock, timers, advance };
}

describe("token expiry (security.md D414)", () => {
  it("expires at once when the time has passed", () => {
    const { clock } = manualClock(1000);
    let expired = 0;
    onExpiry(1000, () => expired++, clock);
    expect(expired).toBe(1);
  });

  it("drops the connection when the time comes, not before", () => {
    const { clock, advance } = manualClock(0);
    let expired = 0;
    onExpiry(5000, () => expired++, clock);
    advance(4999);
    expect(expired).toBe(0);
    advance(1);
    expect(expired).toBe(1);
  });

  it("sets a timer past setTimeout's limit again from the limit", () => {
    const { clock, timers, advance } = manualClock(0);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    let expired = 0;
    onExpiry(thirtyDays, () => expired++, clock);
    expect(timers.map((timer) => timer.ms)).toEqual([MAX_TIMER_MS]);
    advance(MAX_TIMER_MS);
    expect(expired).toBe(0);
    expect(timers.map((timer) => timer.ms)).toEqual([thirtyDays - MAX_TIMER_MS]);
    advance(thirtyDays - MAX_TIMER_MS);
    expect(expired).toBe(1);
  });

  it("never fires once disposed", () => {
    const { clock, timers, advance } = manualClock(0);
    let expired = 0;
    onExpiry(10, () => expired++, clock).dispose();
    expect(timers).toEqual([]);
    advance(10);
    expect(expired).toBe(0);
  });
});
