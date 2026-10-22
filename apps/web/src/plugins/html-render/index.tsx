import type { ChatTurnItemProps } from "@jhin/client-api";
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
  { requires: { [UI_SLOTS_CAPABILITY]: "^1" } },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
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
