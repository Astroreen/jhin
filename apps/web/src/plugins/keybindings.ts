import {
  KEYBINDINGS_CAPABILITY,
  KEYBINDINGS_CONFIG_SECTION,
  KeybindingsConfig,
  type ActiveKeybinding,
  type KeybindingRule,
  type Keybindings,
} from "@jhin/client-api";
import { definePlugin, toDisposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";
import {
  mergeKeybindings,
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ResolvedKeybinding,
} from "../lib/keybindings.ts";

export { KEYBINDINGS_CAPABILITY, type Keybindings };

/** Whether focus is in a place that takes typing. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !["button", "checkbox", "radio", "range", "submit", "reset"].includes(target.type)
  );
}

/**
 * Keyboard shortcuts for client commands (T3 Code's keybindings): plugins add
 * defaults, the `jhin.keybindings` section overrides them per command, and a
 * key press runs the last rule whose keys and `when` clause match.
 */
export const keybindingsPlugin = builtin(
  "jhin.keybindings",
  { provides: { [KEYBINDINGS_CAPABILITY]: "1.0.0" } },
  definePlugin({
    activate(context) {
      context.config.define(KEYBINDINGS_CONFIG_SECTION, KeybindingsConfig);
      const defaults: KeybindingRule[][] = [];
      const contextKeys = new Map<string, boolean>();
      const listeners = new Set<() => void>();
      let resolved: ResolvedKeybinding[] = [];
      let active: ActiveKeybinding[] = [];

      const custom = (): readonly KeybindingRule[] => {
        try {
          return context.config.get<KeybindingsConfig>(KEYBINDINGS_CONFIG_SECTION).rules;
        } catch (error) {
          context.log.warn("jhin.keybindings is invalid; using the defaults", {
            error: String(error),
          });
          return [];
        }
      };
      const rebuild = () => {
        const rules = custom();
        const all = defaults.flat();
        resolved = mergeKeybindings(all, rules);
        const fromConfig = new Set(rules.map((rule) => rule.command));
        active = resolved.map((rule) => ({
          command: rule.command,
          key: rule.key,
          ...(rule.when === undefined ? {} : { when: rule.when }),
          source: fromConfig.has(rule.command) ? "config" : "default",
        }));
        for (const listener of Array.from(listeners)) listener();
      };
      context.config.onDidChange(KEYBINDINGS_CONFIG_SECTION, rebuild);

      const keyContext = (event: KeyboardEvent): Record<string, boolean> => ({
        ...Object.fromEntries(contextKeys),
        editableFocus: isEditable(event.target),
      });

      const service: Keybindings = {
        addDefaults(rules) {
          const entry = [...rules];
          defaults.push(entry);
          rebuild();
          return toDisposable(() => {
            const index = defaults.indexOf(entry);
            if (index >= 0) defaults.splice(index, 1);
            rebuild();
          });
        },
        setContext(key, value) {
          contextKeys.set(key, value);
          return toDisposable(() => {
            if (contextKeys.get(key) === value) contextKeys.delete(key);
          });
        },
        labelFor: (command) =>
          shortcutLabelForCommand(resolved, command, Object.fromEntries(contextKeys)),
        list: () => active,
        subscribe(listener) {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      };
      context.services.provide(KEYBINDINGS_CAPABILITY, service);

      const registered = () => new Set(context.commands.list().map((command) => command.name));
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || event.repeat) return;
        // A field recording a shortcut gets every key.
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("[data-keybinding-capture]")
        )
          return;
        const rule = resolveShortcutCommand(event, resolved, keyContext(event));
        if (rule === null || !registered().has(rule.command)) return;
        event.preventDefault();
        event.stopPropagation();
        void context.commands.execute(rule.command, {}).catch((error: unknown) =>
          context.log.error("shortcut command failed", {
            command: rule.command,
            error: String(error),
          }),
        );
      };
      window.addEventListener("keydown", onKeyDown, true);
      context.subscriptions.add({
        dispose: () => window.removeEventListener("keydown", onKeyDown, true),
      });
      rebuild();
    },
  }),
);
