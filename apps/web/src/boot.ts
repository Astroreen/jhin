import { createKernel, type Kernel, type PluginSource } from "@jhin/kernel";
import type { LogFields, Logger } from "@jhin/sdk";

import type { BuiltinPlugin } from "./lib/builtin.ts";
import { chatPlugin } from "./plugins/chat.tsx";
import { connectionsPlugin } from "./plugins/connections.ts";
import { inspectorPlugin } from "./plugins/inspector.tsx";
import { meshPlugin } from "./plugins/mesh.ts";
import { navigationPlugin } from "./plugins/navigation.ts";
import { sidebarPlugin } from "./plugins/sidebar.tsx";
import { uiHostPlugin } from "./plugins/ui-host.tsx";

/** The plugins every web client starts with; users replace or extend them (D15, D16). */
const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  uiHostPlugin,
  connectionsPlugin,
  navigationPlugin,
  meshPlugin,
  sidebarPlugin,
  chatPlugin,
  inspectorPlugin,
];

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
  const builtins = new Map(BUILTIN_PLUGINS.map((plugin) => [plugin.manifest.id, plugin]));
  const entries = new Map<string, string>();

  const kernel = createKernel({
    side: "client",
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
  kernel.config.setLayer("node", await fetchJson("/client/config", {}));

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
   * retries one that did not.
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
