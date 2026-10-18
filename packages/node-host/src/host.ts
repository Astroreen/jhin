import * as AsyncHooks from "node:async_hooks";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  createKernel,
  parseConfigText,
  toErrorInfo,
  type Kernel,
  type KernelEvent,
  type KernelSnapshot,
  type ModuleLoader,
  type PluginSource,
  type PluginsUpdate,
} from "@jhin/kernel";
import {
  HOST_IDENTITY_CAPABILITY,
  HOST_PATHS_CAPABILITY,
  HOST_PLUGINS_CAPABILITY,
  HOST_TRACE_CAPABILITY,
  type HostPaths,
  type HostPlugins,
  type HostTrace,
} from "@jhin/host-api";
import {
  definePlugin,
  DOTTED_ID,
  PLUGIN_API_VERSION,
  z,
  type Disposable,
  type Logger,
} from "@jhin/sdk";
import { applyEdits, modify } from "jsonc-parser";

import {
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginLayers,
  type Shadowed,
} from "./discover.ts";
import { readNodeId, resolveHome, type JhinHome } from "./home.ts";
import { createFileModuleLoader } from "./loader.ts";
import { createNodeLogger, type NodeLogger } from "./logger.ts";
import { watch, type WatchTarget } from "./watcher.ts";

export interface NodeHostOptions {
  /** Jhin home directory; defaults to `$JHIN_HOME` or `~/.jhin`. */
  readonly home?: string;
  /** Project directory; its `.jhin/` holds workspace plugins and config. */
  readonly cwd?: string;
  /** Package directories of the distribution plugins. */
  readonly distribution?: readonly string[];
  readonly dev?: readonly string[];
  /**
   * Reload plugins and config when their files change (D14), and re-resolve the
   * plugin graph when a manifest changes or a plugin is added to or removed from
   * the user or workspace plugin directory (D15).
   */
  readonly watch?: boolean;
  readonly logLevel?: string;
}

export interface NodeInspection {
  readonly nodeId: string;
  readonly home: string;
  readonly logFile: string;
  readonly kernel: KernelSnapshot;
  readonly shadowed: readonly Shadowed[];
  readonly recentEvents: readonly KernelEvent[];
}

export interface NodeHost {
  readonly nodeId: string;
  readonly home: JhinHome;
  readonly kernel: Kernel;
  readonly log: NodeLogger;
  inspect(): NodeInspection;
  stop(): Promise<void>;
}

const HOST_PLUGIN = "jhin.host";
/** How far ahead of this node's clock a config change time may be (D50). */
const MAX_CONFIG_SKEW_MS = 60 * 60 * 1000;
const HOST_LOCATION = "host://jhin.host";
const RECENT_EVENTS = 100;

/** The layer in `file`; `undefined` when it cannot be parsed (the caller keeps the previous layer). */
function readLayer(file: string, log: Logger): Record<string, unknown> | undefined {
  if (!Fs.existsSync(file)) return {};
  try {
    return parseConfigText(Fs.readFileSync(file, "utf8"), file);
  } catch (error) {
    log.error("config file not applied; keeping the previous values", {
      file,
      error: toErrorInfo(error),
    });
    return undefined;
  }
}

function applyLayer(kernel: Kernel, layer: string, file: string, log: Logger): void {
  const values = readLayer(file, log);
  if (values === undefined) kernel.events.emit("host.config.rejected", { layer, file });
  else kernel.config.setLayer(layer, values);
}

function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  Fs.writeFileSync(temporary, text);
  Fs.renameSync(temporary, file);
}

