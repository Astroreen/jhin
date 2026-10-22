import { THREAD_WORK_CAPABILITY, type ThreadWork, type ThreadWorkSource } from "@jhin/client-api";
import { definePlugin, type Disposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

/** A `client.thread-work@1` that joins the sources plugins register (D1131). */
export function createThreadWork(
  warn: (message: string, fields: Record<string, unknown>) => void = () => undefined,
): ThreadWork {
  const sources = new Set<ThreadWorkSource>();
  const listeners = new Set<() => void>();
  /** Every listener hears of a change, whatever another one throws. */
  const changed = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        warn("a thread work listener failed", { error: String(error) });
      }
    }
  };
  return {
    register(source) {
      // Registered already: one registration is enough, and this one owns nothing.
      if (sources.has(source)) return { dispose: () => undefined };
      // A source that cannot be followed is not added at all; its plugin still activates.
      let subscription: Disposable;
      try {
        subscription = source.subscribe(changed);
      } catch (error) {
        warn("a thread work source could not be followed", { error: String(error) });
        return { dispose: () => undefined };
      }
      sources.add(source);
      changed();
      return {
        dispose() {
          if (!sources.delete(source)) return;
          subscription.dispose();
          changed();
        },
      };
    },
    // A source that throws reports nothing; the others still do.
    tasks: (target, threadId) =>
      Array.from(sources).flatMap((source) => {
        try {
          return source.tasks(target, threadId);
        } catch (error) {
          warn("a thread work source failed", { error: String(error) });
          return [];
        }
      }),
    subscribe(listener): Disposable {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

/** `client.thread-work@1`: the background work threads wait on, from every plugin. */
export const threadWorkPlugin = builtin(
  "jhin.thread-work",
  { provides: { [THREAD_WORK_CAPABILITY]: "1.0.0" } },
  definePlugin({
    activate(context) {
      context.services.provide(
        THREAD_WORK_CAPABILITY,
        createThreadWork((message, fields) => context.log.warn(message, fields)),
      );
    },
  }),
);
