// The workspace's packages and the runtime closure of a package, shared by
// scripts/pack-smoke.ts and scripts/package-desktop.ts.

import * as Fs from "node:fs";
import * as Path from "node:path";

export const ROOT = Path.resolve(import.meta.dirname, "..");

export interface Manifest {
  readonly name: string;
  readonly version?: string;
  readonly packageManager?: string;
  readonly dependencies?: Record<string, string>;
}

export const readJson = <T>(file: string): T => JSON.parse(Fs.readFileSync(file, "utf8")) as T;

/** Workspace package directories by package name. */
export function workspacePackages(): Map<string, string> {
  const packages = new Map<string, string>();
  for (const parent of ["packages", "plugins", "apps"]) {
    for (const child of Fs.readdirSync(Path.join(ROOT, parent))) {
      const file = Path.join(ROOT, parent, child, "package.json");
      if (Fs.existsSync(file)) packages.set(readJson<Manifest>(file).name, Path.dirname(file));
    }
  }
  return packages;
}

/** The roots and every workspace package they need at runtime (`dependencies` only). */
export function closure(packages: ReadonlyMap<string, string>, roots: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    found.add(name);
    const manifest = readJson<Manifest>(Path.join(packages.get(name)!, "package.json"));
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec.startsWith("workspace:")) visit(dep);
    }
  };
  for (const root of roots) visit(root);
  return [...found].toSorted();
}
