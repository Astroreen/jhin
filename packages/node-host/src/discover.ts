import * as Fs from "node:fs";
import * as Path from "node:path";

import type { PluginSource } from "@jhin/kernel";

/** Plugin layers, lowest precedence first (D15). */
export interface PluginLayers {
  /** Package directories of the distribution plugins. */
  readonly distribution?: readonly string[];
  /** Directory whose subdirectories are user plugins (`~/.jhin/plugins`). */
  readonly user?: string;
  /** Directory whose subdirectories are workspace plugins (`.jhin/plugins`). */
  readonly workspace?: string;
  /** Package directories given explicitly, for development. */
  readonly dev?: readonly string[];
}

export interface DiscoveredPlugin extends PluginSource {
  readonly layer: keyof PluginLayers;
  /** Plugin package root; changes under it reload the plugin. */
  readonly root: string;
}

export interface Shadowed {
  readonly id: string;
  readonly location: string;
  readonly layer: keyof PluginLayers;
  readonly shadowedBy: string;
}

export interface Discovery {
  readonly plugins: readonly DiscoveredPlugin[];
  readonly shadowed: readonly Shadowed[];
}

function children(dir: string | undefined): string[] {
  if (dir === undefined || !Fs.existsSync(dir)) return [];
  return Fs.readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."),
    )
    .map((entry) => Path.join(dir, entry.name))
    .toSorted();
}

function readPackage(root: string, layer: keyof PluginLayers): DiscoveredPlugin | undefined {
  const file = Path.join(root, "package.json");
  if (!Fs.existsSync(file)) return undefined;
  let manifest: unknown;
  try {
    manifest = (JSON.parse(Fs.readFileSync(file, "utf8")) as { jhin?: unknown }).jhin;
  } catch {
    // An unreadable package.json reaches the kernel as an invalid manifest.
    manifest = undefined;
  }
  return { location: root, root: Fs.realpathSync(root), manifest, layer };
}

/** Finds plugins in every layer; a plugin id in a later layer shadows earlier ones. */
export function discoverPlugins(layers: PluginLayers): Discovery {
  const found: DiscoveredPlugin[] = [
    ...(layers.distribution ?? []).map((root) => readPackage(root, "distribution")),
    ...children(layers.user).map((root) => readPackage(root, "user")),
    ...children(layers.workspace).map((root) => readPackage(root, "workspace")),
    ...(layers.dev ?? []).map((root) => readPackage(root, "dev")),
  ].filter((plugin) => plugin !== undefined);

  const byId = new Map<string, DiscoveredPlugin>();
  const anonymous: DiscoveredPlugin[] = [];
  const shadowed: Shadowed[] = [];
  for (const plugin of found) {
    const id = (plugin.manifest as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") {
      anonymous.push(plugin);
      continue;
    }
    const previous = byId.get(id);
    if (previous !== undefined) {
      shadowed.push({
        id,
        location: previous.location,
        layer: previous.layer,
        shadowedBy: plugin.location,
      });
    }
    byId.set(id, plugin);
  }
  return { plugins: [...byId.values(), ...anonymous], shadowed };
}
