// The client settings follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/settings.ts.
import { z, type PluginContext } from "@jhin/sdk";
import { useSyncExternalStore } from "react";

import { configSubscriber } from "./hooks.ts";

/** Colors and widths of the page; defined by the UI host. */
export const APPEARANCE_SECTION = "jhin.appearance";
export const Appearance = z.object({
  /** Light, dark, or following the system. */
  mode: z.enum(["system", "light", "dark"]).default("system"),
  /** How wide the chat column is. */
  chatWidth: z.enum(["comfortable", "wide", "full"]).default("comfortable"),
});
export type Appearance = z.output<typeof Appearance>;

/** Settings of the chat and the thread lists; defined by the chat plugin. */
export const CHAT_SECTION = "jhin.chat";
export const ChatSettings = z.object({
  /** Clock times in the timeline. */
  timestampFormat: z.enum(["locale", "12-hour", "24-hour"]).default("locale"),
  /** Enter sends (Shift+Enter is a new line), or ⌘/Ctrl+Enter sends. */
  sendShortcut: z.enum(["enter", "mod-enter"]).default("enter"),
  /** What a message sent while a turn runs does (T3's followUpBehavior, D209). */
  followUpBehavior: z.enum(["queue", "steer"]).default("queue"),
  /** Ask before archiving a thread. */
  confirmArchive: z.boolean().default(false),
  /** Ask before deleting a thread or removing a project. */
  confirmDelete: z.boolean().default(true),
  /** Ask before unpinning a thread (T3's confirmThreadUnpin). */
  confirmUnpin: z.boolean().default(false),
  /** T3's "Show skills in slash menu": skills in the `/` menu too, not only after `$` (D845). */
  showSkillsInSlashMenu: z.boolean().default(true),
  /** T3's "Rich text composer": the prompt shows its Markdown formatted while it is typed. */
  composerRichTextEnabled: z.boolean().default(true),
  /** T3's Working section (beta): threads at work leave the inbox until they need you (D452). */
  workingSection: z.boolean().default(false),
});
export type ChatSettings = z.output<typeof ChatSettings>;

/**
 * What this device shares with the owner's other devices through its nodes
 * (docs/plans/config-ui.md D488); defined by the device sync plugin and never
 * shared itself.
 */
export const SYNC_SECTION = "jhin.sync";
export const SyncSettings = z.object({
  /** This device's settings follow the other devices', and they follow it. */
  settings: z.boolean().default(false),
  /** Composer drafts follow their thread to every device. */
  drafts: z.boolean().default(false),
});
export type SyncSettings = z.output<typeof SyncSettings>;

/** A section's value, or its schema's defaults when nobody defined it (its plugin is absent). */
export function readSection<S extends z.ZodType>(
  context: PluginContext,
  section: string,
  schema: S,
): z.output<S> {
  try {
    return context.config.get<z.output<S>>(section);
  } catch {
    return schema.parse({});
  }
}

const cache = new WeakMap<PluginContext, Map<string, { raw: string; value: unknown }>>();

/** `readSection` for components: re-renders when the section changes. */
export function useSection<S extends z.ZodType>(
  context: PluginContext,
  section: string,
  schema: S,
): z.output<S> {
  return useSyncExternalStore(configSubscriber(context, section), () => {
    const value = readSection(context, section, schema);
    const raw = JSON.stringify(value);
    let sections = cache.get(context);
    if (sections === undefined) {
      sections = new Map();
      cache.set(context, sections);
    }
    const cached = sections.get(section);
    if (cached !== undefined && cached.raw === raw) return cached.value as z.output<S>;
    sections.set(section, { raw, value });
    return value;
  });
}

/** The diff panel's defaults on this device (T3 Code's diff settings, docs/plans/source-control.md D281). */
export const DIFF_SECTION = "jhin.diff";
export const DiffSettings = z.object({
  /** Stacked or side by side; the panel's toggle writes it too. */
  layout: z.enum(["stacked", "split"]).default("stacked"),
  /** Long lines wrap instead of scrolling. */
  wordWrap: z.boolean().default(true),
  /** Whitespace-only edits are hidden. */
  ignoreWhitespace: z.boolean().default(true),
  /** Files start folded. */
  filesCollapsed: z.boolean().default(true),
  /** T3's proactive panels: the right panel opens on new pull requests and big turns (D1426). */
  proactivePanels: z.boolean().default(false),
});
export type DiffSettings = z.output<typeof DiffSettings>;
