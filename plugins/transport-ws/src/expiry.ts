import type { Disposable } from "@jhin/sdk";

/** The longest delay `setTimeout` keeps; a later expiry is checked again then. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Clock {
  now(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  setTimer(run: () => void, ms: number): () => void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * Calls `expire` once `expiresAt` has passed (security.md D414): at once when
 * it already has, else when the timer fires. A timer longer than `setTimeout`
 * keeps is set to its limit and set again from there.
 */
export function onExpiry(expiresAt: number, expire: () => void, clock = systemClock): Disposable {
  let cancel: (() => void) | undefined;
  const arm = () => {
    const left = expiresAt - clock.now();
    if (left <= 0) {
      cancel = undefined;
      expire();
      return;
    }
    cancel = clock.setTimer(arm, Math.min(left, MAX_TIMER_MS));
  };
  arm();
  return { dispose: () => cancel?.() };
}
