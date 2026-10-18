import { DOTTED_ID, toDisposable, type Disposable, type Logger } from "@jhin/sdk";

import { KernelError } from "./errors.ts";

export interface KernelEvent {
  readonly type: string;
  readonly payload: unknown;
}

/** In-process event bus. Listener errors are logged and never reach the emitter. */
export class EventBus {
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #any = new Set<(event: KernelEvent) => void>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  emit(type: string, payload?: unknown): void {
    if (!DOTTED_ID.test(type) || !type.includes(".")) {
      throw new KernelError(
        "EVENT_TYPE_INVALID",
        `Event type ${type} must be a namespaced lowercase dotted id`,
        {
          type,
        },
      );
    }
    // Snapshots, so a listener may unsubscribe while the event is being delivered.
    for (const listener of Array.from(this.#listeners.get(type) ?? []))
      this.#call(type, () => listener(payload));
    for (const listener of Array.from(this.#any))
      this.#call(type, () => listener({ type, payload }));
  }

  on(type: string, listener: (payload: unknown) => void): Disposable {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
    return toDisposable(() => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(type);
    });
  }

  onAny(listener: (event: KernelEvent) => void): Disposable {
    this.#any.add(listener);
    return toDisposable(() => this.#any.delete(listener));
  }

  #call(type: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.#log.error("event listener failed", { type, error: String(error) });
    }
  }
}
