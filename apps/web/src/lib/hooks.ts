import type { Keybindings } from "@jhin/client-api";
import type { Disposable, PluginContext } from "@jhin/sdk";
import { useEffect, useState, useSyncExternalStore } from "react";

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

/**
 * The current value of a config section, re-rendering when a layer changes it.
 * The section must be defined (by this plugin or another).
 */
export function useConfig<T>(context: PluginContext, section: string): T {
  return useSyncExternalStore(
    (listener) => {
      const subscription = context.config.onDidChange(section, listener);
      return () => subscription.dispose();
    },
    () => cachedConfig<T>(context, section),
  );
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
      void navigator.clipboard?.writeText(text).then(
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
