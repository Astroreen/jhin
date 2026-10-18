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

/** Starts the client-side kernel: the same kernel as a node's, with `side: "client"`. */
export async function boot(plugins: readonly BuiltinPlugin[] = BUILTIN_PLUGINS): Promise<Kernel> {
  const definitions = new Map(
    plugins.map((plugin) => [`builtin:${plugin.manifest.id}`, plugin.definition]),
  );
  const kernel = createKernel({
    side: "client",
    logger: consoleLogger({}),
    loader: { load: async (source) => ({ default: definitions.get(source.location) }) },
  });
  const sources: PluginSource[] = plugins.map((plugin) => ({
    location: `builtin:${plugin.manifest.id}`,
    manifest: plugin.manifest,
  }));
  await kernel.start(sources);
  return kernel;
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
