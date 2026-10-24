import { SETTINGS_CAPABILITY, type DeviceSettings } from "@jhin/client-api";
import { createKernel, type Kernel, type PluginSource } from "@jhin/kernel";
import { definePlugin, type LogFields, type Logger } from "@jhin/sdk";

import { builtin, type BuiltinPlugin } from "./lib/builtin.ts";
import { chatPlugin } from "./plugins/chat/index.tsx";
import { agentsViewPlugin } from "./plugins/agents/index.tsx";
import { civilizationPlugin } from "./plugins/civilization.tsx";
import { inboxPlugin } from "./plugins/inbox/index.tsx";
import { missionsViewPlugin } from "./plugins/missions/index.tsx";
import { teamsViewPlugin } from "./plugins/teams/index.tsx";
import { healthPlugin } from "./plugins/health/index.tsx";
import { historyCachePlugin } from "./plugins/history-cache/index.ts";
import { commandPalettePlugin } from "./plugins/command-palette.tsx";
import { connectionsPlugin } from "./plugins/connections.ts";
import { deviceSyncPlugin } from "./plugins/device-sync.ts";
import { inspectorPlugin } from "./plugins/inspector.tsx";
import { keybindingsPlugin } from "./plugins/keybindings.ts";
import { machinesPlugin } from "./plugins/machines.tsx";
import { meshPlugin } from "./plugins/mesh.ts";
import { modeSwitcherPlugin } from "./plugins/mode-switcher.tsx";
import { modesPlugin } from "./plugins/modes.ts";
import { navigationPlugin } from "./plugins/navigation.ts";
import { nodeConfigFeedPlugin } from "./plugins/node-config-feed.ts";
import { notificationsPlugin } from "./plugins/notifications.tsx";
import { schedulerPlugin } from "./plugins/scheduler/index.tsx";
import { settingsPlugin } from "./plugins/settings/index.tsx";
import { usagePlugin } from "./plugins/usage.tsx";
import { sidebarPlugin } from "./plugins/sidebar.tsx";
import { devicePanelPlugin } from "./plugins/devices/index.tsx";
import { htmlRenderViewPlugin } from "./plugins/html-render/index.tsx";
import { secretsViewPlugin } from "./plugins/secrets/index.tsx";
import { orchestrationViewPlugin } from "./plugins/orchestration/index.tsx";
import { previewPanelPlugin } from "./plugins/preview/index.tsx";
import { rightPanelPlugin } from "./plugins/right-panel/index.tsx";
import { sourceControlPlugin } from "./plugins/source-control/index.tsx";
import { terminalPlugin } from "./plugins/terminal/index.tsx";
import { threadWorkPlugin } from "./plugins/thread-work.ts";
import { threadsStorePlugin } from "./plugins/threads-store.ts";
import { uiHostPlugin } from "./plugins/ui-host.tsx";
import { visitsPlugin } from "./plugins/visits.ts";
import { threadActionsPlugin } from "./plugins/thread-actions.tsx";

/** The client's config layers: the node's (served with the page), then this device's. */
const CONFIG_LAYERS = ["distribution", "node", "device"] as const;
const DEVICE_STORAGE_KEY = "jhin.settings";
/** When each section of this device's layer last changed (D487). */
const DEVICE_TIMES_KEY = "jhin.settings.at";

function loadDeviceTimes(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DEVICE_TIMES_KEY) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

/** This device's layer, as kept in the browser; unreadable storage is an empty layer. */
function loadDeviceLayer(): Record<string, Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

/**
 * `jhin.client-host`: what the page itself offers plugins. It lives here
 * because it needs the kernel: this device's config layer (`client.settings@1`).
 */
