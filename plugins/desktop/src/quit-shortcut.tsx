// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/QuitHoldOverlay.tsx
// and the "Quit shortcut" row of components/settings/SettingsPanels.tsx.
import type { DesktopBridge, QuitConfirmationMode } from "@jhin/desktop-api";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  SettingResetButton,
  SettingsRow,
} from "@jhin/ui";
import { useEffect, useState } from "react";

const HOLD_HINT_LINGER_MS = 1200;

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

const isMac = (platform: string) => platform === "darwin";

/** T3's hint while ⌘/Ctrl+Q is down (D947): hold, or press again, to quit. */
export function QuitHoldOverlay(props: { readonly bridge: DesktopBridge }) {
  const { bridge } = props;
  const [visibleMode, setVisibleMode] = useState<"hold" | "double-click" | null>(null);

  useEffect(() => {
    const subscribe = bridge.onQuitShortcut;
    if (!subscribe) return;
    let hideTimer: number | undefined;
    let pressedMode: "hold" | "double-click" = "hold";
    const unsubscribe = subscribe((hint) => {
      window.clearTimeout(hideTimer);
      if (hint.state === "down") {
        pressedMode = hint.mode;
        setVisibleMode(hint.mode);
        return;
      }
      if (pressedMode === "double-click") {
        setVisibleMode(null);
        return;
      }
      hideTimer = window.setTimeout(() => setVisibleMode(null), HOLD_HINT_LINGER_MS);
    });
    return () => {
      window.clearTimeout(hideTimer);
      unsubscribe();
    };
  }, [bridge]);

  if (!visibleMode) return null;
  const shortcut = isMac(bridge.platform) ? "⌘Q" : "Ctrl+Q";
  const message =
    visibleMode === "hold"
      ? `Hold ${shortcut} or press twice to quit`
      : `Press ${shortcut} again to quit`;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      <div className="rounded-full bg-foreground/95 px-8 py-4 text-2xl font-bold text-background shadow-xl">
        {message}
      </div>
    </div>
  );
}

/** T3's "Quit shortcut" row of the General settings (D947). */
export function QuitShortcutRow(props: {
  readonly bridge: DesktopBridge;
  /** Resolves with the mode now set, or null when setting it failed (and was reported). */
  readonly set: (mode: QuitConfirmationMode) => Promise<QuitConfirmationMode | null>;
  readonly defaultMode: QuitConfirmationMode;
}) {
  const { bridge, set, defaultMode } = props;
  const [mode, setMode] = useState<QuitConfirmationMode | null>(null);
  useEffect(() => {
    let live = true;
    bridge.getQuitShortcut?.().then(
      (value) => {
        if (live) setMode(value);
      },
      // Without the current mode the row stays hidden rather than guessing.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  if (mode === null) return null;
  const choose = (value: QuitConfirmationMode) => {
    void set(value).then((now) => {
      if (now !== null) setMode(now);
    });
  };
  return (
    <SettingsRow
      control={
        <Select
          onValueChange={(value) => {
            if (value === "direct" || value === "hold" || value === "double-click") choose(value);
          }}
          value={mode}
        >
          <SelectTrigger aria-label="Quit shortcut behavior" className="w-full sm:w-40" size="sm">
            <SelectValue>{QUIT_CONFIRMATION_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
      description="Hold mode also quits on two quick presses."
      resetAction={
        mode === defaultMode ? null : (
          <SettingResetButton label="quit shortcut behavior" onClick={() => choose(defaultMode)} />
        )
      }
      title="Quit shortcut"
    />
  );
}
