import {
  CHAT_TOOLS_CAPABILITY,
  type ChatToolGroup,
  type ChatTools,
  type ChatTurnItemProps,
} from "@jhin/client-api";
import { HtmlRenderEvents, type HtmlRenderedPayload } from "@jhin/preview-api";
import { definePlugin } from "@jhin/sdk";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";

// A chunk of its own, loaded with the first rendered page (D440).
const Frame = lazyChunk<{ page: HtmlRenderedPayload }>(
  () => import("./frame.tsx").then((module) => module.HtmlRenderFrame),
  {
    loading: ({ page }) => (
      <div
        aria-label={`Loading ${page.title}`}
        className="mx-1 mb-4 animate-pulse rounded-lg bg-muted-foreground/10"
        role="status"
        style={{ height: page.height }}
      />
    ),
    failed: ({ page }, retry) => (
      <ChunkFailed retry={retry}>{`Unable to load ${page.title}`}</ChunkFailed>
    ),
  },
);

const pages = (count: number) => `${count} HTML ${count === 1 ? "page" : "pages"}`;

// T3's labels and summaries of `html_preview` and `html_render` (MIT, see THIRD_PARTY_NOTICES.md:
// packages/shared/src/t3McpToolPresentation.ts, client-runtime's t3ToolSummary.ts; preview.md D1681).
const PREVIEW_LABELS = ["Preview", "Previewing", "Previewed", "an HTML page"] as const;
const RENDER_LABELS = ["Render", "Rendering", "Rendered", "an HTML page"] as const;
const PREVIEWED: ChatToolGroup = {
  id: "html-preview",
  past: "Previewed",
  infinitive: "preview",
  object: pages,
};
const RENDERED: ChatToolGroup = {
  id: "html-render",
  past: "Rendered",
  infinitive: "render",
  object: pages,
};

function readPayload(payload: unknown): HtmlRenderedPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const page = payload as Partial<HtmlRenderedPayload>;
  return typeof page.renderId === "string" &&
    typeof page.html === "string" &&
    typeof page.title === "string" &&
    typeof page.height === "number"
    ? (page as HtmlRenderedPayload)
    : undefined;
}

/**
 * `jhin.html-render-view`: pages an agent rendered with `html.render`, shown
 * in their turn through the `chat.turn.item` slot (docs/plans/preview.md, D407).
 */
export const htmlRenderViewPlugin = builtin(
  "jhin.html-render-view",
  // The tools in the work log (D1681).
  { requires: { [UI_SLOTS_CAPABILITY]: "^1" }, optional: { [CHAT_TOOLS_CAPABILITY]: "^1" } },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const chatTools = context.services.tryGet<ChatTools>(CHAT_TOOLS_CAPABILITY);
      if (chatTools !== undefined) {
        context.subscriptions.add(
          chatTools.describe("html.preview", { labels: PREVIEW_LABELS, group: PREVIEWED }),
        );
        context.subscriptions.add(
          chatTools.describe("html.render", { labels: RENDER_LABELS, group: RENDERED }),
        );
      }
      function RenderedPage({ event }: ChatTurnItemProps) {
        if (event.type !== HtmlRenderEvents.rendered) return null;
        const page = readPayload(event.payload);
        return page === undefined ? null : <Frame page={page} />;
      }
      context.subscriptions.add(
        slots.contribute<ChatTurnItemProps>("chat.turn.item", {
          id: "jhin.html-render.frame",
          component: RenderedPage,
        }),
      );
    },
  }),
);
