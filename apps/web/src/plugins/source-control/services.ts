import { targetKey, type Navigation, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import type { ProjectStatus } from "@jhin/source-control-api";
import type { Toasts } from "@jhin/ui";
import { useSyncExternalStore } from "react";

import type { SourceControlStore, SourceControlView } from "./store.ts";

/** What the source control components use, handed over by the plugin. */
export interface SourceControlServices {
  readonly context: PluginContext;
  readonly store: SourceControlStore;
  readonly threads: ThreadsCatalog;
  readonly navigation: Navigation;
  readonly toasts: Toasts | undefined;
  /** The label of the diff panel's shortcut, e.g. "⌘D". */
  shortcut(): string | undefined;
}

type Subscribe = (listener: () => void) => () => void;
const subscribers = new WeakMap<SourceControlStore, Map<string, Subscribe>>();

/** A node's source control, kept current: one subscription per target however often the caller renders. */
export function useSourceControl(store: SourceControlStore, target: NodeTarget): SourceControlView {
  const byTarget = subscribers.get(store) ?? new Map<string, Subscribe>();
  subscribers.set(store, byTarget);
  const key = targetKey(target);
  let subscribe = byTarget.get(key);
  if (subscribe === undefined) {
    const fixed = { ...target };
    subscribe = (listener) => {
      const subscription = store.subscribe(fixed, listener);
      return () => subscription.dispose();
    };
    byTarget.set(key, subscribe);
  }
  return useSyncExternalStore(subscribe, () => store.view(target));
}

/** The branch a thread works on, else (a draft, a thread not recorded yet) the one checked out. */
export function branchOf(
  view: SourceControlView,
  status: ProjectStatus | undefined,
  threadId: string | undefined,
): string | null {
  const recorded = threadId === undefined ? undefined : view.threads.get(threadId);
  if (recorded !== undefined) return recorded.branch;
  return status?.branch ?? null;
}
