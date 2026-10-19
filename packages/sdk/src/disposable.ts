/** A handle that releases whatever a registration acquired. */
export interface Disposable {
  dispose(): void;
}

export function toDisposable(dispose: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
}

/**
 * Collects disposables and disposes them in reverse order of addition; an item
 * added twice is disposed once. Errors from one disposable do not prevent the
 * others from running; they are rethrown together once every disposable ran.
 */
export class DisposableStore implements Disposable {
  // A set: forgetting one of many items costs the same as forgetting one of few.
  #items = new Set<Disposable>();
  #disposed = false;

  get isDisposed(): boolean {
    return this.#disposed;
  }

  add<T extends Disposable>(item: T): T {
    if (this.#disposed) {
      item.dispose();
      return item;
    }
    this.#items.add(item);
    return item;
  }

  /** Forgets an item without disposing it, e.g. one that was disposed on its own. */
  delete(item: Disposable): void {
    this.#items.delete(item);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = [...this.#items].toReversed();
    this.#items.clear();
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Several disposables failed");
  }
}
