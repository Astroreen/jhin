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
 * Collects disposables and disposes them in reverse order of addition.
 * Errors from one disposable do not prevent the others from running; they are
 * rethrown together once every disposable ran.
 */
export class DisposableStore implements Disposable {
  #items: Disposable[] = [];
  #disposed = false;

  get isDisposed(): boolean {
    return this.#disposed;
  }

  add<T extends Disposable>(item: T): T {
    if (this.#disposed) {
      item.dispose();
      return item;
    }
    this.#items.push(item);
    return item;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = this.#items.toReversed();
    this.#items = [];
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
