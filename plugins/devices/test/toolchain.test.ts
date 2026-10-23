// Cases follow T3 Code's apps/server/src/device/DeviceToolchain.test.ts (MIT, see
// THIRD_PARTY_NOTICES.md), against a fake npm. docs/plans/preview.md, D1206.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DEVICE_TOOL_VERSIONS,
  HUB_SPEC,
  createToolchain,
  installEnvironment,
  toolEnvironment,
  installMessage,
  installedVersions,
  toolPaths,
} from "../src/toolchain.ts";
import { fakeTools } from "./fakes.ts";

describe("the device toolchain", () => {
  it("installs T3's pinned hub into <home>/tools through a staging folder, once", async () => {
    const tools = fakeTools();
    const toolchain = createToolchain({ home: tools.home, npm: () => tools.npm });
    expect(toolchain.installed(HUB_SPEC)).toBe(false);
    // Two at once: the second waits for the first and finds it done.
    const [first, second] = await Promise.all([
      toolchain.ensure(HUB_SPEC),
      toolchain.ensure(HUB_SPEC),
    ]);
    expect(first).toEqual(second);
    expect(tools.npmCalls()).toEqual([
      { name: "expo-device-hub", version: DEVICE_TOOL_VERSIONS["expo-device-hub"] },
    ]);
    const paths = toolPaths(tools.home, HUB_SPEC);
    expect(first.installDir).toBe(
      Path.join(tools.home, "tools", "expo-device-hub", HUB_SPEC.version),
    );
    expect(Fs.existsSync(paths.entryPath)).toBe(true);
    expect(Fs.readFileSync(paths.sentinelPath, "utf8")).toBe(`${HUB_SPEC.version}\n`);
    // No staging folder is left behind.
    expect(Fs.readdirSync(Path.dirname(paths.installDir))).toEqual([HUB_SPEC.version]);
    expect(toolchain.installed(HUB_SPEC)).toBe(true);
  });

  it("cleans the staging folder of a failed install and says only which step failed", async () => {
    const tools = fakeTools();
    tools.failNpm();
    const toolchain = createToolchain({ home: tools.home, npm: () => tools.npm });
    const error = await toolchain.ensure(HUB_SPEC).then(
      () => new Error("expected the install to fail"),
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.message).not.toContain("credential");
    expect(toolchain.installed(HUB_SPEC)).toBe(false);
    expect(Fs.readdirSync(Path.join(tools.home, "tools", "expo-device-hub"))).toEqual([]);
    // The next request installs again.
    await toolchain.ensure(HUB_SPEC);
    expect(toolchain.installed(HUB_SPEC)).toBe(true);
  });

  it("installs again over an entry without its sentinel and drops older versions", async () => {
    const tools = fakeTools();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [HUB_SPEC.version, "wrong"],
    ] as const) {
      const paths = toolPaths(tools.home, { ...HUB_SPEC, version });
      Fs.mkdirSync(Path.dirname(paths.entryPath), { recursive: true });
      Fs.writeFileSync(paths.entryPath, "");
      Fs.writeFileSync(paths.sentinelPath, sentinel);
    }
    expect(installedVersions(tools.home, HUB_SPEC)).toEqual(["0.9.0"]);
    expect(installMessage(tools.home, "device hub", HUB_SPEC)).toBe(
      `Updating device hub from 0.9.0 to ${HUB_SPEC.version}…`,
    );
    const toolchain = createToolchain({ home: tools.home, npm: () => tools.npm });
    expect(toolchain.installed(HUB_SPEC)).toBe(false);
    await toolchain.ensure(HUB_SPEC);
    expect(tools.npmCalls()).toHaveLength(1);
    expect(installedVersions(tools.home, HUB_SPEC)).toEqual([HUB_SPEC.version]);
    expect(Fs.readdirSync(Path.join(tools.home, "tools", "expo-device-hub"))).toEqual([
      HUB_SPEC.version,
    ]);
  });

  it("says what it installs the first time", () => {
    const tools = fakeTools();
    expect(installMessage(tools.home, "device hub", HUB_SPEC)).toBe(
      `Installing device hub ${HUB_SPEC.version}…`,
    );
  });

  it("gives the running tools the SDK's variables, and still no secrets", () => {
    expect(
      toolEnvironment({ PATH: "/bin", ANDROID_HOME: "/sdk", ANTHROPIC_API_KEY: "sk-secret" }),
    ).toEqual({ PATH: "/bin", ANDROID_HOME: "/sdk" });
  });

  it("gives npm and the install scripts no secrets of the node", () => {
    expect(
      installEnvironment({
        PATH: "/bin",
        HOME: "/home/me",
        HTTPS_PROXY: "http://proxy",
        npm_config_registry: "https://registry.example",
        ANTHROPIC_API_KEY: "sk-secret",
        SOME_TOKEN: "secret",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      HTTPS_PROXY: "http://proxy",
      npm_config_registry: "https://registry.example",
    });
  });
});
