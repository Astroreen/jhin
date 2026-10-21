import {
  targetKey,
  type Connections,
  type DeviceSettings,
  type Navigation,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import type { DiffScopes, ProjectStatus } from "@jhin/source-control-api";
import type { Toasts } from "@jhin/ui";
import { useSyncExternalStore } from "react";

import type { RunningActions } from "./running.ts";
import type { TimestampFormat } from "../../lib/format.ts";
import type { DiffSelections } from "./diff/scopes.ts";
import type { SourceControlStore, SourceControlView } from "./store.ts";

/** The route's panel name of the diff panel. */
export const DIFF_PANEL = "diff";

/** What the source control components use, handed over by the plugin. */
export interface SourceControlServices {
  readonly context: PluginContext;
  readonly store: SourceControlStore;
  readonly threads: ThreadsCatalog;
  readonly connections: Connections;
  readonly navigation: Navigation;
  /** The git actions running from this client. */
  readonly running: RunningActions;
  readonly toasts: Toasts | undefined;
  /** The diff panel's scopes (D283) and what each thread has selected. */
  readonly scopes: DiffScopes;
  readonly selections: DiffSelections;
  /** This device's settings, where the panel's layout toggle writes. */
  readonly settings: DeviceSettings | undefined;
  /** How the chat shows times (its `timestampFormat` setting). */
  timestampFormat(): TimestampFormat;
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
