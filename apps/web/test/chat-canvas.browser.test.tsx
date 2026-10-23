import type { ChatCanvas } from "@jhin/client-api";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useChatCanvas } from "../src/plugins/chat/chat-canvas.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A chat area of `width` × 800 with T3's lane probe (48 px padding, 768 to 640 px wide). */
async function mount(width: number, findOpen = false, barLater = false) {
  const seen: { canvas?: ChatCanvas; style?: Record<string, string> } = {};
  function Area() {
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const [probe, setProbe] = useState<HTMLDivElement | null>(null);
    const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
    const { canvas, style } = useChatCanvas({
      element,
      probe,
      timeline,
      composerHeight: 150,
      findOpen,
    });
    useEffect(() => {
      seen.canvas = canvas;
      seen.style = style as Record<string, string>;
    });
    return (
      <div ref={setElement} style={{ position: "relative", width, height: 800, ...style }}>
        <div
          data-test-probe=""
          ref={setProbe}
          style={{
            position: "absolute",
            height: 0,
            width: 768,
            minWidth: 640,
            paddingLeft: 48,
            boxSizing: "content-box",
          }}
        />
        {findOpen && !barLater ? (
          <div
            data-thread-find-bar=""
            style={{ position: "absolute", top: 12, right: 12, width: 352, height: 40 }}
          />
        ) : null}
        <div ref={setTimeline} style={{ height: 600, overflowY: "scroll" }}>
          <div style={{ height: 2000 }} />
        </div>
      </div>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Area />));
  if (barLater) {
    // The find bar is a chunk of its own: it mounts after the flag says it is open.
    const bar = document.createElement("div");
    bar.dataset["threadFindBar"] = "";
    Object.assign(bar.style, {
      position: "absolute",
      top: "12px",
      right: "12px",
      width: "352px",
      height: "40px",
    });
    await act(async () => container.firstElementChild!.append(bar));
  }
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return seen;
}

const report = (canvas: ChatCanvas, position: { x: number; y: number } | null = null) =>
  act(async () =>
    canvas.report({
      key: "tab-a",
      width: 320,
      position,
      source: { width: 1280, height: 800 },
      lastInteraction: "drag",
    }),
  );

describe("T3's chat canvas (D1326)", () => {
  it("measures the area and moves the lane aside for a player in its corner", async () => {
    const seen = await mount(1144);
    expect(seen.canvas!.container).toEqual({ width: 1144, height: 800 });
    expect(seen.canvas!.frame).toBeNull();
    expect(seen.style!["--chat-lane-inset-end"]).toBe("0px");
    await report(seen.canvas!);
    const frame = seen.canvas!.frame!;
    expect(seen.canvas!.previewKey).toBe("tab-a");
    expect(frame).toMatchObject({ width: 320, height: 200 });
    // The lane moved left of the player, which keeps the bottom corner beside the composer.
    expect(Number.parseFloat(seen.style!["--chat-lane-inset-end"]!)).toBeGreaterThan(0);
    expect(frame.y + frame.height).toBe(800 - 12);
    await act(async () => seen.canvas!.clear("tab-a"));
    expect(seen.canvas!.frame).toBeNull();
  });

  it("keeps a player dragged to the top clear of the open find bar", async () => {
    const seen = await mount(1144, true);
    await report(seen.canvas!, { x: 800, y: 0 });
    const frame = seen.canvas!.frame!;
    // The find bar's 12 + 40 px, then T3's gap.
    expect(frame.x + frame.width <= 1144 - 12 - 352 || frame.y >= 52 + 12).toBe(true);
  });

  it("measures the timeline's scrollbar gutter", async () => {
    const seen = await mount(1144);
    expect(seen.style!["--chat-timeline-gutter"]).toMatch(/^\d+(\.\d+)?px$/);
  });

  it("finds the find bar when it mounts after the flag", async () => {
    const seen = await mount(1144, true, true);
    await report(seen.canvas!, { x: 800, y: 0 });
    const frame = seen.canvas!.frame!;
    expect(frame.x + frame.width <= 1144 - 12 - 352 || frame.y >= 52 + 12).toBe(true);
  });

  it("measures the lane again when its padding changes at a breakpoint", async () => {
    const seen = await mount(1144);
    await report(seen.canvas!);
    const before = seen.style!["--chat-lane-inset-end"];
    // The breakpoint's padding: the probe's border box changes, its content box does not.
    const probe = document.querySelector<HTMLElement>("[data-test-probe]")!;
    const resized = new Promise<void>((resolve) => {
      const watching = new ResizeObserver(() => {
        watching.disconnect();
        resolve();
      });
      // Created after the canvas's own observer, so it is told after it.
      watching.observe(probe, { box: "border-box" });
    });
    await resized;
    const changed = new Promise<void>((resolve) => {
      const watching = new ResizeObserver((entries) => {
        if (entries[0]!.borderBoxSize[0]!.inlineSize === 768 + 12) {
          watching.disconnect();
          resolve();
        }
      });
      watching.observe(probe, { box: "border-box" });
    });
    await act(async () => {
      probe.style.paddingLeft = "12px";
      await changed;
    });
    await act(async () => undefined);
    expect(seen.style!["--chat-lane-inset-end"]).not.toBe(before);
  });
});
