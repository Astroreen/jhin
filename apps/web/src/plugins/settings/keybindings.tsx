// The page follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/settings/KeybindingsSettings.tsx.
import {
  KEYBINDINGS_CONFIG_SECTION,
  KeybindingsConfig,
  type ActiveKeybinding,
  type KeybindingRule,
} from "@jhin/client-api";
import { Badge, Button, Input, Kbd, KbdGroup } from "@jhin/ui";
import { useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { formatShortcutLabel, keyFromEvent, parseShortcut } from "../../lib/keybindings.ts";
import { readSection } from "../../lib/settings.ts";
import { SettingsEmpty, SettingsRow, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

const GROUPS: Record<string, string> = {
  ui: "Interface",
  navigation: "Navigation",
  palette: "Navigation",
  settings: "Navigation",
  sidebar: "Threads",
  chat: "Chat",
  inspector: "Developer",
};

/** "Chat: Model Picker: Toggle" from `chat.model-picker.toggle`, when a command has no title. */
function commandLabel(name: string): string {
  return name
    .split(".")
    .map((part) => part.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .join(": ");
}

function ShortcutPill({ shortcutKey }: { shortcutKey: string }) {
  const shortcut = parseShortcut(shortcutKey);
  if (shortcut === null)
    return <span className="text-xs text-destructive-foreground">Invalid</span>;
  return (
    <KbdGroup>
      <Kbd>{formatShortcutLabel(shortcut)}</Kbd>
    </KbdGroup>
  );
}

/** A stable empty snapshot when no keybindings plugin is active. */
const NONE: readonly ActiveKeybinding[] = [];

export function KeybindingsSection() {
  const { context, keybindings, settings } = useSettingsServices();
  const active = useExternal(
    keybindings ?? { subscribe: () => ({ dispose() {} }) },
    () => keybindings?.list() ?? NONE,
  );
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | undefined>();
  if (keybindings === undefined) {
    return (
      <SettingsSection title="Keybindings">
        <SettingsEmpty>No keybindings plugin is active.</SettingsEmpty>
      </SettingsSection>
    );
  }
  const titles = new Map(context.commands.list().map((command) => [command.name, command.title]));
  const custom = (): KeybindingRule[] => [
    ...readSection(context, KEYBINDINGS_CONFIG_SECTION, KeybindingsConfig).rules,
  ];
  /** This device's rules: every custom rule, with the command's rules replaced. */
  const save = (command: string, rules: readonly KeybindingRule[]) =>
    settings.patch(KEYBINDINGS_CONFIG_SECTION, {
      rules: [...custom().filter((rule) => rule.command !== command), ...rules],
    });
  const reset = (command: string) =>
    settings.patch(KEYBINDINGS_CONFIG_SECTION, {
      rules: custom().filter((rule) => rule.command !== command),
    });

  const normalized = query.trim().toLowerCase();
  const rows = active.filter((rule) => {
    if (normalized === "") return true;
    const title = titles.get(rule.command) ?? commandLabel(rule.command);
    return `${title} ${rule.command} ${rule.key}`.toLowerCase().includes(normalized);
  });
  const grouped = new Map<string, typeof rows>();
  for (const rule of rows) {
    const group = GROUPS[rule.command.split(".")[0] ?? ""] ?? "Other";
    grouped.set(group, [...(grouped.get(group) ?? []), rule]);
  }

  return (
    <>
      <section aria-label="Keybindings" className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4">
          <Input
            aria-label="Search keybindings"
            className="min-w-0 basis-full sm:basis-0 sm:flex-1"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search keybindings"
            value={query}
          />
        </div>
        <p className="px-3 text-xs text-muted-foreground/80 sm:px-4">
          Changes here apply to this device. The browser may claim some shortcuts first.
        </p>
      </section>
      {[...grouped].map(([group, rules]) => (
        <SettingsSection key={group} title={group}>
          {rules.map((rule) => (
            <SettingsRow
              className="group/row rounded-none"
              control={
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {rule.source === "config" ? (
                    <Button
                      className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                      onClick={() => reset(rule.command)}
                      size="xs"
                      variant="ghost-muted"
                    >
                      Reset
                    </Button>
                  ) : null}
                  {recording === `${rule.command}|${rule.key}` ? (
                    <Input
                      aria-label={`New shortcut for ${titles.get(rule.command) ?? rule.command}`}
                      autoFocus
                      className="w-44 font-mono"
                      data-keybinding-capture
                      onBlur={() => setRecording(undefined)}
                      onKeyDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          setRecording(undefined);
                          return;
                        }
                        const key = keyFromEvent(event.nativeEvent);
                        if (key === null) return;
                        save(rule.command, [
                          {
                            key,
                            command: rule.command,
                            ...(rule.when === undefined ? {} : { when: rule.when }),
                          },
                        ]);
                        setRecording(undefined);
                      }}
                      placeholder="Press shortcut"
                      readOnly
                      size="sm"
                    />
                  ) : (
                    <button
                      aria-label={`Change shortcut of ${titles.get(rule.command) ?? rule.command}`}
                      className="inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent px-1.5 outline-none transition-colors hover:border-border/70 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/24 sm:h-7"
                      onClick={() => setRecording(`${rule.command}|${rule.key}`)}
                      type="button"
                    >
                      <ShortcutPill shortcutKey={rule.key} />
                    </button>
                  )}
                </div>
              }
              description={
                <span className="flex h-6 items-center gap-1.5">
                  <span className="text-xs leading-none text-muted-foreground/70">When</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {rule.when ?? "Always"}
                  </span>
                </span>
              }
              key={`${rule.command}|${rule.key}|${rule.when ?? ""}`}
              title={
                <span className="flex items-center gap-1.5">
                  {titles.get(rule.command) ?? commandLabel(rule.command)}
                  {rule.source === "config" ? (
                    <Badge size="sm" variant="outline">
                      Custom
                    </Badge>
                  ) : null}
                </span>
              }
            />
          ))}
        </SettingsSection>
      ))}
      {rows.length === 0 ? (
        <SettingsSection title="Keybindings">
          <SettingsEmpty>No keybindings match your search.</SettingsEmpty>
        </SettingsSection>
      ) : null}
    </>
  );
}
