import { toDisposable, type Disposable } from "@jhin/sdk";

/** What the page offers to fetch ahead: a chunk's `preload` (D1596). */
export type Prefetch = () => Promise<unknown>;

interface IdleWindow {
  readonly document: Pick<Document, "readyState">;
  readonly navigator: { readonly connection?: { readonly saveData?: boolean } };
  addEventListener(type: "load", listener: () => void, options: { once: true }): void;
  removeEventListener(type: "load", listener: () => void): void;
  requestIdleCallback?(callback: () => void): number;
  cancelIdleCallback?(handle: number): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

/**
 * The chunks to fetch while the page is idle (D1596, D1615): one at a time, each in its own
 * idle callback, after the page's `load` event, so the first screen has the network and the
 * main thread first. Nothing is fetched when the browser asks to save data.
 */
export function createIdlePrefetch(win: IdleWindow) {
  const queue: Prefetch[] = [];
  let loaded = win.document.readyState === "complete";
  let scheduled: { cancel(): void } | undefined;
  let running = false;

  const later = (callback: () => void): { cancel(): void } => {
    if (win.requestIdleCallback !== undefined) {
      const handle = win.requestIdleCallback(callback);
      return { cancel: () => win.cancelIdleCallback?.(handle) };
    }
    // Safari has no idle callback: the next task after the load event.
    const handle = win.setTimeout(callback, 0);
    return { cancel: () => win.clearTimeout(handle) };
  };

  const next = () => {
    if (!loaded || running || scheduled !== undefined || queue.length === 0) return;
    scheduled = later(() => {
      scheduled = undefined;
      const prefetch = queue.shift();
      if (prefetch === undefined) return;
      running = true;
      // A chunk that fails here, even by throwing at once, does not stop the queue.
      let fetching: Promise<unknown>;
      try {
        fetching = prefetch();
      } catch (error) {
        fetching = Promise.reject(error);
      }
      void fetching
        .catch(() => undefined)
        .finally(() => {
          running = false;
          next();
        });
    });
  };

  const onLoad = () => {
    loaded = true;
    next();
  };
  if (!loaded) win.addEventListener("load", onLoad, { once: true });

  return {
    /** Queues a chunk; disposing it before its turn takes it off the queue. */
    add(prefetch: Prefetch): Disposable {
      if (win.navigator.connection?.saveData === true) return toDisposable(() => undefined);
      queue.push(prefetch);
      next();
      return toDisposable(() => {
        const index = queue.indexOf(prefetch);
        if (index !== -1) queue.splice(index, 1);
      });
    },
    dispose() {
      queue.length = 0;
      scheduled?.cancel();
      scheduled = undefined;
      win.removeEventListener("load", onLoad);
    },
  };
}

type IdlePrefetch = ReturnType<typeof createIdlePrefetch>;

let shared: IdlePrefetch | undefined;

/**
 * Queues a chunk on the page's one idle queue, so the plugins' chunks are fetched one after
 * another. The queue holds only what is still to fetch: a reload starts it again.
 */
export function prefetchWhenIdle(prefetch: Prefetch): Disposable {
  if (typeof window === "undefined") return toDisposable(() => undefined);
  shared ??= createIdlePrefetch(window as unknown as IdleWindow);
  return shared.add(prefetch);
}
