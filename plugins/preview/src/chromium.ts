// Launching and presenting the browser follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/preview/ServerBrowserContexts.ts (launch arguments, contexts, presentAsChrome).
import * as Os from "node:os";

import { PreviewError } from "@jhin/preview-api";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

/** Device pixels per CSS pixel every tab renders at. */
export const RENDER_SCALE = 2;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface ChromiumOptions {
  /** A Chromium to run instead of the one Playwright installs. */
  readonly executablePath?: (() => string | undefined) | undefined;
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
 * The node's one browser (D394): started for the first tab, closed after the
 * last one. Human tabs share a context; an agent's tab gets its own.
 */
export class Chromium {
  readonly #options: ChromiumOptions;
  #browser: Promise<Browser> | undefined;
  #shared: Promise<BrowserContext> | undefined;

  constructor(options: ChromiumOptions = {}) {
    this.#options = options;
  }

  #launch(): Promise<Browser> {
    this.#browser ??= (async () => {
      const { chromium } = await import("playwright-core");
      const executablePath = this.#options.executablePath?.();
      try {
        const browser = await chromium.launch({
          ...(executablePath === undefined ? {} : { executablePath }),
          args: [
            "--disable-gpu",
            `--force-device-scale-factor=${RENDER_SCALE}`,
            "--disable-blink-features=AutomationControlled",
          ],
          ignoreDefaultArgs: ["--enable-automation"],
          headless: true,
        });
        browser.on("disconnected", () => {
          this.#browser = undefined;
          this.#shared = undefined;
        });
        return browser;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const missing = /Executable doesn't exist|Failed to launch|ENOENT/i.test(message);
        throw new PreviewError(
          "PREVIEW_UNAVAILABLE",
          missing ? NO_BROWSER_MESSAGE : `The browser did not start: ${message.split("\n")[0]}`,
        );
      }
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

  /** A new page: in the shared context, or alone in a context of its own. */
  async newPage(isolated: boolean): Promise<{ page: Page; context: BrowserContext }> {
    let context: BrowserContext;
    if (isolated) {
      context = await this.#newContext();
    } else {
      const shared = (this.#shared ??= this.#newContext());
      shared.catch(() => {
        if (this.#shared === shared) this.#shared = undefined;
      });
      context = await shared;
    }
    return { page: await context.newPage(), context };
  }

  /** A page for the recording encoder, alone in its own context. */
  async scratchPage(): Promise<Page> {
    return (await this.#newContext()).newPage();
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    this.#shared = undefined;
    await browser?.then((running) => running.close()).catch(() => undefined);
  }
}
