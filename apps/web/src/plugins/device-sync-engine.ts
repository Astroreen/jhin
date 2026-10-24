import {
  CONNECTIONS_CAPABILITY,
  SETTINGS_CAPABILITY,
  type Connections,
  type DeviceSettings,
  type NodeConnection,
} from "@jhin/client-api";
import type { Disposable, PluginContext } from "@jhin/sdk";

import { HISTORY_CACHE_SECTION, readSection, SYNC_SECTION, SyncSettings } from "../lib/settings.ts";

/** A section of the device settings as a node keeps it (D487). */
interface Kept {
  readonly values: Readonly<Record<string, unknown>>;
  readonly at: number;
}

/**
 * The device settings to share: every section but `jhin.sync`, which says
 * what this device shares and so stays its own (D488), and
 * `jhin.history-cache`, which each device decides for itself (loading.md D1609).
 */
export function shared(section: string): boolean {
  return section !== SYNC_SECTION && section !== HISTORY_CACHE_SECTION;
}

/**
 * What to do with what a node keeps (D487): sections the node has later
 * than this device are taken; sections this device has later are sent.
 */
export function reconcile(
  kept: Readonly<Record<string, Kept>>,
  local: { sections: readonly string[]; changedAt(section: string): number | undefined },
): { take: string[]; send: string[] } {
  const take = Object.keys(kept).filter(
    (section) => shared(section) && kept[section]!.at > (local.changedAt(section) ?? -1),
  );
  const send = local.sections.filter((section) => {
    const at = local.changedAt(section);
    return shared(section) && at !== undefined && at > (kept[section]?.at ?? -1);
  });
  return { take, send };
}

/**
 * The device sync of `jhin.device-sync` (D487, D488): a chunk of its own, so
 * the page's entry stays small (D440). Undone by the returned disposable.
 */
export function startDeviceSync(context: PluginContext): Disposable {
  const subscriptions: Disposable[] = [];
  const add = <T extends Disposable>(item: T): T => {
    subscriptions.push(item);
    return item;
  };
  const settings = context.services.get<Required<DeviceSettings>>(SETTINGS_CAPABILITY);
  const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
  const enabled = () => readSection(context, SYNC_SECTION, SyncSettings).settings;
  const warn = (connection: NodeConnection, error: unknown) =>
    context.log.debug("device settings not shared with a node", {
      connection: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });

  const send = (connection: NodeConnection, section: string) => {
    const at = settings.changedAt(section);
    if (at === undefined) return;
    void connection.client
      .call("host.device-settings.patch", { section, values: settings.values(section), at })
      .catch((error: unknown) => warn(connection, error));
  };
  const take = (section: string, kept: Kept) => {
    if (!shared(section) || kept.at <= (settings.changedAt(section) ?? -1)) return;
    settings.apply(section, kept.values, kept.at);
  };
  /** Brings a node and this device level, both ways. */
  const level = async (connection: NodeConnection) => {
    if (!enabled()) return;
    try {
      const { sections: kept } = await connection.client.call<{
        sections: Record<string, Kept>;
      }>("host.device-settings.get", {});
      const plan = reconcile(kept, {
        sections: settings.sections(),
        changedAt: (section) => settings.changedAt(section),
      });
      for (const section of plan.take) take(section, kept[section]!);
      for (const section of plan.send) send(connection, section);
    } catch (error) {
      // An older node, or a token without host.device-settings: nothing to share there.
      warn(connection, error);
    }
  };

  /** Per connection client: its stream subscription, and whether it was open. */
  const followed = new Map<
    string,
    { client: NodeConnection["client"]; open: boolean; stop(): void }
  >();
  const sync = () => {
    const listed = connections.list();
    for (const [id, feed] of followed) {
      if (listed.find((connection) => connection.id === id)?.client === feed.client) continue;
      feed.stop();
      followed.delete(id);
    }
    for (const connection of listed) {
      let feed = followed.get(connection.id);
      if (feed === undefined) {
        const subscription = connection.client.subscribe(
          "host/device-settings",
          { onError: (error) => warn(connection, error) },
          (event) => {
            const change = event.payload as {
              section?: unknown;
              values?: unknown;
              at?: unknown;
            };
            if (
              !enabled() ||
              typeof change.section !== "string" ||
              typeof change.at !== "number" ||
              typeof change.values !== "object" ||
              change.values === null
            )
              return;
            take(change.section, {
              values: change.values as Record<string, unknown>,
              at: change.at,
            });
          },
        );
        feed = { client: connection.client, open: false, stop: () => subscription.dispose() };
        followed.set(connection.id, feed);
      }
      // Opened (again): what changed meanwhile, on either side, is levelled.
      const open = connection.state === "open";
      if (open && !feed.open) void level(connection);
      feed.open = open;
    }
  };
  sync();
  add(connections.subscribe(sync));
  add(
    settings.onDidChange(({ section, remote }) => {
      // Turned on: catch up with every node.
      if (section === SYNC_SECTION) {
        if (enabled()) for (const connection of connections.list()) void level(connection);
        return;
      }
      if (remote || !enabled()) return;
      for (const connection of connections.list())
        if (connection.state === "open") send(connection, section);
    }),
  );
  add({
    dispose: () => {
      for (const feed of followed.values()) feed.stop();
      followed.clear();
    },
  });
  return {
    dispose: () => {
      for (const item of subscriptions.splice(0).toReversed()) item.dispose();
    },
  };
}
