import {
  createKernel,
  type Kernel,
  type KernelSide,
  type ModuleLoader,
  type PluginSource,
  type PluginsUpdate,
} from "@jhin/kernel";
import { PLUGIN_API_VERSION, type Logger, type PluginDefinition } from "@jhin/sdk";

/** A plugin given to the test kernel directly: no package, no filesystem. */
export interface TestPlugin {
  /** Raw manifest; validated by the kernel exactly like a real one. */
  readonly manifest: unknown;
  readonly definition: PluginDefinition;
  /** Where the plugin "lives"; defaults to `memory://<index>`. Keep it stable across `setPlugins`. */
  readonly location?: string;
}

export interface TestKernelOptions {
  readonly side?: KernelSide;
  readonly plugins: readonly TestPlugin[];
  readonly logger?: Logger;
  readonly configLayers?: readonly string[];
  /** Layers set before plugins activate. */
  readonly config?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface TestKernel extends Kernel {
  /** Swaps a plugin's code; the next activation (start or reload) uses it. */
  replace(pluginId: string, definition: PluginDefinition): void;
  /** How many times each plugin's module was loaded. */
  loads(pluginId: string): number;
  /**
   * Replaces the plugin set while running, like a host that found plugins
   * added, removed or with a changed manifest on disk (`Kernel.update`).
   */
  setPlugins(plugins: readonly TestPlugin[]): Promise<PluginsUpdate>;
}

/** A complete manifest with test defaults; override any field. */
export function testManifest(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    side: "both",
    entry: "index.js",
    ...overrides,
  };
}

/** Builds and starts a kernel over in-memory plugins. */
export async function createTestKernel(options: TestKernelOptions): Promise<TestKernel> {
  const definitions = new Map<string, PluginDefinition>();
  const loadCounts = new Map<string, number>();
  const toSources = (plugins: readonly TestPlugin[]): PluginSource[] =>
    plugins.map((plugin, index) => {
      const location = plugin.location ?? `memory://${index}`;
      definitions.set(location, plugin.definition);
      return { location, manifest: plugin.manifest };
    });
  let sources = toSources(options.plugins);
  const locationOf = (pluginId: string): string => {
    const found = sources.find(
      (source) => (source.manifest as { id?: unknown } | null)?.id === pluginId,
    );
    if (found === undefined) throw new Error(`No test plugin ${pluginId}`);
    return found.location;
  };

  const loader: ModuleLoader = {
    async load(source, manifest) {
      loadCounts.set(manifest.id, (loadCounts.get(manifest.id) ?? 0) + 1);
      return { default: definitions.get(source.location) };
    },
  };

  const kernel = createKernel({
    side: options.side ?? "server",
    loader,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.configLayers === undefined ? {} : { configLayers: options.configLayers }),
  });
  for (const [layer, values] of Object.entries(options.config ?? {}))
    kernel.config.setLayer(layer, values);
  await kernel.start(sources);

  return Object.assign(kernel, {
    replace(pluginId: string, definition: PluginDefinition) {
      definitions.set(locationOf(pluginId), definition);
    },
    loads(pluginId: string) {
      return loadCounts.get(pluginId) ?? 0;
    },
    setPlugins(plugins: readonly TestPlugin[]) {
      sources = toSources(plugins);
      return kernel.update(sources);
    },
  });
}
