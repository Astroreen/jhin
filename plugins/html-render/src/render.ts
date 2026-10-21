// Rendering a page follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/htmlRender/
// headlessChrome.ts (serving the page from a fake origin, blocking what it may not reach, settling
// on fonts and two frames, measuring its height, the console capture and its limits, the capped
// screenshot) and publicProxy.ts (which addresses count as private).
import {
  HTML_RENDER_MEASURE_FONTS,
  HtmlRenderError,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  type HtmlConsoleMessage,
  type HtmlRenderAppearance,
} from "@jhin/preview-api";
import type { Browser, Page } from "playwright-core";

import { startPublicProxy } from "./proxy.ts";

const PAGE_ORIGIN = "http://jhin-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT = 500;
const MAX_CAPTURED_HEIGHT = 4000;
const LOAD_TIMEOUT_MS = 20_000;
const MEASURE_CONCURRENCY = 3;

const NO_BROWSER_MESSAGE =
  "The node has no browser to render pages with. Install one with `npx playwright install chromium`, or set jhin.html-render.executablePath.";

// --- The browser ----------------------------------------------------------------------------

export interface RendererOptions {
  readonly executablePath?: () => string | undefined;
}

/** One headless Chromium, started for the first page and closed when the last one is done. */
export function createRenderer(options: RendererOptions = {}) {
  let browser: Promise<{ browser: Browser; close(): Promise<void> }> | undefined;
  let jobs = 0;

  const launch = () => {
    browser ??= (async () => {
      const { chromium } = await import("playwright-core");
      const executablePath = options.executablePath?.();
      // Every request of the page, loopback ones and WebSockets included, goes through the
      // proxy, which reaches only public addresses (D405).
      const proxy = await startPublicProxy();
      try {
        const launched = await chromium.launch({
          ...(executablePath === undefined ? {} : { executablePath }),
          args: [
            "--disable-gpu",
            "--hide-scrollbars",
            "--mute-audio",
            `--proxy-server=socks5://127.0.0.1:${proxy.port}`,
            "--proxy-bypass-list=<-loopback>",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ],
          headless: true,
        });
        return {
          browser: launched,
          close: async () => {
            await launched.close().catch(() => undefined);
            await proxy.close();
          },
        };
      } catch (cause) {
        await proxy.close();
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new HtmlRenderError(
          "HTML_RENDER_UNAVAILABLE",
          /Executable doesn't exist|ENOENT/i.test(message)
            ? NO_BROWSER_MESSAGE
            : `Headless Chrome could not render the page: ${message.split("\n")[0]}.`,
        );
      }
    })();
    const launching = browser;
    launching.catch(() => {
      if (browser === launching) browser = undefined;
    });
    return launching;
  };

  /** Holds the browser open while `work` runs; the last one done closes it. */
  async function holding<A>(work: () => Promise<A>): Promise<A> {
    jobs += 1;
    try {
      return await work();
    } finally {
      jobs -= 1;
      if (jobs === 0) {
        const running = browser;
        browser = undefined;
        await running?.then((each) => each.close()).catch(() => undefined);
      }
    }
  }

  /** Runs `work` on a fresh page of the browser. */
  function withPage<A>(width: number, work: (page: Page) => Promise<A>): Promise<A> {
    return holding(async () => {
      const context = await (
        await launch()
      ).browser.newContext({
        viewport: { width, height: 800 },
        deviceScaleFactor: 1,
      });
      try {
        // WebRTC could reach the network around the proxy.
        await context.addInitScript(
          "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;",
        );
        return await work(await context.newPage());
      } finally {
        await context.close().catch(() => undefined);
      }
    });
  }

  /** Loads the page as it renders for a reader at `width`, settled and measured. */
  async function load(
    page: Page,
    html: string,
    appearance: HtmlRenderAppearance,
    consoleMessages?: HtmlConsoleMessage[],
  ): Promise<number> {
    let omitted = 0;
    const record = (level: HtmlConsoleMessage["level"], text: string) => {
      if (consoleMessages === undefined) return;
      if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
        omitted += 1;
        return;
      }
      const shown = text.replaceAll(PAGE_URL, "page.html");
      consoleMessages.push({
        level,
        text: shown.length > MAX_CONSOLE_TEXT ? `${shown.slice(0, MAX_CONSOLE_TEXT)}…` : shown,
      });
    };
    page.on("console", (message) => {
      const type = message.type();
      const level =
        type === "info"
          ? "info"
          : type === "warning"
            ? "warning"
            : type === "error" || type === "assert"
              ? "error"
              : "log";
      record(level, message.text());
    });
    page.on("pageerror", (error) => record("error", error.stack ?? error.message));
    await page.route(`${PAGE_URL}*`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    const fragment = htmlRenderThemeFragment(
      htmlRenderTheme(appearance, HTML_RENDER_MEASURE_FONTS),
    );
    try {
      const deadline = Date.now() + LOAD_TIMEOUT_MS;
      await page.goto(`${PAGE_URL}${fragment}`, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      // Fonts and two frames, so the layout is the one a reader sees; within the same deadline.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error("settle");
            error.name = "TimeoutError";
            reject(error);
          },
          Math.max(0, deadline - Date.now()),
        );
      });
      const settled = page.evaluate(`(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const root = document.documentElement;
        return Math.max(0, Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height));
      })()`) as Promise<number>;
      void settled.catch(() => undefined);
      try {
        return await Promise.race([settled, late]);
      } finally {
        clearTimeout(timer);
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new HtmlRenderError(
          "HTML_RENDER_FAILED",
          "Headless Chrome could not render the page: the page did not finish loading within 20 seconds.",
        );
      }
      throw cause;
    } finally {
      if (omitted > 0) {
        consoleMessages?.push({
          level: "warning",
          text: `${omitted} more console messages were omitted.`,
        });
      }
    }
  }

  return {
    /** A screenshot of the page at `width`, its height and its console. */
    async preview(html: string, width: number, appearance: HtmlRenderAppearance) {
      return withPage(width, async (page) => {
        const consoleMessages: HtmlConsoleMessage[] = [];
        const contentHeight = await load(page, html, appearance, consoleMessages);
        const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURED_HEIGHT));
        const png = await page.screenshot({
          type: "png",
          fullPage: true,
          clip: { x: 0, y: 0, width, height: capturedHeight },
        });
        return { contentHeight, capturedHeight, consoleMessages, png: png.toString("base64") };
      });
    },

    /** The page's height at each width, smallest width first. */
    async measure(html: string, widths: readonly number[]): Promise<[number, number][]> {
      return holding(async () => {
        const heights: [number, number][] = [];
        const queue = [...widths];
        // The first failure stops every worker, so none opens pages after the caller moved on.
        let failed = false;
        const worker = async () => {
          for (let width = queue.shift(); width !== undefined && !failed; width = queue.shift()) {
            const measured = width;
            try {
              heights.push([
                measured,
                await withPage(measured, (page) => load(page, html, "dark")),
              ]);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        };
        const results = await Promise.allSettled(
          Array.from({ length: MEASURE_CONCURRENCY }, worker),
        );
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected !== undefined) throw rejected.reason;
        return heights.toSorted((a, b) => a[0] - b[0]);
      });
    },

    async close(): Promise<void> {
      const running = browser;
      browser = undefined;
      await running?.then((each) => each.close()).catch(() => undefined);
    },
  };
}
