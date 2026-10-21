import { CONNECTIONS_CAPABILITY, SETTINGS_CAPABILITY } from "@jhin/client-api";
import { definePlugin, type Disposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";
import { SYNC_SECTION, SyncSettings } from "../lib/settings.ts";

/**
 * `jhin.device-sync`: this device's settings follow the owner's other
 * devices through every connected node (D487), unless "Sync settings across
 * devices" is off (D488). The work is in a chunk of its own (D440).
 */
export const deviceSyncPlugin = builtin(
  "jhin.device-sync",
  { requires: { [SETTINGS_CAPABILITY]: "^1.1", [CONNECTIONS_CAPABILITY]: "^1" } },
  definePlugin({
    activate(context) {
      context.config.define(SYNC_SECTION, SyncSettings);
      let stopped = false;
      let sync: Disposable | undefined;
      void import("./device-sync-engine.ts")
        .then(({ startDeviceSync }) => {
          if (!stopped) sync = startDeviceSync(context);
        })
        .catch((error: unknown) =>
          context.log.warn("device sync not started", { error: String(error) }),
        );
      context.subscriptions.add({
        dispose: () => {
          stopped = true;
          sync?.dispose();
        },
      });
    },
  }),
);
