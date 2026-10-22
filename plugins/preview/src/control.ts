// Follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/preview/SessionControl.ts.
import type { PreviewControlReason } from "@jhin/preview-api";

export class ControlInterrupted extends Error {
  readonly reason: PreviewControlReason;

  constructor(
    message = "Browser control changed. Refresh the snapshot before trying again.",
    reason: PreviewControlReason = "interrupted",
  ) {
    super(message);
    this.name = "ControlInterrupted";
    this.reason = reason;
  }
}

/**
 * Who may act on a tab (D397). Control is reserved at once, but running work
 * drains before the new owner can act: agent actions run one at a time, and a
 * change of owner fails the ones still queued.
 */
export class TabControl {
  /** The agent session that owns the tab; `null` for a tab nobody claimed. */
  readonly agentId: string | null;
  readonly #onGenerationChange: () => void;
  #tail: Promise<unknown> = Promise.resolve();
  #pending: Promise<void> = Promise.resolve();
  #owner: string | null = null;
  #epoch = 0;
  #closed = false;

  constructor(agentId: string | null, onGenerationChange: () => void = () => {}) {
    this.agentId = agentId;
    this.#onGenerationChange = onGenerationChange;
  }

  /** The viewer holding control, if a human does. */
  get controller(): string | null {
    return this.#owner;
  }

  get generation(): number {
    return this.#epoch;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #enqueue<A>(run: () => Promise<A>): Promise<A> {
    const result = this.#tail.then(run);
    this.#tail = result.then(
      () => this.#pending,
      () => this.#pending,
    );
    return result;
  }

  /** An action can answer before its navigation commits, while later actions still wait for it. */
  track(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.#pending = Promise.all([this.#pending, settled]).then(() => undefined);
  }

  #assertOpen(): void {
    if (this.#closed) throw new ControlInterrupted("This browser tab is closed.", "closed");
  }

  #changeOwner(owner: string | null): void {
    this.#owner = owner;
    this.#epoch++;
    this.#onGenerationChange();
  }

  async #action<A>(allowed: () => boolean, run: () => Promise<A>): Promise<A> {
    this.#assertOpen();
    if (!allowed()) throw new ControlInterrupted("You do not control this browser tab.");
    const epoch = this.#epoch;
    return this.#enqueue(async () => {
      this.#assertOpen();
      if (epoch !== this.#epoch || !allowed()) throw new ControlInterrupted();
      return run();
    });
  }

  agentMayAct(agentId: string): boolean {
    return this.agentId === null || this.agentId === agentId;
  }

  agentCanActNow(agentId: string): boolean {
    return this.agentMayAct(agentId) && this.#owner === null;
  }

  agent<A>(agentId: string, run: () => Promise<A>): Promise<A> {
    if (!this.agentMayAct(agentId)) {
      return Promise.reject(
        new ControlInterrupted("This tab belongs to another agent.", "agentMismatch"),
      );
    }
    if (this.#owner !== null) {
      return Promise.reject(new ControlInterrupted("A human controls this tab.", "humanControl"));
    }
    return this.#action(() => this.agentMayAct(agentId) && this.#owner === null, run);
  }

  /** A read that needs no control and does not queue: an agent looks while a human drives. */
  observe<A>(run: () => Promise<A>): Promise<A> {
    this.#assertOpen();
    return run();
  }

  /** Work of the node itself (a resize from the panel's toolbar): queued, no owner check. */
  system<A>(run: () => Promise<A>): Promise<A> {
    this.#assertOpen();
    return this.#enqueue(async () => {
      this.#assertOpen();
      return run();
    });
  }

  human<A>(viewer: string, run: () => Promise<A>): Promise<A> {
    return this.#action(() => this.#owner === viewer, run);
  }

  async take(viewer: string): Promise<void> {
    this.#assertOpen();
    if (this.#owner !== null && this.#owner !== viewer) {
      throw new ControlInterrupted("Another viewer controls this browser tab.");
    }
    if (this.#owner !== viewer) this.#changeOwner(viewer);
    await this.human(viewer, async () => {});
  }

  async release(viewer: string, afterDrain: () => Promise<void> = async () => {}): Promise<void> {
    this.#assertOpen();
    if (this.#owner !== viewer) {
      throw new ControlInterrupted("Only the controlling viewer can release this browser tab.");
    }
    this.#changeOwner(null);
    await this.#enqueue(afterDrain);
  }

  /** Whoever holds control lets go: the last viewer stopped watching. */
  async releaseAny(afterDrain?: () => Promise<void>): Promise<void> {
    if (!this.#closed && this.#owner !== null) await this.release(this.#owner, afterDrain);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#changeOwner(null);
    }
    await this.#tail.catch(() => undefined);
  }
}
