// The running git actions of this client, apart from the control that shows them, so the
// control can load as a chunk of its own (D440) while the plugin keeps its state.

/** A git action running in a project, as its progress tells it. */
export interface RunningAction {
  readonly actionId: string;
  readonly pulling: boolean;
  readonly label: string | null;
  /** The last line a commit hook printed. */
  readonly output: string | null;
  readonly startedAt: number;
}

/** The running git actions of this client, by node and project. */
export interface RunningActions {
  get(key: string): RunningAction | undefined;
  set(key: string, action: RunningAction | undefined): void;
  subscribe(listener: () => void): () => void;
}

export function createRunningActions(): RunningActions {
  const running = new Map<string, RunningAction>();
  const listeners = new Set<() => void>();
  return {
    get: (key) => running.get(key),
    set(key, action) {
      if (action === undefined) running.delete(key);
      else running.set(key, action);
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
