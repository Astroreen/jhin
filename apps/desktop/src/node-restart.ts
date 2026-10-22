// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/backend/DesktopBackendManager.ts
// (calculateRestartDelay and scheduleRestart).

/** T3's first restart delay. */
const INITIAL_RESTART_DELAY_MS = 500;
/** T3's longest restart delay. */
const MAX_RESTART_DELAY_MS = 10_000;

/** T3's backoff: 500 ms doubled per failed attempt, at most 10 s (D1201). */
export function restartDelayMs(attempt: number): number {
  return Math.min(INITIAL_RESTART_DELAY_MS * 2 ** attempt, MAX_RESTART_DELAY_MS);
}

export interface NodeRestarterOptions {
  /** Starts the node once; rejects when it did not come up. */
  readonly start: () => Promise<void>;
  /** Runs `run` after `delayMs` and returns its cancel; tests run it when they choose. */
  readonly schedule?: (delayMs: number, run: () => void) => () => void;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * Restarts a local node that exited by itself, as T3's backend manager does
 * (D1201): after T3's delay, again with a longer one while starts fail, and
 * from the first delay again once a start succeeded. One restart is pending
 * at a time; `stop` cancels it for good (the app quits).
 */
export class NodeRestarter {
  readonly #start: () => Promise<void>;
  readonly #schedule: (delayMs: number, run: () => void) => () => void;
  readonly #log: (message: string, fields: Record<string, unknown>) => void;
  #attempt = 0;
  #pending: (() => void) | undefined;
  #running = false;
  #stopped = false;

  constructor(options: NodeRestarterOptions) {
    this.#start = options.start;
    this.#schedule =
      options.schedule ??
      ((delayMs, run) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      });
    this.#log = options.log ?? (() => {});
  }

  /** The attempts that failed since the node last came up. */
  get attempt(): number {
    return this.#attempt;
  }

  /** Whether a restart is waiting for its delay or starting the node. */
  get restarting(): boolean {
    return this.#pending !== undefined || this.#running;
  }

  /** The node exited without being asked to: schedule its restart. */
  exited(reason: string): void {
    this.#scheduleRestart(reason);
  }

  /** Cancels a pending restart; nothing is scheduled afterwards. */
  stop(): void {
    this.#stopped = true;
    this.#pending?.();
    this.#pending = undefined;
  }

  #scheduleRestart(reason: string): void {
    if (this.#stopped || this.restarting) return;
    const delayMs = restartDelayMs(this.#attempt);
    this.#attempt += 1;
    this.#log("local node exited unexpectedly; restart scheduled", { reason, delayMs });
    this.#pending = this.#schedule(delayMs, () => {
      this.#pending = undefined;
      if (this.#stopped) return;
      this.#running = true;
      this.#start().then(
        () => {
          this.#running = false;
          this.#attempt = 0;
        },
        (error: unknown) => {
          this.#running = false;
          this.#scheduleRestart(error instanceof Error ? error.message : String(error));
        },
      );
    });
  }
}
