import type { Disposable } from "@jhin/sdk";
import { useSyncExternalStore } from "react";

/** Subscribes a component to anything with `subscribe` + a snapshot getter. */
export function useExternal<T>(
  source: { subscribe(listener: () => void): Disposable },
  get: () => T,
): T {
  return useSyncExternalStore((listener) => {
    const subscription = source.subscribe(listener);
    return () => subscription.dispose();
  }, get);
}
