import {
  targetKey,
  type Keybindings,
  type NodeCatalog,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { CommandInfo, Disposable, PluginContext } from "@jhin/sdk";
import { copyText } from "@jhin/ui";
import { useEffect, useState, useSyncExternalStore } from "react";

type Subscribe = (listener: () => void) => () => void;

/**
 * One subscribe function per source, as React wants it: a new one each render
 * would unsubscribe and subscribe again every time (with or without the
 * React Compiler memoizing the caller).
 */
const subscribers = new WeakMap<object, Subscribe>();
function subscriberOf(source: { subscribe(listener: () => void): Disposable }): Subscribe {
  let subscribe = subscribers.get(source);
  if (subscribe === undefined) {
    subscribe = (listener) => {
      const subscription = source.subscribe(listener);
      return () => subscription.dispose();
    };
    subscribers.set(source, subscribe);
  }
  return subscribe;
}

/** Subscribes a component to anything with `subscribe` + a snapshot getter. */
export function useExternal<T>(
  source: { subscribe(listener: () => void): Disposable },
  get: () => T,
): T {
  return useSyncExternalStore(subscriberOf(source), get);
}

const catalogSubscribers = new WeakMap<ThreadsCatalog, Map<string, Subscribe>>();
const noSubscription: Subscribe = () => () => undefined;

/** A node's catalog, kept current: one subscription per target however often the caller renders. */
export function useCatalog(
  threads: ThreadsCatalog,
  target: NodeTarget | undefined,
): NodeCatalog | undefined {
  let subscribe = noSubscription;
  if (target !== undefined) {
    const byTarget = catalogSubscribers.get(threads) ?? new Map<string, Subscribe>();
    catalogSubscribers.set(threads, byTarget);
    const key = targetKey(target);
    const known = byTarget.get(key);
    if (known === undefined) {
      const fixed = { ...target };
      subscribe = (listener) => {
        const subscription = threads.subscribe(fixed, listener);
        return () => subscription.dispose();
      };
      byTarget.set(key, subscribe);
    } else {
      subscribe = known;
    }
  }
  return useSyncExternalStore(subscribe, () =>
    target === undefined ? undefined : threads.catalog(target),
  );
}

/**
 * The current value of a config section, re-rendering when a layer changes it.
 * The section must be defined (by this plugin or another).
 */
export function useConfig<T>(context: PluginContext, section: string): T {
  return useSyncExternalStore(configSubscriber(context, section), () =>
    cachedConfig<T>(context, section),
  );
}

const configSubscribers = new WeakMap<PluginContext, Map<string, Subscribe>>();
/** One subscribe function per plugin and config section (see `subscriberOf`). */
export function configSubscriber(context: PluginContext, section: string): Subscribe {
  const bySection = configSubscribers.get(context) ?? new Map<string, Subscribe>();
  configSubscribers.set(context, bySection);
  let subscribe = bySection.get(section);
  if (subscribe === undefined) {
    subscribe = (listener) => {
      const subscription = context.config.onDidChange(section, listener);
      return () => subscription.dispose();
    };
    bySection.set(section, subscribe);
  }
  return subscribe;
}

/** `config.get` parses on every call; snapshots must be stable between changes. */
const configCache = new WeakMap<PluginContext, Map<string, { raw: string; value: unknown }>>();
function cachedConfig<T>(context: PluginContext, section: string): T {
  const value = context.config.get<T>(section);
  const raw = JSON.stringify(value);
  let sections = configCache.get(context);
  if (sections === undefined) {
    sections = new Map();
    configCache.set(context, sections);
  }
  const cached = sections.get(section);
  if (cached !== undefined && cached.raw === raw) return cached.value as T;
  sections.set(section, { raw, value });
  return value;
}

/**
 * A clock for labels that change with time ("5m ago"): re-renders every
 * `intervalMs` while mounted and the page is visible.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      stop();
      if (document.visibilityState === "visible") start();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}

/** Copies text; `copied` is true for a moment after a successful copy. */
export function useCopy(resetMs = 1200): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), resetMs);
    return () => clearTimeout(timer);
  }, [copied, resetMs]);
  return {
    copied,
    copy(text) {
      void copyText(text).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    },
  };
}

const noKeybindings = { subscribe: () => ({ dispose() {} }) };

/**
 * The shortcut label of a command, e.g. "Ctrl+K". The function is new
 * whenever shortcuts change, so (memoized) renders that call it update.
 */
export function useShortcutLabels(
  keybindings: Keybindings | undefined,
): (command: string) => string | undefined {
  const active = useExternal(keybindings ?? noKeybindings, () => keybindings?.list());
  return (command) => (active === undefined ? undefined : keybindings?.labelFor(command));
}

/** The commands registered now, following plugins as they come and go (with their commands). */
export function useCommands(context: PluginContext): readonly CommandInfo[] {
  const [commands, setCommands] = useState(() => context.commands.list());
  useEffect(() => {
    const refresh = () => setCommands(context.commands.list());
    const subscriptions = [
      context.events.on("kernel.plugin.activated", refresh),
      context.events.on("kernel.plugin.deactivated", refresh),
    ];
    refresh();
    return () => subscriptions.forEach((subscription) => subscription.dispose());
  }, [context]);
  return commands;
}