function clientHostPlugin(kernel: () => Kernel): BuiltinPlugin {
  return builtin(
    "jhin.client-host",
    { provides: { [SETTINGS_CAPABILITY]: "1.1.0" } },
    definePlugin({
      activate(context) {
        let layer = loadDeviceLayer();
        let times = loadDeviceTimes();
        const listeners = new Set<(change: { section: string; remote: boolean }) => void>();
        const tell = (section: string, remote: boolean) => {
          for (const listener of Array.from(listeners)) {
            try {
              listener({ section, remote });
            } catch (error) {
              context.log.warn("device settings listener failed", { error: String(error) });
            }
          }
        };
        const write = (
          next: Record<string, Record<string, unknown>>,
          section?: string,
          change?: { at: number; remote: boolean },
        ) => {
          layer = next;
          if (section !== undefined) times = { ...times, [section]: change?.at ?? Date.now() };
          try {
            localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(layer));
            localStorage.setItem(DEVICE_TIMES_KEY, JSON.stringify(times));
          } catch (error) {
            context.log.warn("device settings not kept", { error: String(error) });
          }
          kernel().config.setLayer("device", layer);
          if (section !== undefined) tell(section, change?.remote ?? false);
        };
        const settings: DeviceSettings = {
          values: (section) => layer[section] ?? {},
          patch(section, values) {
            const next: Record<string, unknown> = { ...layer[section] };
            for (const [key, value] of Object.entries(values)) {
              if (value === undefined) delete next[key];
              else next[key] = value;
            }
            const { [section]: _previous, ...rest } = layer;
            write(Object.keys(next).length === 0 ? rest : { ...rest, [section]: next }, section);
          },
          reset(section) {
            const { [section]: _previous, ...rest } = layer;
            write(rest, section);
          },
          sections: () => [...new Set([...Object.keys(layer), ...Object.keys(times)])],
          changedAt: (section) => times[section],
          apply(section, values, at) {
            const { [section]: _previous, ...rest } = layer;
            write(
              Object.keys(values).length === 0 ? rest : { ...rest, [section]: { ...values } },
              section,
              { at, remote: true },
            );
          },
          onDidChange(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
          },
        };
        // Another tab changed this device's settings.
        const onStorage = (event: StorageEvent) => {
          if (event.key === DEVICE_TIMES_KEY) times = loadDeviceTimes();
          if (event.key !== DEVICE_STORAGE_KEY) return;
          layer = loadDeviceLayer();
          kernel().config.setLayer("device", layer);
        };
        window.addEventListener("storage", onStorage);
        context.subscriptions.add({
          dispose: () => window.removeEventListener("storage", onStorage),
        });
        context.services.provide(SETTINGS_CAPABILITY, settings);
      },
    }),
  );
}

/** The plugins every web client starts with; users replace or extend them (D15, D16). */
function builtinPlugins(kernel: () => Kernel): readonly BuiltinPlugin[] {
  return [
    clientHostPlugin(kernel),
    uiHostPlugin,
    keybindingsPlugin,
    connectionsPlugin,
    nodeConfigFeedPlugin,
    deviceSyncPlugin,
    navigationPlugin,
    modesPlugin,
    meshPlugin,
    threadsStorePlugin,
    historyCachePlugin,
    machinesPlugin,
    visitsPlugin,
    threadWorkPlugin,
    threadActionsPlugin,
    sidebarPlugin,
    chatPlugin,
    rightPanelPlugin,
    sourceControlPlugin,
    terminalPlugin,
    previewPanelPlugin,
    htmlRenderViewPlugin,
    secretsViewPlugin,
    orchestrationViewPlugin,
    devicePanelPlugin,
    commandPalettePlugin,
    settingsPlugin,
    usagePlugin,
    schedulerPlugin,
    notificationsPlugin,
    inspectorPlugin,
    modeSwitcherPlugin,
    civilizationPlugin,
    inboxPlugin,
    missionsViewPlugin,
    agentsViewPlugin,
    teamsViewPlugin,
    healthPlugin,
  ];
}

/** A client-side plugin served by the node that served this page. */
interface RemotePlugin {
  readonly manifest: { readonly id: string };
  readonly rev: number;
  /** `/client/plugins/<id>/<rev>/<entry>` */
  readonly entry: string;
}

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(path);
    return response.ok ? ((await response.json()) as T) : fallback;
  } catch {
    // No node behind this page (vp dev without a node, a static host): run with builtins only.
    return fallback;
  }
}

const builtinLocation = (id: string) => `builtin:${id}`;
const remoteLocation = (id: string) => `remote:${id}`;

/**
 * Starts the client-side kernel: the same kernel as a node's, with
 * `side: "client"`. Builtins come first; client plugins served by the node
 * are added, replacing a builtin with the same id (D15), reloaded when their
 * files change, and added or removed while the page is open (D16).
 */
export async function boot(): Promise<Kernel> {
  const remote = await fetchJson<RemotePlugin[]>("/client/plugins", []);
  let kernelRef: Kernel | undefined;
  const BUILTIN_PLUGINS = builtinPlugins(() => kernelRef!);
  const builtins = new Map(BUILTIN_PLUGINS.map((plugin) => [plugin.manifest.id, plugin]));
  const entries = new Map<string, string>();

  const kernel = createKernel({
    side: "client",
    configLayers: CONFIG_LAYERS,
    logger: consoleLogger({}),
    loader: {
      async load(source) {
        if (source.location.startsWith("builtin:")) {
          return { default: builtins.get(source.location.slice("builtin:".length))?.definition };
        }
        return import(/* @vite-ignore */ entries.get(source.location)!);
      },
    },
  });
  kernelRef = kernel;
  kernel.config.setLayer("node", await fetchJson("/client/config", {}));
  kernel.config.setLayer("device", loadDeviceLayer());

  await kernel.start(sourcesFor(BUILTIN_PLUGINS, remote, entries));
  if (typeof EventSource !== "undefined") followNode(kernel, builtins, entries, remote);
  return kernel;
}

/**
 * The page's plugins: builtins, then the node's client plugins; a node plugin
 * replaces a builtin with its id (D15), and without it the builtin is back.
 * Records each node plugin's entry URL for the loader.
 */
