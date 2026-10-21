import { describe, expect, it } from "vite-plus/test";

import {
  builderConfig,
  catalogVersion,
  nightlyVersion,
  packageOptions,
  packageVersion,
  quote,
  releaseVersion,
  SIGNING_SECRETS,
  signing,
  updateChannel,
  withoutSecrets,
} from "./desktop-release.ts";

const all = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, "x"]));

describe("versions", () => {
  it("names a nightly after the date and the run", () => {
    const version = nightlyVersion("0.1.0", new Date("2026-10-21T23:30:00Z"), 42);
    expect(version).toBe("0.1.0-nightly.20261021.42");
    expect(updateChannel(version)).toBe("nightly");
  });

  it("keeps releases on the stable track", () => {
    expect(releaseVersion("v1.2.3")).toBe("1.2.3");
    expect(updateChannel("1.2.3")).toBe("latest");
    expect(() => releaseVersion("main")).toThrow("Invalid release version");
    // A suffix would be a GitHub prerelease, which the stable feed never offers.
    expect(() => releaseVersion("v1.2.3-rc.1")).toThrow("Invalid release version");
  });
});

describe("signing", () => {
  it("signs only when every secret of the platform is set", () => {
    expect(signing("mac", all(SIGNING_SECRETS.mac))).toEqual({ signed: true, missing: [] });
    expect(signing("win", all(SIGNING_SECRETS.win))).toEqual({ signed: true, missing: [] });
  });

  it("builds unsigned without secrets, and never signs Linux", () => {
    expect(signing("mac", {})).toEqual({ signed: false, missing: [] });
    expect(signing("win", { AZURE_TENANT_ID: " " })).toEqual({ signed: false, missing: [] });
    expect(signing("linux", all(SIGNING_SECRETS.mac))).toEqual({ signed: false, missing: [] });
  });

  it("names what a half configuration lacks", () => {
    const result = signing("mac", { CSC_LINK: "x", CSC_KEY_PASSWORD: "x" });
    expect(result).toEqual({
      signed: false,
      missing: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    });
  });
});

describe("builderConfig", () => {
  const base = { electronVersion: "44.4.5", signed: false, env: {} } as const;

  it("has no feed without a repository", () => {
    const config = builderConfig({
      ...base,
      platform: "linux",
      version: "0.1.0",
      repository: undefined,
    });
    expect(config["publish"]).toBeNull();
    expect(config["linux"]).toMatchObject({ target: ["AppImage", "deb"] });
  });

  it("publishes stable releases and nightly prereleases to GitHub", () => {
    const stable = builderConfig({
      ...base,
      platform: "win",
      version: "1.0.0",
      repository: "Astroreen/jhin",
    });
    expect(stable["publish"]).toEqual([
      { provider: "github", owner: "Astroreen", repo: "jhin", releaseType: "release" },
    ]);
    const nightly = builderConfig({
      ...base,
      platform: "win",
      version: "1.0.0-nightly.20261021.1",
      repository: "Astroreen/jhin",
    });
    expect(nightly["publish"]).toEqual([
      {
        provider: "github",
        owner: "Astroreen",
        repo: "jhin",
        releaseType: "prerelease",
        channel: "nightly",
      },
    ]);
  });

  it("signs and notarizes macOS only when signed, ad hoc otherwise", () => {
    const unsigned = builderConfig({
      ...base,
      platform: "mac",
      version: "1.0.0",
      repository: undefined,
    });
    expect(unsigned["mac"]).toMatchObject({ identity: "-", notarize: false });
    const signed = builderConfig({
      ...base,
      signed: true,
      platform: "mac",
      version: "1.0.0",
      repository: undefined,
    });
    expect(signed["mac"]).toMatchObject({ hardenedRuntime: true, notarize: true });
    expect(signed["mac"]).not.toHaveProperty("identity");
  });

  it("gives Windows Azure Trusted Signing only when signed", () => {
    const env = all(SIGNING_SECRETS.win);
    const unsigned = builderConfig({
      ...base,
      env,
      platform: "win",
      version: "1.0.0",
      repository: undefined,
    });
    expect(unsigned["win"]).not.toHaveProperty("azureSignOptions");
    const signed = builderConfig({
      ...base,
      env,
      signed: true,
      platform: "win",
      version: "1.0.0",
      repository: undefined,
    });
    expect(signed["win"]).toMatchObject({
      azureSignOptions: {
        publisherName: "x",
        endpoint: "x",
        codeSigningAccountName: "x",
        certificateProfileName: "x",
      },
    });
  });
});

describe("packageOptions", () => {
  const host = { platform: "darwin", arch: "arm64" };

  it("packages for the host by default", () => {
    expect(packageOptions({}, host)).toEqual({ platform: "mac", arch: "arm64" });
    expect(packageOptions({ platform: "mac", arch: "arm64" }, host)).toEqual({
      platform: "mac",
      arch: "arm64",
    });
  });

  it("refuses unknown values and cross builds", () => {
    expect(() => packageOptions({ platform: "constructor" }, host)).toThrow("Unknown platform");
    expect(() => packageOptions({ arch: "ia32" }, host)).toThrow("Unknown arch");
    expect(() => packageOptions({ arch: "x64" }, host)).toThrow("build on that system");
    expect(() => packageOptions({ platform: "win" }, host)).toThrow("build on that system");
    expect(() => packageOptions({}, { platform: "freebsd", arch: "x64" })).toThrow(
      "Cannot package",
    );
  });
});

describe("catalogVersion", () => {
  const workspace = [
    "packages:",
    "  - apps/*",
    "",
    "catalog:",
    '  "@types/node": 24.19.2',
    '  electron: "44.4.5" # the app',
    "  electron-updater: 6.8.9",
    "",
    "overrides:",
    '  electron-builder: "catalog:"',
    "",
  ].join("\n");

  it("reads the catalog block only, without quotes and comments", () => {
    expect(catalogVersion(workspace, "electron")).toBe("44.4.5");
    expect(catalogVersion(workspace, "electron-updater")).toBe("6.8.9");
    expect(catalogVersion(workspace, "@types/node")).toBe("24.19.2");
    expect(catalogVersion(workspace.replaceAll("\n", "\r\n"), "electron")).toBe("44.4.5");
    expect(() => catalogVersion(workspace, "electron-builder")).toThrow(
      "not in the workspace catalog",
    );
  });
});

describe("packaging inputs", () => {
  it("packages stable and nightly versions only", () => {
    expect(packageVersion("1.2.3")).toBe("1.2.3");
    expect(packageVersion("1.2.3-nightly.20261021.4")).toBe("1.2.3-nightly.20261021.4");
    expect(() => packageVersion("1.2.3-nightly")).toThrow("Invalid release version");
    expect(() => packageVersion("latest")).toThrow("Invalid release version");
  });

  it("keeps every signing secret from commands other than electron-builder", () => {
    const env = {
      ...all(SIGNING_SECRETS.mac),
      ...all(SIGNING_SECRETS.win),
      APPLE_API_KEY_TEXT: "x",
      PATH: "/bin",
    };
    expect(withoutSecrets(env)).toEqual({ PATH: "/bin" });
  });

  it("quotes cmd.exe arguments and refuses what it cannot quote", () => {
    expect(quote("pnpm")).toBe("pnpm");
    expect(quote("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quote("a&b")).toBe('"a&b"');
    expect(() => quote('say "hi"')).toThrow("cmd.exe");
    expect(() => quote("%PATH%")).toThrow("cmd.exe");
  });
});
