// The place a desktop tab's webview takes follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/browser/BrowserSurfaceSlot.tsx and browserViewportLayout.ts (a preset
// centred and scaled down to fit).
import type { PreviewTab } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { useEffect, useRef } from "react";

import type { NativePlacement, NativeSurfaces } from "./native-surfaces.ts";

const RESIZE_THROTTLE_MS = 150;

export interface NativeSurfaceProps {
  readonly client: RpcClient;
  readonly surfaces: NativeSurfaces;
  readonly tab: PreviewTab;
  readonly viewer: string;
  /** This viewer holds control. */
  readonly canOperate: boolean;
  /** Whether the page takes the surface's size in fill mode (the panel's; not the mini player's). */
  readonly followSize?: boolean;
  /** The surface shows something over the page (a dialog, an error): the webview steps aside. */
  readonly hidden?: boolean;
  readonly zIndex: number;
  /**
   * The webview lies under this surface (the mini player's, so its pill stays
   * on top): the box is see-through and lets the pointer through to the page.
   */
  readonly underlay?: boolean;
  readonly onError?: (error: unknown) => void;
}

/** The page's place inside a surface's box (T3's viewport layout). */
function nativePlacement(
  box: { left: number; top: number; width: number; height: number },
  tab: Pick<PreviewTab, "viewport" | "size" | "zoomFactor">,
  followSize: boolean,
): Omit<NativePlacement, "blocked" | "zIndex"> {
  box = {
    left: Math.round(box.left),
    top: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  const fill = tab.viewport.mode === "fill";
  // The panel's fill page is its box; the mini player shows the page at the size it has.
  if (fill && followSize) {
    return { ...box, scale: 1, zoomFactor: tab.zoomFactor };
  }
  const page =
    tab.viewport.mode === "fill"
      ? tab.size
      : { width: tab.viewport.width, height: tab.viewport.height };
  const fit = Math.min(box.width / page.width, box.height / page.height);
  // A preset is never shown larger than it is; the mini player scales its page either way.
  const scale = fill ? fit : Math.min(1, fit);
  return {
    left: Math.round(box.left + (box.width - page.width * scale) / 2),
    top: Math.round(box.top + (box.height - page.height * scale) / 2),
    width: Math.round(page.width),
    height: Math.round(page.height),
    scale,
    zoomFactor: tab.zoomFactor,
  };
}

/**
 * A desktop tab in a surface (D1324): the app's webview is laid over this
 * box; while the page takes no input from this viewer, the box takes it.
 */
export function NativeSurface(props: NativeSurfaceProps) {
  const { client, surfaces, tab, viewer, canOperate, zIndex } = props;
  const followSize = props.followSize ?? true;
  const boxRef = useRef<HTMLDivElement>(null);
  const owner = useRef(Symbol("surface"));
  const onError = useRef(props.onError);
  onError.current = props.onError;
  // Another viewer or the agent holds the tab: the page is theirs (D397).
  const blocked = !canOperate && tab.owner !== "unclaimed";
  const hidden = props.hidden ?? false;

  // The box is measured every frame: a panel resizes, a mini player moves.
  const latest = useRef({ tab, blocked, hidden });
  latest.current = { tab, blocked, hidden };
  useEffect(() => {
    let frame = requestAnimationFrame(function measure() {
      const box = boxRef.current;
      const now = latest.current;
      if (box === null || now.hidden) {
        surfaces.place(tab.threadId, tab.tabId, owner.current, null);
      } else {
        const rect = box.getBoundingClientRect();
        surfaces.place(
          tab.threadId,
          tab.tabId,
          owner.current,
          rect.width < 1 || rect.height < 1
            ? null
            : {
                ...nativePlacement(rect, now.tab, followSize),
                blocked: now.blocked,
                zIndex,
              },
        );
      }
      frame = requestAnimationFrame(measure);
    });
    const placed = owner.current;
    return () => {
      cancelAnimationFrame(frame);
      surfaces.place(tab.threadId, tab.tabId, placed, null);
    };
  }, [surfaces, tab.threadId, tab.tabId, followSize, zIndex]);

  // The panel's size is the page's in fill mode: the node keeps it for the tab's summary.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !followSize) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      timer = undefined;
      const { width, height } = box.getBoundingClientRect();
      if (width < 100 || height < 100) return;
      void client
        .call("preview.tab.input", {
          threadId: tab.threadId,
          tabId: tab.tabId,
          viewer,
          events: [
            {
              type: "resize",
              width: Math.min(Math.round(width), 3840),
              height: Math.min(Math.round(height), 2160),
              scale: Math.min(Math.max(window.devicePixelRatio || 1, 0.5), 4),
            },
          ],
        })
        .catch((error: unknown) => onError.current?.(error));
    };
    const observer = new ResizeObserver(() => {
      timer ??= setTimeout(report, RESIZE_THROTTLE_MS);
    });
    observer.observe(box);
    report();
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, tab.threadId, tab.tabId, viewer, followSize]);

  return (
    <div
      aria-label={blocked ? "Browser page (take control to use it)" : "Browser page"}
      className={
        props.underlay === true
          ? blocked
            ? "relative size-full"
            : "pointer-events-none relative size-full"
          : "relative size-full bg-muted"
      }
      data-preview-native=""
      ref={boxRef}
      role="region"
    />
  );
}
