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
  /** Left floating: several versions on one major line, or a non-registry specifier. */
  readonly unpinned: string[];
}

const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

/** The `name@version` keys of a pnpm lockfile's `packages:` section. */
export function lockedPackages(lockfile: string): string[] {
  const section = /^packages:\n([\s\S]*?)^snapshots:/m.exec(lockfile)?.[1] ?? "";
  return [...section.matchAll(/^ {2}'?([^'\s][^'\n]*?)'?:$/gm)].map((match) => match[1]!);
}

/** Third-party versions a pnpm lockfile resolved, as pnpm overrides. */
export function lockedPins(lockfile: string): LockedPins {
  const versions = new Map<string, string[]>();
  const unpinned: string[] = [];
  for (const key of lockedPackages(lockfile)) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    // Git, tarball and other non-registry specifiers cannot be pinned by version.
    if (at <= 0 || !SEMVER.test(version)) {
      unpinned.push(key);
      continue;
    }
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  // A lockfile format this parser does not understand must not silently unpin everything.
  if (versions.size === 0) {
    throw new Error("pnpm-lock.yaml: found no packages to pin; has the lockfile format changed?");
  }
  const pins = new Map<string, string>();
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
