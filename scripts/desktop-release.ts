// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): the electron-builder
// configuration of scripts/build-desktop-artifact.ts and the signing checks of
// .github/workflows/release-desktop.yml.
//
// Pure helpers of scripts/package-desktop.ts (docs/plans/desktop.md, D942–D945),
// unit tested in scripts/desktop-release.test.ts.

export type DesktopPlatform = "linux" | "mac" | "win";
export type DesktopArch = "x64" | "arm64";

/** The app's id on every system (macOS bundle id, Windows AppUserModelID, Linux metainfo). */
export const DESKTOP_APP_ID = "ai.jhin.desktop";

/** Where the app's updates come from: this repository's GitHub releases (D519). */
export const UPDATE_REPOSITORY = "Astroreen/jhin";

const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** A nightly build updates from the `nightly` feed files, any other build from `latest` (T3). */
export function updateChannel(version: string): "latest" | "nightly" {
  return NIGHTLY_VERSION.test(version) ? "nightly" : "latest";
}

/** T3's nightly version: the app's version, the UTC date and the workflow run. */
export function nightlyVersion(base: string, date: Date, run: number): string {
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`Invalid base version: ${base}`);
  if (!Number.isInteger(run) || run < 1) throw new Error(`Invalid run number: ${run}`);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${base}-nightly.${day}.${run}`;
}

/**
 * Checks a stable version (a tag without its `v`). Only `x.y.z`: a suffix would
 * make a GitHub prerelease that the stable feed never offers, and nightlies have
 * their own track.
 */
export function releaseVersion(raw: string): string {
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!RELEASE_VERSION.test(version)) throw new Error(`Invalid release version: ${raw}`);
  return version;
}

/** The secrets a signed build needs on each system (T3's names, D944). */
export const SIGNING_SECRETS: Readonly<Record<DesktopPlatform, readonly string[]>> = {
  // A Developer ID Application certificate (.p12, base64) and an App Store
  // Connect API key (the .p8's text) for notarization.
  mac: ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  // Azure Trusted Signing (Artifact Signing) with a service principal.
  win: [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  ],
  // AppImage and .deb are not signed (T3).
  linux: [],
};

export interface Signing {
  /** Every secret of the platform is set: the build signs (and on macOS notarizes). */
  readonly signed: boolean;
  /** Secrets that are set while others are missing: a half configuration is an error. */
  readonly missing: readonly string[];
}

/** Signs only when every secret of the platform is configured; none configured builds unsigned. */
export function signing(
  platform: DesktopPlatform,
  env: Readonly<Record<string, string | undefined>>,
): Signing {
  const names = SIGNING_SECRETS[platform];
  const missing = names.filter((name) => (env[name] ?? "").trim() === "");
  if (names.length === 0 || missing.length === names.length) return { signed: false, missing: [] };
  return { signed: missing.length === 0, missing };
}

export interface BuilderConfigInput {
  readonly platform: DesktopPlatform;
  readonly version: string;
  readonly electronVersion: string;
  /** `owner/repo` of the update feed; undefined builds without one (a local or dry-run build). */
  readonly repository: string | undefined;
  readonly signed: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The electron-builder configuration of one platform's build (D942–D944). */
export function builderConfig(input: BuilderConfigInput): Record<string, unknown> {
  const channel = updateChannel(input.version);
  const config: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: "Jhin",
    artifactName: "Jhin-${version}-${arch}.${ext}",
    electronVersion: input.electronVersion,
    extraMetadata: { version: input.version },
    directories: { output: "release", buildResources: "resources" },
    // The staged app is installed already; node-pty uses Node-API, so Electron's
    // own Node loads the addon built for Node without a rebuild.
    npmRebuild: false,
    // The node runs as a child of Electron's Node from these files (D512): no asar.
    asar: false,
    files: ["dist/**", "package.json", "node_modules/**"],
    // A missing `publish` makes electron-builder guess a GitHub feed from
    // GH_TOKEN; without a repository the build has no feed at all (T3).
    publish:
      input.repository === undefined
        ? null
        : [githubFeed(input.repository, channel === "nightly" ? "nightly" : undefined)],
  };
  if (input.platform === "mac") {
    config["mac"] = {
      target: ["dmg", "zip"],
      icon: "icon.png",
      category: "public.app-category.developer-tools",
      // Unsigned builds are signed ad hoc, which Apple Silicon needs to start them.
      ...(input.signed
        ? { hardenedRuntime: true, notarize: true }
        : { identity: "-", hardenedRuntime: false, notarize: false }),
    };
    config["dmg"] = { title: `Jhin ${input.version}` };
  }
  if (input.platform === "linux") {
    // The static AppImage runtime also starts where only FUSE 3 is installed (T3).
    config["toolsets"] = { appimage: "1.0.3" };
    config["linux"] = {
      target: ["AppImage", "deb"],
      executableName: "jhin-desktop",
      icon: "icon.png",
      category: "Development",
      synopsis: "Self-hosted AI harness",
      maintainer: "Jhin <noreply@github.com>",
      desktop: { entry: { StartupWMClass: "Jhin" } },
    };
    config["deb"] = {
      // Debian 13 and Ubuntu 24.04 renamed some for 64-bit time (T3).
      depends: [
        "libasound2t64 | libasound2",
        "libatspi2.0-0t64 | libatspi2.0-0",
        "libgbm1",
        "libgtk-3-0t64 | libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libsecret-1-0",
        "libuuid1",
        "libxss1",
        "libxtst6",
        "xdg-utils",
      ],
    };
  }
  if (input.platform === "win") {
    config["nsis"] = { differentialPackage: true };
    config["win"] = {
      target: ["nsis"],
      icon: "icon.png",
      // Smart App Control checks native addons apart from the signed executable (T3).
      signExts: [".node", ".dll"],
      signAndEditExecutable: true,
      ...(input.signed
        ? {
            azureSignOptions: {
              publisherName: input.env["AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"],
              endpoint: input.env["AZURE_TRUSTED_SIGNING_ENDPOINT"],
              codeSigningAccountName: input.env["AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"],
              certificateProfileName: input.env["AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"],
            },
          }
        : {}),
    };
  }
  return config;
}

function githubFeed(repository: string, channel: "nightly" | undefined): Record<string, unknown> {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid repository: ${repository}`);
  return {
    provider: "github",
    owner,
    repo,
    // Nightlies are prereleases with their own `nightly*.yml` files (D519).
    releaseType: channel === "nightly" ? "prerelease" : "release",
    ...(channel === undefined ? {} : { channel }),
  };
}

