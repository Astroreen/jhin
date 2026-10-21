// The tools' descriptions and results follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/mcp/toolkits/html/tools.ts and handlers.ts, and HtmlRender.ts (prepare,
// preview and publish).
import * as Crypto from "node:crypto";

import { ThreadEvents, threadStream } from "@jhin/agent-api";
import {
  HTML_PAGE_RULES,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MEASURE_WIDTHS,
  HTML_RENDER_THEME_GUIDE,
  HtmlPreviewInput,
  HtmlPreviewResult,
  HtmlRenderError,
  HtmlRenderEvents,
  HtmlRenderInput,
  HtmlRenderResult,
  PREVIEW_HTML_CAPABILITY,
  clampHtmlRenderHeight,
  injectHtmlRenderBootstrap,
} from "@jhin/preview-api";
import { definePlugin, z, describePermissions } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";

import { inlineLocalImages, missingImagesError } from "./inline.ts";
import { createRenderer } from "./render.ts";

const CONFIG_SECTION = "jhin.html-render";
/** Previews and renders at once, as T3 runs at most two headless browsers. */
const MAX_RUNNING = 2;

/** Runs at most `count` tasks at once; the others wait their turn, in order. */
function createLimit(count: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <A>(task: () => Promise<A>): Promise<A> => {
    if (running >= count) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** Reads back from the end of the thread, a page at a time, to the latest turn's start. */
async function runningTurnOf(log: EventLog, stream: string, head: number) {
  const ended = new Set<string>();
  for (let end = head; end > 0; end -= 500) {
    const page = await log.read(stream, { after: Math.max(0, end - 500), limit: 500 });
    const found = runningTurn(page, ended);
    if (found !== null) return found;
  }
  return undefined;
}

/**
 * The turn still running at the end of `events`: its id, `undefined` when the latest turn
 * ended, or `null` when `events` hold no turn start (read further back).
 */
function runningTurn(
  events: readonly { type: string; payload: unknown }[],
  ended: Set<string>,
): string | undefined | null {
  for (const event of events.toReversed()) {
    const turnId = (event.payload as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId !== "string") continue;
    if (
      event.type === ThreadEvents.turnCompleted ||
      event.type === ThreadEvents.turnInterrupted ||
      event.type === ThreadEvents.turnFailed
    ) {
      ended.add(turnId);
    } else if (event.type === ThreadEvents.turnStarted) {
      return ended.has(turnId) ? undefined : turnId;
    }
  }
  return null;
}
const MIB = 1024 * 1024;
/** The largest page html.render stores in a thread. */
const MAX_RENDERED_BYTES = 4 * MIB;

const Config = z
  .object({
    executablePath: z
      .string()
      .min(1)
      .optional()
      .meta({
        title: "Browser",
        description:
          "The Chromium pages are rendered with; the one `npx playwright install chromium` installs when unset.",
        examples: ["/usr/bin/chromium"],
      }),
  })
  .meta({
    title: "Rendered HTML",
    description: "Pages agents check with html_preview and show in a thread with html_render.",
  });
type Config = z.output<typeof Config>;

export default definePlugin({
  activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const renderer = createRenderer({
      executablePath: () => context.config.get<Config>(CONFIG_SECTION).executablePath,
    });
    context.onDeactivate(() => renderer.close());
    context.services.provide(PREVIEW_HTML_CAPABILITY, { renderer });
    const limit = createLimit(MAX_RUNNING);

    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "preview.write": {
        title: "Control previews",
        description: "Open browser previews and host browser automation.",
      },
    });
    context.commands.register({
      name: "html.preview",
      title: "Preview HTML",
      description: `Render an HTML page in the node's headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. ${HTML_PAGE_RULES} The page gets the theme variables and layout described in html_render.`,
      input: HtmlPreviewInput,
      output: HtmlPreviewResult,
      // The browser runs on the node and the page's images are the node's files.
      permissions: ["preview.write"],
      handler: (input) =>
        limit(async () => {
          const width = input.width ?? HTML_RENDER_COLUMN_WIDTH;
          const { html, missing } = await inlineLocalImages(injectHtmlRenderBootstrap(input.html));
          const rendered = await renderer.preview(html, width, input.appearance ?? "dark");
          return {
            width,
            contentHeight: rendered.contentHeight,
            capturedHeight: rendered.capturedHeight,
            consoleMessages: rendered.consoleMessages,
            ...(missing.length === 0 ? {} : { missingImages: missing }),
            screenshot: {
              mimeType: "image/png" as const,
              data: rendered.png,
              width,
              height: rendered.capturedHeight,
            },
          };
        }),
    });

    context.commands.register({
      name: "html.render",
      title: "Render HTML",
      description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with html_preview first. Jhin fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. ${HTML_PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
      input: HtmlRenderInput,
      output: HtmlRenderResult,
      permissions: ["threads.write"],
      handler: (input) =>
        limit(async () => {
          const stream = threadStream(input.threadId);
          const head = await log.head(stream);
          if (head === 0) {
            throw new HtmlRenderError(
              "HTML_RENDER_FAILED",
              `Thread ${input.threadId} was not found.`,
            );
          }
          // The turn running now owns the page, even if another starts while it is measured.
          const turnId = await runningTurnOf(log, stream, head);
          const { html, missing } = await inlineLocalImages(injectHtmlRenderBootstrap(input.html));
          if (missing.length > 0) throw missingImagesError(missing);
          // The page lives in the thread's event log and travels with it to every client and
          // mesh member, so it stays far below what one event may carry (D406).
          const bytes = Buffer.byteLength(html);
          if (bytes > MAX_RENDERED_BYTES) {
            throw new HtmlRenderError(
              "HTML_RENDER_INVALID_PAGE",
              `With its images inlined the page is ${(bytes / MIB).toFixed(1)} MiB; a page shown in a thread is at most ${(MAX_RENDERED_BYTES / MIB).toFixed(1)} MiB. Use smaller images.`,
            );
          }
          // Heights per width let every reader's frame fit at once; a page that cannot be
          // measured is shown at the height the agent gave.
          const heights = await renderer
            .measure(html, HTML_RENDER_MEASURE_WIDTHS)
            .then((measured) =>
              measured.map(
                ([width, height]) => [width, clampHtmlRenderHeight(height)] as [number, number],
              ),
            )
            .catch((error: unknown) => {
              context.log.warn("Could not measure an HTML render; publishing it without heights.", {
                error: String(error),
              });
              return undefined;
            });
          const reference = {
            renderId: Crypto.randomUUID(),
            title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
            height: clampHtmlRenderHeight(input.height),
            ...(heights === undefined ? {} : { heights }),
          };
          // In the thread's stream, so the page travels with the thread (D406); the latest turn
          // shows it (D407).
          await log.append(stream, [
            {
              type: HtmlRenderEvents.rendered,
              payload: { ...reference, ...(turnId === undefined ? {} : { turnId }), html },
            },
          ]);
          return {
            htmlRender: reference,
            message:
              "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
          };
        }),
    });
  },
});
