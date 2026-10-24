/**
 * The part of an `AbortSignal` a command reads (docs/plans/orchestration.md,
 * D1501). Any runtime's `AbortSignal` is one, so isomorphic code needs no DOM
 * or Node types to take or pass it.
 */
export interface CancelSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** A signal that `cancel()` aborts, once; a listener added afterwards is never called. */
export function createCancelSignal(): { readonly signal: CancelSignal; cancel(): void } {
  const listeners = new Set<() => void>();
  let aborted = false;
  const signal: CancelSignal = {
    get aborted() {
      return aborted;
    },
    addEventListener: (_type, listener) => {
      if (!aborted) listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    signal,
    cancel() {
      if (aborted) return;
      aborted = true;
      const called = [...listeners];
      listeners.clear();
      for (const listener of called) listener();
    },
  };
}
