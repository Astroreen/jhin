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
} from "@jhin/kernel";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import {
  definePlugin,
  DOTTED_ID,
  PLUGIN_API_VERSION,
  z,
  type Disposable,
  type Logger,
} from "@jhin/sdk";

import {
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginLayers,
  type Shadowed,
} from "./discover.ts";
import { readNodeId, resolveHome, type JhinHome } from "./home.ts";
import { createFileModuleLoader } from "./loader.ts";
import { createNodeLogger, type NodeLogger } from "./logger.ts";
import { watch } from "./watcher.ts";

export interface NodeHostOptions {
  /** Jhin home directory; defaults to `$JHIN_HOME` or `~/.jhin`. */
  readonly home?: string;
  /** Project directory; its `.jhin/` holds workspace plugins and config. */
  readonly cwd?: string;
  /** Package directories of the distribution plugins. */
  readonly distribution?: readonly string[];
  readonly dev?: readonly string[];
  /** Reload plugins and config when their files change (D14). */
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

/** Boots a server-side kernel over the plugins found on disk. */
export async function startNodeHost(options: NodeHostOptions = {}): Promise<NodeHost> {
  const home = resolveHome(options.home);
  const nodeId = readNodeId(home);
  const log = createNodeLogger({
    logsDir: home.logs,
    nodeId,
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
  const discovery = discoverPlugins(layers);

  const recentEvents: KernelEvent[] = [];
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
      provides: { [HOST_PATHS_CAPABILITY]: "1.0.0" },
      entry: "host",
    },
  };
  await kernel.start([hostSource, ...discovery.plugins]);

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

  let watching: Disposable | undefined;
  if (options.watch === true)
    watching = watchFiles(kernel, discovery.plugins, home, projectConfig, log);

  return {
    nodeId,
    home,
    kernel,
    log,
    inspect,
    async stop() {
      watching?.dispose();
      await kernel.stop();
      log.flush();
    },
  };
}

function watchFiles(
  kernel: Kernel,
  plugins: readonly DiscoveredPlugin[],
  home: JhinHome,
  projectConfig: string,
  log: Logger,
): Disposable {
  const reloadable = new Set(kernel.inspect().plugins.map((plugin) => plugin.id));
  return watch(
    [
      ...plugins
        .filter(
          (plugin) => typeof (plugin.manifest as { id?: unknown } | undefined)?.id === "string",
        )
        .map((plugin) => {
          const id = (plugin.manifest as { id: string }).id;
          return {
            path: plugin.root,
            onChange: (files: readonly string[]) => {
              if (files.some((file) => Path.basename(file) === "package.json")) {
                log.warn("plugin manifest changed; restart the node to apply it", { plugin: id });
                return;
              }
              if (!reloadable.has(id)) return;
              log.info("plugin files changed, reloading", { plugin: id, files });
              kernel.reload(id).catch((error: unknown) => {
                log.error("plugin reload failed", { plugin: id, error: toErrorInfo(error) });
              });
            },
          };
        }),
      {
        path: home.config,
        onChange: () => applyLayer(kernel, "node", home.config, log),
      },
      {
        path: projectConfig,
        onChange: () => applyLayer(kernel, "project", projectConfig, log),
      },
    ],
    log,
  );
}
