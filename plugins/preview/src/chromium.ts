// Launching and presenting the browser follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/preview/ServerBrowserContexts.ts (launch arguments, contexts, presentAsChrome).
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewError,
} from "@jhin/preview-api";
import type { Browser, BrowserContext, CDPSession, LaunchOptions, Page } from "playwright-core";

/** Device pixels per CSS pixel every tab renders at. */
export const RENDER_SCALE = 2;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface ChromiumOptions {
  /** A Chromium to run instead of the one Playwright installs. */
  readonly executablePath?: (() => string | undefined) | undefined;
  /**
   * T3's pinned headless shell, installed on first use when neither a path is
   * set nor Playwright has a browser here (D951).
   */
  readonly headlessShell?: { executable(): Promise<string> } | undefined;
  /** Playwright's Chromium launcher; tests give their own. */
  readonly launcher?:
    | (() => Promise<
        Pick<typeof import("playwright-core").chromium, "launch" | "launchPersistentContext">
      >)
    | undefined;
  /** Where persistent profiles keep their folders (D952). */
  readonly profilesDir?: string | undefined;
}

const NO_BROWSER_MESSAGE =
  "The node has no browser for previews. Install one with `npx playwright install chromium`, or set jhin.preview.executablePath.";

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Sites block a user agent that disagrees with `Sec-CH-UA`, so both change together. */
function chromeIdentity(headlessUserAgent: string) {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (version === null || fullVersion === undefined || major === undefined) return null;
  const brands = (names: (value: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  const arch = Os.arch();
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[process.platform] ?? "Unknown",
      platformVersion: process.platform === "linux" ? Os.release() : "",
      architecture: arch.startsWith("arm") ? "arm" : "x86",
      bitness: arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
}

/** The tab says it is Chrome, not HeadlessChrome. */
export async function presentAsChrome(cdp: CDPSession): Promise<void> {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent);
  if (identity !== null) await cdp.send("Emulation.setUserAgentOverride", identity);
}

/**
 * The node's browser (D394): started for the first tab, closed after the last
 * one. A human's tab browses with a profile (D952, T3's): the default one and
 * user profiles keep cookies and storage in a folder of their own, incognito
 * keeps them as long as the browser; an agent's tab gets a context of its own.
 */
export class Chromium {
  readonly #options: ChromiumOptions;
  #browser: Promise<Browser> | undefined;
  /**
   * Playwright had no browser here: later starts go straight to the shell (D951).
   * Kept for the plugin's run: a browser of Playwright's installed meanwhile is
   * found on the node's next start.
   */
  #playwrightMissing = false;
  /** Each profile's context, by profile id. */
  readonly #profiles = new Map<string, Promise<BrowserContext>>();
  /** Profiles being cleared: their next context waits for the folder to go. */
  readonly #clearing = new Map<string, Promise<void>>();

  constructor(options: ChromiumOptions = {}) {
    this.#options = options;
  }

  #chromium() {
    return (async () =>
      (await this.#options.launcher?.()) ?? (await import("playwright-core")).chromium)();
  }

  /**
   * Starts something with the browser to run: the configured one, else
   * Playwright's, else T3's pinned shell, installed now when Playwright has
   * none (D951). Every failure is a `PREVIEW_UNAVAILABLE` saying why.
   */
  async #start<T>(start: (launch: LaunchOptions) => Promise<T>): Promise<T> {
    const configured = this.#options.executablePath?.();
    const options = (executablePath: string | undefined): LaunchOptions => ({
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [
        "--disable-gpu",
        `--force-device-scale-factor=${RENDER_SCALE}`,
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
    });
    const missing = (message: string) =>
      /Executable doesn't exist|Failed to launch|ENOENT/i.test(message);
    try {
      try {
        if (this.#playwrightMissing && configured === undefined) {
          throw new Error("Executable doesn't exist (Playwright's browser, found missing before)");
        }
        return await start(options(configured));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const shell = this.#options.headlessShell;
        // No browser of Playwright's here: T3's pinned shell, installed now (D951). A
        // browser that is there but does not start is reported, not replaced.
        if (
          configured !== undefined ||
          shell === undefined ||
          !/Executable doesn't exist/i.test(message)
        ) {
          throw cause;
        }
        this.#playwrightMissing = true;
        let executable: string;
        try {
          executable = await shell.executable();
        } catch (installing) {
          throw new PreviewError(
            "PREVIEW_UNAVAILABLE",
            installing instanceof Error ? installing.message : String(installing),
          );
        }
        try {
          return await start(options(executable));
        } catch (failed) {
          // The shell is there but does not start (libraries the host lacks): say so,
          // not that there is no browser.
          const reason = failed instanceof Error ? failed.message : String(failed);
          throw new PreviewError(
            "PREVIEW_UNAVAILABLE",
            `The browser did not start: ${reason.split("\n")[0]}`,
          );
        }
      }
    } catch (cause) {
      if (cause instanceof PreviewError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new PreviewError(
        "PREVIEW_UNAVAILABLE",
        missing(message)
          ? NO_BROWSER_MESSAGE
          : `The browser did not start: ${message.split("\n")[0]}`,
      );
    }
  }

  #launch(): Promise<Browser> {
    this.#browser ??= (async () => {
      const chromium = await this.#chromium();
      const browser = await this.#start((options) => chromium.launch(options));
      browser.on("disconnected", () => {
        this.#browser = undefined;
        // Incognito lived in this browser; persistent profiles run their own.
        this.#profiles.delete(INCOGNITO_BROWSER_PROFILE_ID);
      });
      return browser;
    })();
    const launching = this.#browser;
    // A launch that failed is tried again by the next tab.
    launching.catch(() => {
      if (this.#browser === launching) this.#browser = undefined;
    });
    return launching;
  }

  async #newContext(): Promise<BrowserContext> {
    const browser = await this.#launch();
    return browser.newContext({ viewport: DEFAULT_VIEWPORT, deviceScaleFactor: RENDER_SCALE });
  }

  /** The folder of a persistent profile; `.` and `..` cannot name a parent (T3). */
  #profileDirectory(profileId: string): string {
    const encoded = encodeURIComponent(profileId);
    return Path.join(
      this.#options.profilesDir ?? Path.join(Os.tmpdir(), "jhin-preview-profiles"),
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  /** A profile's context, started for its first tab. */
  #profile(profileId: string): Promise<BrowserContext> {
    const cached = this.#profiles.get(profileId);
    if (cached !== undefined) return cached;
    const cleared = this.#clearing.get(profileId)?.catch(() => undefined) ?? Promise.resolve();
    const pending = cleared.then(async () => {
      if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return this.#newContext();
      const directory = this.#profileDirectory(profileId);
      await Fs.promises.mkdir(directory, { recursive: true });
      const chromium = await this.#chromium();
      return this.#start((options) =>
        chromium.launchPersistentContext(directory, {
          ...options,
          viewport: DEFAULT_VIEWPORT,
          deviceScaleFactor: RENDER_SCALE,
        }),
      );
    });
    this.#profiles.set(profileId, pending);
    pending.then(
      (context) => {
        context.on("close", () => {
          if (this.#profiles.get(profileId) === pending) this.#profiles.delete(profileId);
        });
        // A persistent profile reopens with a blank page of its own: tabs bring theirs.
        for (const page of context.pages()) void page.close().catch(() => undefined);
      },
      () => {
        if (this.#profiles.get(profileId) === pending) this.#profiles.delete(profileId);
      },
    );
    return pending;
  }

  /** A new page: in its profile's context, or alone in a context of its own. */
  async newPage(
    isolated: boolean,
    profileId: string = DEFAULT_BROWSER_PROFILE_ID,
  ): Promise<{ page: Page; context: BrowserContext }> {
    const context = isolated ? await this.#newContext() : await this.#profile(profileId);
    return { page: await context.newPage(), context };
  }

  /**
   * Forgets a profile's cookies and storage (T3's "Clear profile"): its tabs
   * close with its context, and its folder goes. Incognito has nothing kept.
   */
  async clearProfile(profileId: string): Promise<void> {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const clearing = (async () => {
      const pending = this.#profiles.get(profileId);
      if (pending !== undefined) {
        this.#profiles.delete(profileId);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await Fs.promises.rm(this.#profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.#clearing.set(profileId, clearing);
    try {
      await clearing;
    } finally {
      if (this.#clearing.get(profileId) === clearing) this.#clearing.delete(profileId);
    }
  }

  /** A page for the recording encoder, alone in its own context. */
  async scratchPage(): Promise<Page> {
    return (await this.#newContext()).newPage();
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    const profiles = [...this.#profiles.values()];
    this.#browser = undefined;
    this.#profiles.clear();
    await Promise.all(
      profiles.map((pending) => pending.then((context) => context.close()).catch(() => undefined)),
    );
    await browser?.then((running) => running.close()).catch(() => undefined);
  }
}
