// Rows follow T3 Code's general and appearance settings (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/SettingsPanels.tsx and ThemeSettings.tsx.
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, cn } from "@jhin/ui";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { useConfig } from "../../lib/hooks.ts";
import {
  APPEARANCE_SECTION,
  CHAT_SECTION,
  ChatSettings,
  DIFF_SECTION,
  DiffSettings,
  useSection,
  type Appearance,
} from "../../lib/settings.ts";
import { SettingResetButton, SettingsRow, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <Select onValueChange={(value) => props.onChange(value as T)} value={props.value}>
      <SelectTrigger aria-label={props.label} className="w-full sm:w-44" size="sm">
        <SelectValue>
          {props.options.find((option) => option.value === props.value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function GeneralSection() {
  const { context, settings } = useSettingsServices();
  const chat = useSection(context, CHAT_SECTION, ChatSettings);
  const defaults = ChatSettings.parse({});
  const set = (values: Partial<ChatSettings>) => settings.patch(CHAT_SECTION, values);
  const reset = <K extends keyof ChatSettings>(key: K, label: string) =>
    chat[key] === defaults[key] ? null : (
      <SettingResetButton
        label={label}
        onClick={() => settings.patch(CHAT_SECTION, { [key]: undefined })}
      />
    );
  return (
    <>
      <SettingsSection title="Behavior">
        <SettingsRow
          control={
            <Choice
              label="Time format"
              onChange={(timestampFormat) => set({ timestampFormat })}
              options={[
                { value: "locale", label: "System default" },
                { value: "12-hour", label: "12-hour" },
                { value: "24-hour", label: "24-hour" },
              ]}
              value={chat.timestampFormat}
            />
          }
          description="How message times show in threads."
          resetAction={reset("timestampFormat", "time format")}
          title="Time format"
        />
        <SettingsRow
          control={
            <Choice
              label="Send shortcut"
              onChange={(sendShortcut) => set({ sendShortcut })}
              options={[
                { value: "enter", label: "Enter" },
                { value: "mod-enter", label: "⌘/Ctrl + Enter" },
              ]}
              value={chat.sendShortcut}
            />
          }
          description="Which key sends a message; the other inserts a new line with Shift."
          resetAction={reset("sendShortcut", "send shortcut")}
          title="Send shortcut"
        />
        <SettingsRow
          control={
            <Choice
              label="Follow-up behavior"
              onChange={(followUpBehavior) => set({ followUpBehavior })}
              options={[
                { value: "queue", label: "Queue" },
                { value: "steer", label: "Steer" },
              ]}
              value={chat.followUpBehavior}
            />
          }
          description={`Queue follow-ups while the agent runs or steer the current run. Press ${
            chat.sendShortcut === "mod-enter" ? "⌘/Ctrl + Shift + Enter" : "⌘/Ctrl + Enter"
          } to do the opposite for one message.`}
          resetAction={reset("followUpBehavior", "follow-up behavior")}
          title="Follow-up behavior"
        />
        <DiffRows />
      </SettingsSection>
      <SettingsSection title="Confirmations">
        <SettingsRow
          control={
            <Switch
              aria-label="Confirm archiving"
              checked={chat.confirmArchive}
              onCheckedChange={(confirmArchive) => set({ confirmArchive })}
            />
          }
          description="Ask before a thread is archived."
          title="Archive"
        />
        <SettingsRow
          control={
            <Switch
              aria-label="Confirm deleting"
              checked={chat.confirmDelete}
              onCheckedChange={(confirmDelete) => set({ confirmDelete })}
            />
          }
          description="Ask before a thread is deleted or a project removed."
          title="Delete"
        />
        <SettingsRow
          control={
            <Switch
              aria-label="Confirm thread unpinning"
              checked={chat.confirmUnpin}
              onCheckedChange={(confirmUnpin) => set({ confirmUnpin })}
            />
          }
          description="Ask before unpinning a thread from the pinned section."
          title="Unpin"
        />
      </SettingsSection>
    </>
  );
}

/** T3's diff rows: word wrap, whitespace, the default file state and the layout. */
function DiffRows() {
  const { context, settings } = useSettingsServices();
  const diff = useSection(context, DIFF_SECTION, DiffSettings);
  const defaults = DiffSettings.parse({});
  const set = (values: Partial<DiffSettings>) => settings.patch(DIFF_SECTION, values);
  const reset = <K extends keyof DiffSettings>(key: K, label: string) =>
    diff[key] === defaults[key] ? null : (
      <SettingResetButton
        label={label}
        onClick={() => settings.patch(DIFF_SECTION, { [key]: undefined })}
      />
    );
  return (
    <>
      <SettingsRow
        control={
          <Switch
            aria-label="Wrap diffs by default"
            checked={diff.wordWrap}
            onCheckedChange={(wordWrap) => set({ wordWrap })}
          />
        }
        description="Wrap long lines in diffs by default."
        resetAction={reset("wordWrap", "word wrap")}
        title="Word wrap"
      />
      <SettingsRow
        control={
          <Switch
            aria-label="Hide whitespace changes by default"
            checked={diff.ignoreWhitespace}
            onCheckedChange={(ignoreWhitespace) => set({ ignoreWhitespace })}
          />
        }
        description="Set whether the diff panel ignores whitespace-only edits by default."
        resetAction={reset("ignoreWhitespace", "diff whitespace changes")}
        title="Hide whitespace changes"
      />
      <SettingsRow
        control={
          <Choice
            label="Default diff file state"
            onChange={(state) => set({ filesCollapsed: state === "collapsed" })}
            options={[
              { value: "expanded", label: "Expanded" },
              { value: "collapsed", label: "Collapsed" },
            ]}
            value={diff.filesCollapsed ? "collapsed" : "expanded"}
          />
        }
        description="Start with files expanded or collapsed when opening diffs."
        resetAction={reset("filesCollapsed", "default diff file state")}
        title="Default diff file state"
      />
      <SettingsRow
        control={
          <Choice
            label="Diff layout"
            onChange={(layout) => set({ layout })}
            options={[
              { value: "stacked", label: "Stacked" },
              { value: "split", label: "Split" },
            ]}
            value={diff.layout}
          />
        }
        description="Show diffs stacked or side by side. The toggle in the diff toolbar changes this too."
        resetAction={reset("layout", "diff layout")}
        title="Diff layout"
      />
    </>
  );
}

const MODES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

function ModePreview({ mode }: { mode: "system" | "light" | "dark" }) {
  const pane = (dark: boolean) => (
    <div className={cn("flex h-full flex-1 gap-1 p-1.5", dark ? "bg-neutral-900" : "bg-zinc-50")}>
      <div className={cn("w-1/4 rounded-sm", dark ? "bg-neutral-800" : "bg-zinc-200")} />
      <div className="flex flex-1 flex-col justify-end gap-1">
        <div
          className={cn("ms-auto h-2 w-1/2 rounded-sm", dark ? "bg-neutral-700" : "bg-zinc-200")}
        />
        <div className={cn("h-2 w-3/4 rounded-sm", dark ? "bg-neutral-800" : "bg-zinc-100")} />
        <div
          className={cn(
            "h-4 rounded-md border",
            dark ? "border-neutral-700 bg-neutral-800" : "border-zinc-200 bg-white",
          )}
        />
      </div>
    </div>
  );
  return (
    <div className="flex h-24 overflow-hidden rounded-lg border border-border/70">
      {mode === "dark" ? (
        pane(true)
      ) : mode === "light" ? (
        pane(false)
      ) : (
        <>
          {pane(false)}
          {pane(true)}
        </>
      )}
    </div>
  );
}

export function AppearanceSection() {
  const { context, settings } = useSettingsServices();
  const appearance = useConfig<Appearance>(context, APPEARANCE_SECTION);
  return (
    <>
      <SettingsSection title="Colors">
        <div className="px-3 py-3 sm:px-4">
          <div aria-label="Appearance mode" className="grid w-full grid-cols-3 gap-3" role="group">
            {MODES.map((option) => {
              const active = appearance.mode === option.value;
              const Icon = option.icon;
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    active
                      ? "border-transparent bg-accent/30"
                      : "border-border/70 bg-card/60 hover:bg-accent/10",
                  )}
                  key={option.value}
                  onClick={() => settings.patch(APPEARANCE_SECTION, { mode: option.value })}
                  style={active ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
                  type="button"
                >
                  <ModePreview mode={option.value} />
                  <span className="flex items-center justify-center gap-1.5 text-xs font-medium">
                    <Icon className="size-3.5" />
                    {option.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Interface">
        <SettingsRow
          control={
            <Choice
              label="Chat width"
              onChange={(chatWidth) => settings.patch(APPEARANCE_SECTION, { chatWidth })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "wide", label: "Wide" },
                { value: "full", label: "Full width" },
              ]}
              value={appearance.chatWidth}
            />
          }
          description="How wide messages and the composer are."
          resetAction={
            appearance.chatWidth === "comfortable" ? null : (
              <SettingResetButton
                label="chat width"
                onClick={() => settings.patch(APPEARANCE_SECTION, { chatWidth: undefined })}
              />
            )
          }
          title="Chat width"
        />
      </SettingsSection>
    </>
  );
}
