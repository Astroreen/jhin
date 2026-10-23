/**
 * Work run one at a time per key, in the order it was asked for (D1332): a device's actions and
 * settings reads. A failed piece of work does not hold back the next.
 */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const next = previous.then(work, work);
      const tail = next.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return next;
    },
  };
}
