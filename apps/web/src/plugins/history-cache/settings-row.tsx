import type { DeviceSettings } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { Switch } from "@jhin/ui";
import { useEffect, useState } from "react";

import { formatAttachmentSize } from "../../lib/attachment-files.ts";
import { HISTORY_CACHE_SECTION, HistoryCacheSettings, useSection } from "../../lib/settings.ts";
import { SettingsRow } from "../../lib/settings-layout.tsx";
import type { HistoryCacheControl } from "./service.ts";

interface Status {
  /** False while the setting is on means the cache stopped over the quota (D1593). */
  readonly enabled: boolean;
  readonly entries: number;
  readonly bytes: number;
}

/**
 * "Keep chat history on this device" (loading.md D1592, D1594), a row of the
 * general settings' Behavior section. Turning it off deletes what is kept at
 * once; the row says how much is kept and that it is not encrypted.
 */
export function historyCacheRow(
  context: PluginContext,
  settings: DeviceSettings,
  cache: Pick<HistoryCacheControl, "onCleared">,
) {
  return function HistoryCacheRow() {
    const { enabled } = useSection(context, HISTORY_CACHE_SECTION, HistoryCacheSettings);
    const [status, setStatus] = useState<Status | undefined>();
    const [read, setRead] = useState(0);
    // The plugin clears once the setting is off; the row reads again after it did.
    useEffect(() => {
      const watching = cache.onCleared(() => setRead((count) => count + 1));
      return () => watching.dispose();
    }, []);
    useEffect(() => {
      let current = true;
      void (context.commands.execute("history-cache.status", {}) as Promise<Status>)
        .then((next) => current && setStatus(next))
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [enabled, read]);
    const set = (checked: boolean) => settings.patch(HISTORY_CACHE_SECTION, { enabled: checked });
    const kept =
      status === undefined
        ? ""
        : enabled && !status.enabled
          ? " Paused for this session: this browser has no room left for it, so threads load from their nodes."
          : status.entries === 0
            ? " Nothing is kept now."
            : enabled
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
