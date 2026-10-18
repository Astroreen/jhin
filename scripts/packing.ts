// Pure helpers of scripts/pack.ts and scripts/pack-smoke.ts, unit tested in
// scripts/packing.test.ts.

export interface PackedManifest {
  jhin?: Record<string, unknown>;
  publishConfig?: { jhin?: Record<string, unknown> } & Record<string, unknown>;
  [field: string]: unknown;
}

/** The manifest a tarball should carry: `publishConfig.jhin` applied to `jhin`. */
export function packedManifest(manifest: PackedManifest): PackedManifest {
  const { jhin: override, ...publishConfig } = manifest.publishConfig ?? {};
  if (override === undefined) return manifest;
  if (manifest.jhin === undefined) throw new Error('"publishConfig.jhin" without "jhin"');
  const packed: PackedManifest = { ...manifest, jhin: { ...manifest.jhin, ...override } };
  if (Object.keys(publishConfig).length > 0) packed.publishConfig = publishConfig;
  else delete packed.publishConfig;
  return packed;
}

export interface LockedPins {
  /** pnpm `overrides`: `name` or `name@<major>` (`name@0.<minor>`) to an exact version. */
  readonly pins: Map<string, string>;
  /** Packages with several versions on one major line, left floating. */
  readonly unpinned: string[];
}

/** Third-party versions a pnpm lockfile resolved, as pnpm overrides. */
export function lockedPins(lockfile: string): LockedPins {
  const section = /^packages:\n([\s\S]*?)^snapshots:/m.exec(lockfile)?.[1] ?? "";
  const versions = new Map<string, string[]>();
  for (const [, key] of section.matchAll(/^ {2}'?([^'\s][^'\n]*?)'?:$/gm)) {
    const at = key!.lastIndexOf("@");
    const name = key!.slice(0, at);
    versions.set(name, [...(versions.get(name) ?? []), key!.slice(at + 1)]);
  }
  // A lockfile format this parser does not understand must not silently unpin everything.
  if (versions.size === 0) {
    throw new Error("pnpm-lock.yaml: found no packages to pin; has the lockfile format changed?");
  }
  const pins = new Map<string, string>();
  const unpinned: string[] = [];
  const line = (version: string) => {
    const [major, minor] = version.split(".");
    return major === "0" ? `0.${minor}` : major!;
  };
  for (const [name, list] of versions) {
    if (list.length === 1) {
      pins.set(name, list[0]!);
      continue;
    }
    // Several versions: pin each by its major (0.x by its minor) when that tells them apart.
    const lines = list.map(line);
    if (new Set(lines).size !== lines.length) {
      unpinned.push(`${name} (${list.join(", ")})`);
      continue;
    }
    list.forEach((version, index) => pins.set(`${name}@${lines[index]}`, version));
  }
  return { pins, unpinned };
}