/** Boots a server-side kernel over the plugins found on disk. */
export async function startNodeHost(options: NodeHostOptions = {}): Promise<NodeHost> {
  const home = resolveHome(options.home);
  const nodeId = readNodeId(home);
  const traces = new AsyncHooks.AsyncLocalStorage<string>();
  const trace: HostTrace = {
    run: (traceId, work) => traces.run(traceId, work),
    current: () => traces.getStore(),
  };
  const log = createNodeLogger({
    logsDir: home.logs,
    nodeId,
    mixin: () => {
      const traceId = traces.getStore();
      return traceId === undefined ? {} : { traceId };
    },
    ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
  });
  const cwd = options.cwd ?? process.cwd();
  const projectConfig = Path.join(cwd, ".jhin", "config.jsonc");
  const layers: PluginLayers = {
    distribution: options.distribution ?? [],
    user: home.plugins,
    workspace: Path.join(cwd, ".jhin", "plugins"),
    dev: options.dev ?? [],
  };
  let discovery = discoverPlugins(layers);

  const recentEvents: KernelEvent[] = [];
  const pluginListeners = new Set<
    (change: { readonly id: string; readonly files: readonly string[] }) => void
  >();
  // Assigned right after the kernel exists; the host plugin only runs after that.
  let kernel!: Kernel;

  const hostPlugin = definePlugin({
    activate(context) {
      const paths: HostPaths = {
        home: home.root,
        dataDir(plugin) {
          if (!DOTTED_ID.test(plugin)) {
            throw new Error(`dataDir needs a plugin id, got ${JSON.stringify(plugin)}`);
          }
          const dir = Path.join(home.root, "data", plugin);
          Fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
      };
      context.services.provide(HOST_PATHS_CAPABILITY, paths);
      context.services.provide(HOST_TRACE_CAPABILITY, trace);
      context.services.provide(HOST_IDENTITY_CAPABILITY, { nodeId });
      const plugins: HostPlugins = {
        list: () =>
          discovery.plugins.flatMap((plugin) => {
            const id = (plugin.manifest as { id?: unknown } | undefined)?.id;
            return typeof id === "string"
              ? [{ id, manifest: plugin.manifest, root: plugin.root, layer: plugin.layer }]
              : [];
          }),
        onChange(listener) {
          pluginListeners.add(listener);
          return { dispose: () => pluginListeners.delete(listener) };
        },
      };
      context.services.provide(HOST_PLUGINS_CAPABILITY, plugins);
      context.commands.register({
        name: "host.inspect",
        description:
          "Live state of this node: plugins, services, commands, hooks, config and recent events",
        input: z.object({}),
        output: z.unknown(),
        permissions: ["host.inspect"],
        handler: () => inspect(),
      });
      context.commands.register({
        name: "host.commands.list",
        description: "Every command on this node, with JSON Schemas of input and output",
        input: z.object({}),
        output: z.unknown(),
        handler: () => context.commands.list(),
      });
      context.commands.register({
        name: "host.config.patch",
        description:
          "Changes this node's node or project config file, keeping its comments; refuses a change older than the last one (D50)",
        input: z.object({
          layer: z.enum(["node", "project"]),
          section: z.string().regex(DOTTED_ID),
          values: z.record(z.string(), z.unknown()),
          /** When the change was made (ms); later changes win. Defaults to now. */
          at: z.number().int().nonnegative().optional(),
        }),
        output: z.object({
          applied: z.boolean(),
          at: z.number(),
          conflict: z.object({ localAt: z.number() }).optional(),
        }),
        permissions: ["host.config.write"],
        handler: ({ layer, section, values, at }) =>
          patchConfig(layer, section, values, at ?? Date.now()),
      });
      context.commands.register({
        name: "host.plugins.rescan",
        description:
          "Finds plugins on disk again: activates added ones, stops removed ones and re-resolves changed manifests with everything depending on them",
        input: z.object({}),
        output: z.object({
          added: z.array(z.string()).readonly(),
          removed: z.array(z.string()).readonly(),
          changed: z.array(z.string()).readonly(),
          stopped: z.array(z.string()).readonly(),
          started: z.array(z.string()).readonly(),
          invalid: z.array(z.string()).readonly(),
        }),
        permissions: ["host.plugins.reload"],
        handler: () => rescan(),
      });
      context.commands.register({
        name: "host.plugins.reload",
        description: "Re-imports a plugin and re-activates it with everything depending on it",
        input: z.object({ plugin: z.string() }),
        output: z.object({ plugin: z.string() }),
        permissions: ["host.plugins.reload"],
        handler: async ({ plugin }) => {
          await kernel.reload(plugin);
          return { plugin };
        },
      });
    },
  });

  const fileLoader = createFileModuleLoader();
  const loader: ModuleLoader = {
    load: (source, manifest, generation) =>
      source.location === HOST_LOCATION
        ? Promise.resolve({ default: hostPlugin })
        : fileLoader.load(source, manifest, generation),
  };
  kernel = createKernel({ side: "server", loader, logger: log });
  kernel.events.onAny((event) => {
    recentEvents.push(event);
    if (recentEvents.length > RECENT_EVENTS) recentEvents.shift();
  });

  applyLayer(kernel, "node", home.config, log);
  applyLayer(kernel, "project", projectConfig, log);

  const hostSource: PluginSource = {
    location: HOST_LOCATION,
    manifest: {
      id: HOST_PLUGIN,
      version: "0.0.0",
      apiVersion: PLUGIN_API_VERSION,
      side: "server",
      provides: {
        [HOST_PATHS_CAPABILITY]: "1.0.0",
        [HOST_TRACE_CAPABILITY]: "1.0.0",
        [HOST_PLUGINS_CAPABILITY]: "1.0.0",
        [HOST_IDENTITY_CAPABILITY]: "1.0.0",
      },
      entry: "host",
    },
  };
  await kernel.start([hostSource, ...discovery.plugins]);

  const notifyPlugin = (id: string, files: readonly string[]) => {
    for (const listener of Array.from(pluginListeners)) {
      // One failing listener must not stop the others, nor fail the change that was applied.
      try {
        listener({ id, files });
      } catch (error) {
        log.error("host.plugins listener failed", { plugin: id, error: toErrorInfo(error) });
      }
    }
  };

  let rescans: Promise<unknown> = Promise.resolve();
  /**
   * Discovers plugins again and applies the differences to the running kernel.
   * Rescans run one at a time, so each discovers after the previous one applied
   * and the last one leaves `discovery` and the watchers matching the kernel.
   */
  function rescan(): Promise<PluginsUpdate> {
    const run = rescans.then(rescanNow, rescanNow);
    rescans = run.catch(() => undefined);
    return run;
  }

  async function rescanNow(): Promise<PluginsUpdate> {
    const previous = discovery.plugins;
    const next = discoverPlugins(layers);
    const found = next.plugins;
    const update = await kernel.update([hostSource, ...found]);
    // Only what the kernel applied becomes the discovery the watchers follow.
    discovery = next;
    rewatch();
    // Client plugins are skipped here; listeners (the web UI) tell their clients.
    // A removed plugin is reported with its former manifest file.
    for (const [ids, plugins] of [
      [[...update.added, ...update.changed], found],
      [update.removed, previous],
    ] as const) {
      for (const id of ids) {
        const plugin = plugins.find(
          (candidate) => (candidate.manifest as { id?: unknown } | undefined)?.id === id,
        );
        if (plugin !== undefined) notifyPlugin(id, [Path.join(plugin.root, "package.json")]);
      }
    }
    return update;
  }

  /** Last write time per layer and section, so a stale change from elsewhere can lose (D50). */
  const writesFile = Path.join(home.root, "config-writes.json");
  function patchConfig(
    layer: "node" | "project",
    section: string,
    values: Record<string, unknown>,
    at: number,
  ): { applied: boolean; at: number; conflict?: { localAt: number } } {
    let writes: Record<string, Record<string, number>> = {};
    try {
      if (Fs.existsSync(writesFile))
        writes = JSON.parse(Fs.readFileSync(writesFile, "utf8")) as typeof writes;
    } catch (error) {
      // A damaged record of write times must not block every later change.
      log.warn("config write times unreadable; starting over", {
        file: writesFile,
        error: String(error),
      });
    }
    // A time far ahead would lock the section against every later change.
    if (at > Date.now() + MAX_CONFIG_SKEW_MS) {
      throw Object.assign(
        new Error(`Change time ${at} is more than an hour ahead of this node's clock`),
        {
          code: "CONFIG_TIME_IN_FUTURE",
        },
      );
    }
    const localAt = writes[layer]?.[section];
    if (localAt !== undefined && at < localAt) return { applied: false, at, conflict: { localAt } };

    const file = layer === "node" ? home.config : projectConfig;
    let text = Fs.existsSync(file) ? Fs.readFileSync(file, "utf8") : "{}\n";
    for (const [key, value] of Object.entries(values)) {
      text = applyEdits(
        text,
        modify(text, [section, key], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    }
    Fs.mkdirSync(Path.dirname(file), { recursive: true });
    // Times first, then the file, each replaced atomically: a crash in between
    // can only make a later stale change lose, never win.
    writes[layer] = { ...writes[layer], [section]: at };
    writeAtomically(writesFile, `${JSON.stringify(writes, null, 2)}\n`);
    writeAtomically(file, text);
    applyLayer(kernel, layer, file, log);
    return { applied: true, at };
  }

  function inspect(): NodeInspection {
    return {
      nodeId,
      home: home.root,
      logFile: log.file,
      kernel: kernel.inspect(),
      shadowed: discovery.shadowed,
      recentEvents: [...recentEvents],
    };
  }

  /** Live watchers by target key; see `watchTargets`. */
  const watchers = new Map<string, Disposable>();
  let stopping = false;
  const locations = [layers.user, layers.workspace].filter((dir) => dir !== undefined);
  /**
   * Starts watchers for new targets and stops those of targets that are gone.
   * The others keep running, so their pending changes are not lost.
   */
  function rewatch(): void {
    if (options.watch !== true || stopping) return;
    const targets = watchTargets({
      kernel,
      plugins: discovery.plugins,
      locations,
      home,
      projectConfig,
      log,
      notify: notifyPlugin,
      rescan,
      hasOwnWatcher: (location) =>
        discovery.plugins.some(
          (plugin) =>
            plugin.location === location &&
            typeof (plugin.manifest as { id?: unknown } | undefined)?.id === "string",
        ),
    });
    for (const [key, watcher] of watchers) {
      if (targets.has(key)) continue;
      watcher.dispose();
      watchers.delete(key);
    }
    for (const [key, target] of targets) {
      if (!watchers.has(key)) watchers.set(key, watch([target], log));
    }
  }
  rewatch();

  return {
    nodeId,
    home,
    kernel,
    log,
    inspect,
    async stop() {
      stopping = true;
      for (const watcher of watchers.values()) watcher.dispose();
      watchers.clear();
      // A rescan already queued applies before the kernel stops, not after.
      await rescans;
      await kernel.stop();
      log.flush();
    },
  };
}

interface WatchFilesOptions {
  readonly kernel: Kernel;
  readonly plugins: readonly DiscoveredPlugin[];
  /** Directories whose subdirectories are plugins (D15): watched for plugins coming and going. */
  readonly locations: readonly string[];
  readonly home: JhinHome;
  readonly projectConfig: string;
  readonly log: Logger;
  readonly notify: (id: string, files: readonly string[]) => void;
  readonly rescan: () => Promise<PluginsUpdate>;
  /** Whether the plugin directory at `location` has a watcher of its own (it was discovered). */
  readonly hasOwnWatcher: (location: string) => boolean;
}

/** What to watch, by a key that changes when the target must be watched anew. */
function watchTargets({
  kernel,
  plugins,
  locations,
  home,
  projectConfig,
  log,
  notify,
  rescan,
  hasOwnWatcher,
}: WatchFilesOptions): Map<string, WatchTarget> {
  const rescanQuietly = (reason: string) =>
    rescan().catch((error: unknown) => {
      log.error("plugin rescan failed", { reason, error: toErrorInfo(error) });
      return undefined;
    });
  const reload = (id: string, files: readonly string[], notified = false) => {
    if (!notified) notify(id, files);
    // Client-side plugins are skipped by this kernel; their clients reload them.
    // A blocked plugin cannot run whatever its code; a failed one is retried.
    const status = kernel.inspect().plugins.find((candidate) => candidate.id === id)?.status;
    if (status === undefined || status === "skipped" || status === "blocked") return;
    log.info("plugin files changed, reloading", { plugin: id, files });
    kernel.reload(id).catch((error: unknown) => {
      log.error("plugin reload failed", { plugin: id, error: toErrorInfo(error) });
    });
  };
  const targets = new Map<string, WatchTarget>();
  for (const plugin of plugins) {
    const id = (plugin.manifest as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") continue;
    const manifestFile = Path.join(plugin.root, "package.json");
    targets.set(`plugin:${id}:${plugin.root}`, {
      path: plugin.root,
      onChange: (files) => {
        if (!files.includes(manifestFile)) {
          reload(id, files);
          return;
        }
        log.info("plugin manifest changed, re-resolving the plugin graph", { plugin: id });
        void rescanQuietly(`manifest of ${id} changed`).then((update) => {
          const rest = files.filter((file) => file !== manifestFile);
          if (rest.length === 0) return;
          if (update !== undefined && (update.started.includes(id) || update.removed.includes(id)))
            return;
          // A failed rescan, or a manifest saved unchanged, still reloads the code saved with it.
          // A rescan already told listeners about an added or changed plugin.
          const notified =
            update !== undefined && (update.added.includes(id) || update.changed.includes(id));
          reload(id, rest, notified);
        });
      },
    });
  }
  for (const path of locations) {
    // A location created later is watched itself once it exists, not through its parent.
    targets.set(`location:${path}:${Fs.existsSync(path)}`, {
      path,
      // A plugin directory coming or going, or the manifest of one (maybe not discovered yet).
      filter: (relative) => {
        const parts = relative.split(Path.sep);
        // Discovery skips hidden entries.
        if (parts[0]!.startsWith(".")) return false;
        // A discovered plugin's own watcher handles its manifest; reacting here
        // too would rescan twice for one save.
        if (parts.length === 2) {
          return parts[1] === "package.json" && !hasOwnWatcher(Path.join(path, parts[0]!));
        }
        if (parts.length !== 1) return false;
        // A file beside the plugin directories (an editor's temp file) is no plugin;
        // an entry that is gone may have been one.
        return Fs.statSync(Path.join(path, relative), { throwIfNoEntry: false })?.isFile() !== true;
      },
      onChange: () => void rescanQuietly(`plugins changed in ${path}`),
    });
  }
  targets.set("config:node", {
    path: home.config,
    onChange: () => applyLayer(kernel, "node", home.config, log),
  });
  targets.set("config:project", {
    path: projectConfig,
    onChange: () => applyLayer(kernel, "project", projectConfig, log),
  });
  return targets;
}
