import * as Fs from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";
import * as Url from "node:url";

import type { ModuleLoader } from "@jhin/kernel";

const GENERATION = "jhin-gen";

/** Packages every plugin shares with the host instead of bundling its own copy. */
const SHARED = ["@jhin/sdk"];

const roots = new Set<string>();
let installed = false;

function rootOf(url: string): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (url.startsWith(root) && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * Two resolve hooks, installed once per process:
 *
 * - Shared packages (`@jhin/sdk` and its subpaths) resolve to the host's copy, so plugins
 *   outside any node_modules tree (`~/.jhin/plugins`) can import them and
 *   every plugin sees the same instances.
 * - A file imported by a plugin module loaded with `?jhin-gen=N` gets the same
 *   query when it lives under the same plugin root. A reload therefore
 *   re-imports the whole plugin, not only its entry file. Files outside the
 *   plugin root keep a single instance.
 */
function installHooks(): void {
  if (installed) return;
  installed = true;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      // Subpaths too (`@jhin/sdk/x`), resolved from the host so there is one copy.
      if (SHARED.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
        // Resolve as if the host imported it; import.meta.resolve here would re-enter this hook.
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }

      const result = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (parent === undefined || !result.url.startsWith("file:")) return result;
      const generation = new URL(parent).searchParams.get(GENERATION);
      if (generation === null) return result;
      const root = rootOf(parent);
      if (root === undefined || !result.url.startsWith(root)) return result;
      const url = new URL(result.url);
      url.searchParams.set(GENERATION, generation);
      return { ...result, url: url.href };
    },
  });
}

/** Loads plugin entry modules from disk; every reload gets fresh module instances. */
export function createFileModuleLoader(): ModuleLoader {
  installHooks();
  return {
    async load(source, manifest, generation) {
      // ESM resolution follows symlinks, so roots are compared as real paths.
      const real = Fs.realpathSync(Path.resolve(source.location));
      const root = Url.pathToFileURL(real).href.replace(/\/?$/, "/");
      roots.add(root);
      const entry = new URL(manifest.entry, root);
      entry.searchParams.set(GENERATION, String(generation));
      return import(entry.href);
    },
  };
}
