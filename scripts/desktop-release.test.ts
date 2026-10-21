import { describe, expect, it } from "vite-plus/test";

import {
  builderConfig,
  nightlyVersion,
  releaseVersion,
  SIGNING_SECRETS,
  signing,
  updateChannel,
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
    expect(updateChannel("1.2.3-beta.1")).toBe("latest");
    expect(() => releaseVersion("main")).toThrow("Invalid release version");
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
