import type { Disposable } from "@jhin/sdk";

export interface ClockHost {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** Whether the page is shown; a hidden page's clock does not tick. */
  visible(): boolean;
  /** Calls `listener` when the page is shown or hidden. */
  onVisibilityChange(listener: () => void): Disposable;
}

const browserHost: ClockHost = {
  now: () => Date.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  onVisibilityChange(listener) {
    if (typeof document === "undefined") return { dispose() {} };
    document.addEventListener("visibilitychange", listener);
    return { dispose: () => document.removeEventListener("visibilitychange", listener) };
  },
};

/** Timers longer than this overflow in browsers. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * One time for a view and the commands that act on what it shows, so a
 * shortcut counts the rows the user sees (the sidebar's minute tick, as T3's
 * useNowMinute). While somebody subscribes it ticks every `intervalMs` and at
 * each time asked for with `wakeAt` (a snooze ending); unwatched, `now` reads
 * the time afresh, as nothing shows it.
 */
export function createClock(options: { intervalMs?: number; host?: ClockHost } = {}) {
  const host = options.host ?? browserHost;
  const intervalMs = options.intervalMs ?? 60_000;
  const listeners = new Set<() => void>();
  let value = host.now();
  let tick: unknown;
  let wake: { at: number; timer: unknown } | undefined;
  let visibility: Disposable | undefined;

  const emit = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const update = () => {
    value = host.now();
    emit();
  };
  const schedule = () => {
    if (tick !== undefined) host.clearTimeout(tick);
    tick = undefined;
    if (listeners.size === 0 || !host.visible()) return;
    tick = host.setTimeout(() => {
      update();
      schedule();
    }, intervalMs);
  };
  const clearWake = () => {
    if (wake !== undefined) host.clearTimeout(wake.timer);
    wake = undefined;
  };

  return {
    /** The time renders show: the same value until the next tick. */
    get: () => value,
    /** The time for a command: what renders show while they are watching, else now. */
    now: () => (listeners.size === 0 ? host.now() : value),
    /** Reads the time afresh now, e.g. when what is drawn with it changed. */
    refresh() {
      if (listeners.size > 0 && host.now() !== value) update();
    },
    /** Ticks once at `at` (ms) as well, if anyone watches; a later call replaces it. */
    wakeAt(at: number | undefined) {
      if (wake?.at === at) return;
      clearWake();
      if (at === undefined || listeners.size === 0) return;
      const timer = host.setTimeout(
        () => {
          wake = undefined;
          update();
        },
        Math.min(Math.max(0, at - host.now()), MAX_TIMER_MS),
      );
      wake = { at, timer };
    },
    subscribe(listener: () => void): Disposable {
      if (listeners.size === 0) {
        value = host.now();
        visibility = host.onVisibilityChange(() => {
          if (host.visible()) update();
          schedule();
        });
      }
      listeners.add(listener);
      schedule();
      return {
        dispose() {
          if (!listeners.delete(listener) || listeners.size > 0) return;
          visibility?.dispose();
          visibility = undefined;
          schedule();
          clearWake();
        },
      };
    },
  };
}
