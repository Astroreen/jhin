import { describe, expect, it } from "vite-plus/test";

import { Chromium } from "../src/chromium.ts";

/** A launcher that records the paths it was asked for; `fail` decides each answer. */
function fakeLauncher(fail: (executablePath: string | undefined) => string | undefined) {
  const launched: (string | undefined)[] = [];
  const browser = {
    on: () => undefined,
    newContext: async () => ({ newPage: async () => ({}) }),
  };
  const launcher = async () => ({
    launch: async (options?: { executablePath?: string }) => {
      launched.push(options?.executablePath);
      const failure = fail(options?.executablePath);
      if (failure !== undefined) throw new Error(failure);
      return browser as never;
    },
  });
  return { launched, launcher };
}

function fakeShell() {
  let installs = 0;
  return {
    get installs() {
      return installs;
    },
    executable: async () => {
      installs += 1;
      return "/home/.jhin/tools/chrome-headless-shell/linux64/1.0.0/chrome-headless-shell";
    },
  };
}

const MISSING =
  "browserType.launch: Executable doesn't exist at /ms-playwright/chromium_headless_shell/chrome";

describe("which browser a tab starts (D951)", () => {
  it("installs T3's shell only when Playwright has no browser here", async () => {
    const shell = fakeShell();
    const { launched, launcher } = fakeLauncher((path) =>
      path === undefined ? MISSING : undefined,
    );
    await new Chromium({ headlessShell: shell, launcher }).newPage(true);
    expect(launched).toEqual([undefined, await shell.executable()]);
  });

  it("keeps Playwright's browser when it is there", async () => {
    const shell = fakeShell();
    const { launched, launcher } = fakeLauncher(() => undefined);
    await new Chromium({ headlessShell: shell, launcher }).newPage(true);
    expect(launched).toEqual([undefined]);
    expect(shell.installs).toBe(0);
  });

  it("never replaces a configured browser or one that fails to start", async () => {
    const shell = fakeShell();
    const configured = fakeLauncher(() => MISSING);
    await expect(
      new Chromium({
        executablePath: () => "/opt/chrome",
        headlessShell: shell,
        launcher: configured.launcher,
      }).newPage(true),
    ).rejects.toMatchObject({ code: "PREVIEW_UNAVAILABLE" });
    const broken = fakeLauncher(() => "browserType.launch: Failed to launch: missing libnss3.so");
    await expect(
      new Chromium({ headlessShell: shell, launcher: broken.launcher }).newPage(true),
    ).rejects.toMatchObject({ code: "PREVIEW_UNAVAILABLE" });
    expect(shell.installs).toBe(0);
  });
});