export interface PackageOptions {
  readonly platform: DesktopPlatform;
  readonly arch: DesktopArch;
}

const HOST_PLATFORMS: Readonly<Record<string, DesktopPlatform>> = {
  linux: "linux",
  darwin: "mac",
  win32: "win",
};

/**
 * The platform and arch to package: the host's own. The staged app installs
 * native addons for the machine it runs on and nothing is rebuilt (D942), so a
 * cross build would ship the wrong addon.
 */
export function packageOptions(
  values: { readonly platform?: string | undefined; readonly arch?: string | undefined },
  host: { readonly platform: string; readonly arch: string },
): PackageOptions {
  const own = HOST_PLATFORMS[host.platform];
  if (own === undefined || (host.arch !== "x64" && host.arch !== "arm64")) {
    throw new Error(`Cannot package on ${host.platform} ${host.arch}`);
  }
  const platform = values.platform ?? own;
  if (!Object.hasOwn(SIGNING_SECRETS, platform)) throw new Error(`Unknown platform: ${platform}`);
  const arch = values.arch ?? host.arch;
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unknown arch: ${arch}`);
  if (platform !== own || arch !== host.arch) {
    throw new Error(
      `Cannot package ${platform} ${arch} on ${own} ${host.arch}: build on that system`,
    );
  }
  return { platform: own, arch: host.arch };
}

/** A version from the `catalog:` block of pnpm-workspace.yaml, without quotes or a comment. */
export function catalogVersion(workspace: string, name: string): string {
  const block = /^catalog:\n((?: {2}.*\n|\s*\n)*)/m.exec(workspace)?.[1] ?? "";
  for (const line of block.split("\n")) {
    const match = /^ {2}(["']?)([^"':\s]+)\1:\s*(["']?)([^"'\s#]+)\3\s*(#.*)?$/.exec(line);
    if (match?.[2] === name) return match[4]!;
  }
  throw new Error(`${name} is not in the workspace catalog`);
}

/** A version to package: a stable `x.y.z` or a nightly, never one that picks the wrong feed. */
export function packageVersion(version: string): string {
  return NIGHTLY_VERSION.test(version) ? version : releaseVersion(version);
}

/** The environment without signing secrets: installing runs third-party scripts (D944). */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secrets = new Set([...SIGNING_SECRETS.mac, ...SIGNING_SECRETS.win, "APPLE_API_KEY_TEXT"]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !secrets.has(name)));
}

/** Quotes an argument for cmd.exe; Jhin's paths and arguments hold no `"` or `%`. */
export function quote(arg: string): string {
  if (/["%]/.test(arg)) throw new Error(`Cannot pass ${arg} through cmd.exe`);
  return /[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg;
}
