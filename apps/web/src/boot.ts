import { createKernel, type Kernel, type PluginSource } from "@jhin/kernel";
import type { LogFields, Logger } from "@jhin/sdk";

import type { BuiltinPlugin } from "./lib/builtin.ts";
import { chatPlugin } from "./plugins/chat.tsx";
import { connectionsPlugin } from "./plugins/connections.ts";
import { inspectorPlugin } from "./plugins/inspector.tsx";
import { navigationPlugin } from "./plugins/navigation.ts";
import { sidebarPlugin } from "./plugins/sidebar.tsx";
import { uiHostPlugin } from "./plugins/ui-host.tsx";

/** The plugins every web client starts with; users replace or extend them (D15, D16). */
const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  uiHostPlugin,
  connectionsPlugin,
  navigationPlugin,
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

/**
 * Starts the client-side kernel: the same kernel as a node's, with
 * `side: "client"`. Builtins come first; client plugins served by the node
 * are added, replacing a builtin with the same id (D15), and reloaded when
 * their files change (D16).
 */
export async function boot(): Promise<Kernel> {
  const remote = await fetchJson<RemotePlugin[]>("/client/plugins", []);
  const remoteIds = new Set(remote.map((plugin) => plugin.manifest.id));
  const builtins = BUILTIN_PLUGINS.filter((plugin) => !remoteIds.has(plugin.manifest.id));
  const definitions = new Map(
    builtins.map((plugin) => [`builtin:${plugin.manifest.id}`, plugin.definition]),
  );
  const entries = new Map(remote.map((plugin) => [`remote:${plugin.manifest.id}`, plugin.entry]));

  const kernel = createKernel({
    side: "client",
    logger: consoleLogger({}),
    loader: {
      async load(source) {
        const builtin = definitions.get(source.location);
        if (builtin !== undefined) return { default: builtin };
        return import(/* @vite-ignore */ entries.get(source.location)!);
      },
    },
  });
  kernel.config.setLayer("node", await fetchJson("/client/config", {}));

  const sources: PluginSource[] = [
    ...builtins.map((plugin) => ({
      location: `builtin:${plugin.manifest.id}`,
      manifest: plugin.manifest,
    })),
    ...remote.map((plugin) => ({
      location: `remote:${plugin.manifest.id}`,
      manifest: plugin.manifest,
    })),
  ];
  await kernel.start(sources);
  if (typeof EventSource !== "undefined") followNode(kernel, entries);
  return kernel;
}

/** Applies the node's change notifications: new plugin revisions and config. */
function followNode(kernel: Kernel, entries: Map<string, string>): void {
  const revisionPath = /^(\/client\/plugins\/[^/]+\/)\d+\//;
  const apply = (id: string, rev: number) => {
    const current = entries.get(`remote:${id}`);
    if (current === undefined) return;
    const next = current.replace(revisionPath, `$1${rev}/`);
    if (next === current) return;
    entries.set(`remote:${id}`, next);
    void kernel
      .reload(id)
      .catch((error: unknown) => console.error(`[jhin] reloading ${id} failed`, error));
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
    void fetchJson<RemotePlugin[]>("/client/plugins", []).then((plugins) => {
      for (const plugin of plugins) apply(plugin.manifest.id, plugin.rev);
    });
    refreshConfig();
  });
  events.addEventListener("plugin", (message) => {
    const { id, rev } = JSON.parse(message.data) as { id: string; rev: number };
    apply(id, rev);
  });
  events.addEventListener("config", refreshConfig);
}

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
