import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { Chromium } from "../src/chromium.ts";

/** A launcher that records the paths it was asked for; `fail` decides each answer. */
function fakeLauncher(fail: (executablePath: string | undefined) => string | undefined) {
  const launched: (string | undefined)[] = [];
  const browser = {
    on: () => undefined,
    close: async () => undefined,
    newContext: async () => ({ newPage: async () => ({}), on: () => undefined, pages: () => [] }),
  };
  /** Persistent profiles started, by folder. */
  const persistent: string[] = [];
  const launcher = async () =>
    ({
      launch: async (options?: { executablePath?: string }) => {
        launched.push(options?.executablePath);
        const failure = fail(options?.executablePath);
        if (failure !== undefined) throw new Error(failure);
        return browser;
      },
      launchPersistentContext: async (directory: string, options?: { executablePath?: string }) => {
        launched.push(options?.executablePath);
        const failure = fail(options?.executablePath);
        if (failure !== undefined) throw new Error(failure);
        persistent.push(directory);
        let closed = false;
        const listeners: (() => void)[] = [];
        return {
          pages: () => [],
          on: (event: string, listener: () => void) => {
            if (event === "close") listeners.push(listener);
          },
          newPage: async () => ({}),
          close: async () => {
            closed = true;
            for (const listener of listeners) listener();
          },
          get closed() {
            return closed;
          },
        };
      },
    }) as never;
  return { launched, launcher, persistent };
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
    const chromium = new Chromium({ headlessShell: shell, launcher });
    await chromium.newPage(true);
    const path = await shell.executable();
    expect(launched).toEqual([undefined, path]);
    // A browser started again goes straight to the shell.
    await chromium.close();
    await chromium.newPage(true);
    expect(launched).toEqual([undefined, path, path]);
  });

  it("says the installed shell did not start, not that there is no browser", async () => {
    const shell = fakeShell();
    const { launcher } = fakeLauncher((path) =>
      path === undefined ? MISSING : "browserType.launch: Failed to launch: libnss3.so missing",
    );
    await expect(new Chromium({ headlessShell: shell, launcher }).newPage(true)).rejects.toThrow(
      "The browser did not start: browserType.launch: Failed to launch: libnss3.so missing",
    );
  });

  it("passes the shell's answer on while it installs, and tries again with the next tab", async () => {
    let ready = false;
    const shell = {
      executable: async () => {
        if (!ready) {
          throw new Error(
            "Jhin is installing its headless browser (12 of 120 MB downloaded). Try again in a minute.",
          );
        }
        return "/home/.jhin/tools/shell";
      },
    };
    const { launched, launcher } = fakeLauncher((path) =>
      path === undefined ? MISSING : undefined,
    );
    const chromium = new Chromium({ headlessShell: shell, launcher });
    await expect(chromium.newPage(true)).rejects.toMatchObject({
      code: "PREVIEW_UNAVAILABLE",
      message: expect.stringContaining("12 of 120 MB downloaded"),
    });
    ready = true;
    await chromium.newPage(true);
    expect(launched.at(-1)).toBe("/home/.jhin/tools/shell");
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

describe("browser profiles (D952)", () => {
  const profilesDir = () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-profiles-"));
    dirs.push(dir);
    return dir;
  };
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) Fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives each persistent profile its own folder, once, and incognito the shared browser", async () => {
    const root = profilesDir();
    const { launched, launcher, persistent } = fakeLauncher(() => undefined);
    const chromium = new Chromium({ launcher, profilesDir: root });
    await chromium.newPage(false);
    await chromium.newPage(false);
    await chromium.newPage(false, "work");
    await chromium.newPage(false, "..");
    await chromium.newPage(false, "Work");
    expect(persistent).toEqual([
      Path.join(root, "default"),
      Path.join(root, "work"),
      Path.join(root, "%2E%2E"),
      // Apart from `work` also where the file system ignores case.
      Path.join(root, "%57ork"),
    ]);
    await chromium.newPage(false, "incognito");
    // Incognito and an agent's tab start the one shared browser, not a profile.
    await chromium.newPage(true);
    expect(launched).toHaveLength(5);
  });

  it("clears a profile: its context closes and its folder goes", async () => {
    const root = profilesDir();
    const { launcher, persistent } = fakeLauncher(() => undefined);
    const chromium = new Chromium({ launcher, profilesDir: root });
    const { context } = await chromium.newPage(false, "work");
    Fs.writeFileSync(Path.join(root, "work", "Cookies"), "session");
    await chromium.clearProfile("work");
    expect((context as unknown as { closed: boolean }).closed).toBe(true);
    expect(Fs.existsSync(Path.join(root, "work"))).toBe(false);
    // The next tab of that profile starts it again, from nothing.
    await chromium.newPage(false, "work");
    expect(persistent).toEqual([Path.join(root, "work"), Path.join(root, "work")]);
  });
});