function sourcesFor(
  builtins: Iterable<BuiltinPlugin>,
  remote: readonly RemotePlugin[],
  entries: Map<string, string>,
): PluginSource[] {
  const remoteIds = new Set(remote.map((plugin) => plugin.manifest.id));
  return [
    ...[...builtins]
      .filter((plugin) => !remoteIds.has(plugin.manifest.id))
      .map((plugin) => ({
        location: builtinLocation(plugin.manifest.id),
        manifest: plugin.manifest,
      })),
    ...remote.map((plugin) => {
      const location = remoteLocation(plugin.manifest.id);
      entries.set(location, plugin.entry);
      return { location, manifest: plugin.manifest };
    }),
  ];
}

/**
 * Applies the node's change notifications: new plugin revisions, plugins
 * added or removed, and config. Changes are applied one at a time.
 */
function followNode(
  kernel: Kernel,
  builtins: ReadonlyMap<string, BuiltinPlugin>,
  entries: Map<string, string>,
  initial: readonly RemotePlugin[],
): void {
  /** The remote plugins as last applied, by id. */
  let known = new Map(initial.map((plugin) => [plugin.manifest.id, plugin]));
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue
      .then(work)
      .catch((error: unknown) =>
        console.error(
          "[jhin] applying a client plugin change failed; the next change retries",
          error,
        ),
      );
  };

  /**
   * Reloads a plugin at a new revision and records the revision as applied
   * only if the reload ran, so the next sync (a `plugins` event, a reconnect)
   * retries one that did not. The loader points at the new revision either
   * way: if anything restarts the plugin before then (a dependency's reload),
   * it loads the current files, which is what the retry would do too.
   */
  const reload = async (plugin: RemotePlugin) => {
    entries.set(remoteLocation(plugin.manifest.id), plugin.entry);
    try {
      await kernel.reload(plugin.manifest.id);
      known.set(plugin.manifest.id, plugin);
    } catch (error) {
      console.error(
        `[jhin] reloading ${plugin.manifest.id} failed; the next change or sync retries`,
        error,
      );
    }
  };

  /** Brings the kernel to the node's current list: adds, removes, replaces and reloads. */
  const sync = async () => {
    // A failed fetch throws: the queue logs it, and the next `plugins` or `open` event retries.
    const response = await fetch("/client/plugins");
    if (!response.ok) throw new Error(`GET /client/plugins: ${response.status}`);
    const list = (await response.json()) as RemotePlugin[];
    // `sourcesFor` points the loader at the new revisions before the update, on
    // purpose: any restart from here on must load the current files.
    // The kernel restarts what was added, removed or got another manifest (and dependants).
    const update = await kernel.update(sourcesFor(builtins.values(), list, entries));
    const restarted = new Set([...update.added, ...update.changed, ...update.started]);
    // Same manifest, new files: a reload, as for a `plugin` event.
    const previous = known;
    const listed = new Set(list.map((plugin) => plugin.manifest.id));
    for (const id of previous.keys()) if (!listed.has(id)) entries.delete(remoteLocation(id));
    known = new Map();
    for (const plugin of list) {
      const id = plugin.manifest.id;
      const had = previous.get(id);
      if (had === undefined || had.rev === plugin.rev || restarted.has(id)) {
        known.set(id, plugin);
      } else {
        // Recorded by `reload` once it ran; until then the old revision stands.
        known.set(id, had);
        await reload(plugin);
      }
    }
  };

  const refreshConfig = () =>
    void fetchJson("/client/config", {}).then((values) => kernel.config.setLayer("node", values));

  const events = new EventSource("/client/events");
  let opened = 0;
  // EventSource reconnects on its own; whatever changed while it was away is
  // caught up from the current state.
  events.addEventListener("open", () => {
    opened += 1;
    if (opened === 1) return;
    enqueue(sync);
    refreshConfig();
  });
  events.addEventListener("plugin", (message) => {
    const { id, rev } = JSON.parse(message.data) as { id: string; rev: number };
    enqueue(async () => {
      const plugin = known.get(id);
      // A plugin this page has not met yet: the list tells what it is.
      if (plugin === undefined) return sync();
      if (plugin.rev === rev) return;
      await reload({ ...plugin, rev, entry: plugin.entry.replace(REVISION, `$1${rev}/`) });
    });
  });
  events.addEventListener("plugins", () => enqueue(sync));
  events.addEventListener("config", refreshConfig);
}

/** The revision segment of a plugin file path: `/client/plugins/<id>/<rev>/`. */
const REVISION = /^(\/client\/plugins\/[^/]+\/)\d+\//;

/** The browser console as the client kernel's log; fields ride along as a second argument. */
function consoleLogger(base: LogFields): Logger {
  const write =
    (method: "debug" | "info" | "warn" | "error") => (message: string, fields?: LogFields) =>
      console[method](`[jhin] ${message}`, { ...base, ...fields });
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (fields) => consoleLogger({ ...base, ...fields }),
  };
}
