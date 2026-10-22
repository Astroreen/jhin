// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): components/settings/NotificationSettings.tsx.
// A chunk of its own, loaded when the section first opens (D440, D1041).
import type { DeviceSettings } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch } from "@jhin/ui";
import { useState } from "react";

import { useConfig } from "../lib/hooks.ts";
import { SettingsRow, SettingsSection } from "../lib/settings-layout.tsx";
import { NOTIFICATIONS_SECTION as SECTION, type NotificationSettings } from "./notifications.tsx";

export function createNotificationsSettings(
  context: PluginContext,
  deviceSettings: DeviceSettings,
  playSound: (kind: "completion") => void,
) {
  return function NotificationsSettings() {
    const current = useConfig<NotificationSettings>(context, SECTION);
    const [message, setMessage] = useState<string | undefined>();
    const [requesting, setRequesting] = useState(false);
    const choose = async (mode: NotificationSettings["mode"]) => {
      setMessage(undefined);
      if (mode === "notifications" || mode === "notifications-and-sound") {
        if (typeof Notification === "undefined" || !window.isSecureContext) {
          setMessage(
            "Notifications need a supported browser over HTTPS (or localhost). Sound only is still available.",
          );
          return;
        }
        setRequesting(true);
        try {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {
            setMessage(
              "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
            );
            return;
          }
        } catch {
          setMessage(
            "Notifications are unavailable in this browser. Sound only is still available.",
          );
          return;
        } finally {
          setRequesting(false);
        }
      }
      if (mode !== "off") playSound("completion");
      deviceSettings.patch(SECTION, { mode });
    };
    const labels: Record<NotificationSettings["mode"], string> = {
      off: "Off",
      notifications: "Notifications only",
      sound: "Sound only",
      "notifications-and-sound": "Notifications with sound",
    };
    return (
      <SettingsSection title="Notifications">
        <SettingsRow
          control={
            <Select
              disabled={requesting}
              onValueChange={(value) => void choose(value as NotificationSettings["mode"])}
              value={current.mode}
            >
              <SelectTrigger aria-label="Thread notifications" className="w-full sm:w-56" size="sm">
                <SelectValue>{labels[current.mode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(labels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
          description={
            message ??
            "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while Jhin is open in the background."
          }
          title="Thread notifications"
        />
        <SettingsRow
          control={
            <Switch
              aria-label="In-app notifications"
              checked={current.inApp}
              onCheckedChange={(inApp) => deviceSettings.patch(SECTION, { inApp })}
            />
          }
          description="Show a toast when another thread finishes, fails, or needs input or approval while this page has focus."
          title="In-app notifications"
        />
        {/* What a choice came to, for screen readers too. */}
        <p aria-live="polite" className="sr-only" role="status">
          {message ?? ""}
        </p>
      </SettingsSection>
    );
  };
}
