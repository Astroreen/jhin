/** Runs `run` after `ms`; the returned function cancels it. Tests pass their own. */
export type Delay = (run: () => void, ms: number) => () => void;

/** `setTimeout` that keeps no process alive. */
export const realDelay: Delay = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};
