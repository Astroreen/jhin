import type { DeviceSettings } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { Switch } from "@jhin/ui";
import { useEffect, useState } from "react";

import { formatAttachmentSize } from "../../lib/attachment-files.ts";
import { HISTORY_CACHE_SECTION, HistoryCacheSettings, useSection } from "../../lib/settings.ts";
import { SettingsRow } from "../../lib/settings-layout.tsx";

interface Status {
  readonly entries: number;
  readonly bytes: number;
}

/**
 * "Keep chat history on this device" (loading.md D1592, D1594), a row of the
 * general settings' Behavior section. Turning it off deletes what is kept at
 * once; the row says how much is kept and that it is not encrypted.
 */
export function historyCacheRow(context: PluginContext, settings: DeviceSettings) {
  return function HistoryCacheRow() {
    const { enabled } = useSection(context, HISTORY_CACHE_SECTION, HistoryCacheSettings);
    const [status, setStatus] = useState<Status | undefined>();
    const [read, setRead] = useState(0);
    useEffect(() => {
      let current = true;
      void (context.commands.execute("history-cache.status", {}) as Promise<Status>)
        .then((next) => current && setStatus(next))
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [enabled, read]);
    const set = (checked: boolean) => {
      settings.patch(HISTORY_CACHE_SECTION, { enabled: checked });
      if (checked) return;
      // Deleted at once, and the row shows it gone.
      void context.commands
        .execute("history-cache.clear", {})
        .catch(() => undefined)
        .finally(() => setRead((count) => count + 1));
    };
    const kept =
      enabled && status !== undefined && status.entries > 0
        ? ` Now ${status.entries} ${status.entries === 1 ? "thread" : "threads"}, about ${formatAttachmentSize(status.bytes)}.`
        : "";
    return (
      <SettingsRow
        control={
          <Switch
            aria-label="Keep chat history on this device"
            checked={enabled}
            onCheckedChange={set}
          />
        }
        description={`Threads open from what this device already received and load only what is new. It is stored unencrypted in this browser profile: anyone with access to it can read the chats. Turning this off deletes it.${kept}`}
        title="Keep chat history on this device"
      />
    );
  };
}
