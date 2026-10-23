// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ChatCanvas.tsx
// (measuring the chat's lane and laying the floating preview beside it, docs/plans/preview.md, D1326).
import type { ChatCanvas, ChatCanvasPreview } from "@jhin/client-api";
import { useCallback, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";

import { resolveChatCanvasLayout } from "../../lib/chat-canvas-layout.ts";

interface Measurements {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly maxChatWidth: number;
  readonly minChatWidth: number;
  readonly timelineGutter: number;
  readonly findBar: { left: number; right: number; bottom: number } | null;
}

const orInitial = (value: number, initial: number) => (Number.isNaN(value) ? initial : value);

const INITIAL: Measurements = {
  width: 0,
  height: 0,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  timelineGutter: 0,
  findBar: null,
};

const same = (a: Measurements, b: Measurements) =>
  a.width === b.width &&
  a.height === b.height &&
  a.padding === b.padding &&
  a.maxChatWidth === b.maxChatWidth &&
  a.minChatWidth === b.minChatWidth &&
  a.timelineGutter === b.timelineGutter &&
  a.findBar?.left === b.findBar?.left &&
  a.findBar?.right === b.findBar?.right &&
  a.findBar?.bottom === b.findBar?.bottom;

/**
 * T3's chat canvas: the area of the messages and the composer, where a
 * floating player reports itself and the chat's lane moves aside for it.
 * `probe` is an invisible element sized like the lane (its padding and
 * widths); `timeline` is the scrolling messages, whose gutter is measured.
 */
export function useChatCanvas(input: {
  readonly element: HTMLElement | null;
  readonly probe: HTMLElement | null;
  readonly timeline: HTMLElement | null;
  readonly composerHeight: number;
  /** The find bar is open: the player keeps clear of it. */
  readonly findOpen: boolean;
}): {
  readonly canvas: ChatCanvas;
  readonly style: CSSProperties;
  readonly overlapsChat: boolean;
  /** How far the lane's end moves in for the player, in CSS pixels. */
  readonly insetEnd: number;
} {
  const { element, probe, timeline, composerHeight, findOpen } = input;
  const [preview, setPreview] = useState<ChatCanvasPreview | null>(null);
  const [measured, setMeasured] = useState<Measurements>(INITIAL);

  useLayoutEffect(() => {
    if (element === null || probe === null) return;
    const observer = new ResizeObserver(() => measure());
    // The find bar is a chunk of its own: it may mount after the flag says it is open, so it
    // is looked for on every measure and observed once it is there.
    let findBar: HTMLElement | null = null;
    const lookUp = () =>
      findOpen ? element.querySelector<HTMLElement>("[data-thread-find-bar]") : null;
    const measure = () => {
      const found = lookUp();
      if (found !== findBar) {
        if (findBar !== null) observer.unobserve(findBar);
        findBar = found;
        if (findBar !== null) observer.observe(findBar);
      }
      const bounds = element.getBoundingClientRect();
      const bar = findBar?.getBoundingClientRect();
      const styles = getComputedStyle(probe);
      const next: Measurements = {
        width: element.clientWidth,
        height: element.clientHeight,
        // The lane pads both sides alike, so either side gives it; the layout itself is
        // left to right (a right-to-left canvas is Deferred).
        // Unreadable: T3's lane padding. A padding of 0 is a padding, so only NaN falls back.
        padding: orInitial(Number.parseFloat(styles.paddingInlineStart), INITIAL.padding),
        maxChatWidth: orInitial(Number.parseFloat(styles.width), INITIAL.maxChatWidth),
        minChatWidth: orInitial(Number.parseFloat(styles.minWidth), INITIAL.minChatWidth),
        timelineGutter: timeline === null ? 0 : (timeline.offsetWidth - timeline.clientWidth) / 2,
        findBar:
          bar === undefined
            ? null
            : {
                left: bar.left - bounds.left,
                right: bar.right - bounds.left,
                bottom: bar.bottom - bounds.top,
              },
      };
      setMeasured((current) => (same(current, next) ? current : next));
    };
    measure();
    // The border box: the probe's padding changes at the breakpoint while its content does not,
    // and the timeline's gutter is in its border box too.
    for (const observed of [element, probe, timeline]) {
      if (observed !== null) observer.observe(observed, { box: "border-box" });
    }
    // While the bar is open, the canvas's own children change when it mounts or goes: the bar is
    // one of them (its chunk adds no element), so the messages streaming deeper down are not
    // watched. Its size after that reaches the resize observer.
    const mounts = findOpen
      ? new MutationObserver(() => {
          if (lookUp() !== findBar) measure();
        })
      : undefined;
    mounts?.observe(element, { childList: true });
    return () => {
      observer.disconnect();
      mounts?.disconnect();
    };
  }, [element, probe, timeline, findOpen]);

  const report = useCallback((next: ChatCanvasPreview) => {
    setPreview((current) =>
      current?.key === next.key &&
      current.width === next.width &&
      current.lastInteraction === next.lastInteraction &&
      current.position?.x === next.position?.x &&
      current.position?.y === next.position?.y &&
      current.source.width === next.source.width &&
      current.source.height === next.source.height
        ? current
        : next,
    );
  }, []);
  const clear = useCallback(
    (key: string) => setPreview((current) => (current?.key === key ? null : current)),
    [],
  );

  const container = useMemo(
    () => ({ width: measured.width, height: measured.height }),
    [measured.width, measured.height],
  );
  const layout = resolveChatCanvasLayout({
    container,
    preview,
    padding: measured.padding,
    maxChatWidth: measured.maxChatWidth,
    minChatWidth: measured.minChatWidth,
    composerHeight,
    findBar: measured.findBar,
  });
  // The layout gives a new frame on every render: it is kept while its values stay.
  const { x, y, width, height } = layout.frame ?? {};
  const frame = useMemo(
    () =>
      x === undefined || y === undefined || width === undefined || height === undefined
        ? null
        : { x, y, width, height },
    [x, y, width, height],
  );
  const previewKey = preview?.key ?? null;
  const canvas = useMemo<ChatCanvas>(
    () => ({ container, previewKey, frame, report, clear }),
    [container, previewKey, frame, report, clear],
  );
  return {
    canvas,
    overlapsChat: layout.overlapsChat,
    insetEnd: layout.chat.insetEnd,
    style: {
      "--chat-timeline-gutter": `${measured.timelineGutter}px`,
      "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
      "--chat-lane-inset-end": `${layout.chat.insetEnd}px`,
    } as CSSProperties,
  };
}
