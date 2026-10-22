// The surface follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/browser/ServerBrowserSurface.tsx
// (frames on a canvas, letterboxed pointer mapping, mouse, wheel and key input through a hidden
// textarea, the resize the panel asks for, touch taps and pans with the editable-at-point probe that
// raises a soft keyboard) and components/preview/AgentBrowserCursor.tsx.
import { PreviewEvents, previewFramesStream, type PreviewInputEvent } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { MousePointer2Icon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { createTouchGestures, type TouchAction, type TouchGestures } from "./touch.ts";

interface Frame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

const RESIZE_THROTTLE_MS = 150;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;
/** Alt 1, ctrl 2, meta 4, shift 8: T3's (and CDP's) modifier bits. */
function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

const BUTTONS = ["left", "middle", "right"] as const;

function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface SurfaceProps {
  readonly client: RpcClient;
  readonly threadId: string;
  readonly tabId: string;
  readonly viewer: string;
  /** This viewer holds control: its input reaches the page. */
  readonly canOperate: boolean;
  /** Whether the agent holds the tab (its cursor shows brighter). */
  readonly humanControls: boolean;
  readonly onFirstFrame?: () => void;
  /** A command failed; the panel shows it. */
  readonly onError?: (error: unknown) => void;
  /**
   * Whether the page takes the surface's size in fill mode (the panel's, by default). The
   * floating mini player shows the page at the size it has instead (T3's `followSize`, D1202).
   */
  readonly followSize?: boolean;
  /** The page's size in CSS pixels, when a frame brings a new one. */
  readonly onViewport?: (size: { width: number; height: number }) => void;
}

/** One tab's page: its frames drawn on a canvas, and the controlling viewer's input sent back. */
export function BrowserSurface(props: SurfaceProps) {
  const { client, threadId, tabId, viewer, canOperate } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef({ width: 1280, height: 800 });
  const [agentPointer, setAgentPointer] = useState<
    { x: number; y: number; click: boolean; at: number } | undefined
  >();
  // The agent's cursor is bright for 700 ms after it moves, then fades (T3's).
  const [cursorFresh, setCursorFresh] = useState(false);
  useEffect(() => {
    if (agentPointer === undefined) return;
    setCursorFresh(true);
    const timer = setTimeout(() => setCursorFresh(false), 700);
    return () => clearTimeout(timer);
  }, [agentPointer]);
  /** Keys pressed in the page and not yet released, by code. */
  const heldKeys = useRef(new Map<string, { key: string; code: string; keyCode: number }>());
  const [rendered, setRendered] = useState(0);
  const canOperateRef = useRef(canOperate);
  canOperateRef.current = canOperate;
  const firstFrame = useRef(props.onFirstFrame);
  firstFrame.current = props.onFirstFrame;
  const onError = useRef(props.onError);
  onError.current = props.onError;
  const onViewport = useRef(props.onViewport);
  onViewport.current = props.onViewport;
  const followSize = props.followSize ?? true;

  // Input goes out in order, a batch per animation frame.
  const queue = useRef<PreviewInputEvent[]>([]);
  const sending = useRef<Promise<void>>(Promise.resolve());
  const scheduled = useRef(false);
  const send = (event: PreviewInputEvent) => {
    if (event.type !== "resize" && !canOperateRef.current) return;
    queue.current.push(event);
    if (scheduled.current) return;
    scheduled.current = true;
    requestAnimationFrame(() => {
      scheduled.current = false;
      const events = queue.current.splice(0);
      if (events.length === 0) return;
      sending.current = sending.current.then(() =>
        client.call("preview.tab.input", { threadId, tabId, viewer, events }).then(
          () => undefined,
          (error: unknown) => onError.current?.(error),
        ),
      );
    });
  };

  // --- Frames -------------------------------------------------------------------
  useEffect(() => {
    let painting = false;
    let waiting: Frame | undefined;
    let first = true;
    let current = true;
    const paint = async (frame: Frame) => {
      if (painting) {
        // Only the newest waiting frame is kept.
        waiting = frame;
        return;
      }
      painting = true;
      try {
        const bitmap = await createImageBitmap(
          new Blob([base64Bytes(frame.data)], { type: "image/jpeg" }),
        );
        const canvas = canvasRef.current;
        if (canvas !== null && current) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          if (
            viewport.current.width !== frame.width ||
            viewport.current.height !== frame.height ||
            first
          ) {
            viewport.current = { width: frame.width, height: frame.height };
            onViewport.current?.(viewport.current);
          }
          if (first) {
            first = false;
            setRendered((value) => value + 1);
            firstFrame.current?.();
          }
        }
        bitmap.close();
      } catch {
        // A frame that does not decode is skipped; the next one replaces it.
      } finally {
        painting = false;
        const next = waiting;
        waiting = undefined;
        if (next !== undefined && current) void paint(next);
      }
    };
    const subscription = client.subscribe(
      previewFramesStream(threadId, tabId),
      { after: 0 },
      (event) => {
        if (event.type === PreviewEvents.frame) void paint(event.payload as unknown as Frame);
        else if (event.type === PreviewEvents.pointer) {
          const pointer = event.payload as { x: number; y: number; phase: string };
          setAgentPointer({
            x: pointer.x,
            y: pointer.y,
            click: pointer.phase === "click",
            at: Date.now(),
          });
        }
      },
    );
    return () => {
      current = false;
      subscription.dispose();
    };
  }, [client, threadId, tabId]);

  // --- The panel's size is the page's in fill mode ----------------------------------
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !followSize) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      timer = undefined;
      const { width, height } = box.getBoundingClientRect();
      if (width < 100 || height < 100) return;
      send({
        type: "resize",
        width: Math.min(Math.round(width), 3840),
        height: Math.min(Math.round(height), 2160),
        scale: Math.min(Math.max(window.devicePixelRatio || 1, 0.5), 4),
      });
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
    // `send` reads its state through refs.
  }, [client, threadId, tabId, followSize]);

  // When control is lost, the hidden input lets go of the focus.
  useEffect(() => {
    if (!canOperate) {
      inputRef.current?.blur();
      heldKeys.current.clear();
    }
  }, [canOperate]);

  /** Page CSS pixels under a client point, through the canvas's letterbox. */
  const pagePoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (canvas === null || canvas.width === 0) return undefined;
    const rect = canvas.getBoundingClientRect();
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const shownWidth = canvas.width * fit;
    const shownHeight = canvas.height * fit;
    const left = rect.left + (rect.width - shownWidth) / 2;
    const top = rect.top + (rect.height - shownHeight) / 2;
    const x = ((clientX - left) / shownWidth) * viewport.current.width;
    const y = ((clientY - top) / shownHeight) * viewport.current.height;
    if (x < 0 || y < 0 || x > viewport.current.width || y > viewport.current.height) {
      return undefined;
    }
    return { x, y };
  };

  const lastClick = useRef({ at: 0, x: 0, y: 0, count: 0 });
  const countClick = (point: { x: number; y: number }, at: number) => {
    const previous = lastClick.current;
    const again =
      at - previous.at < MULTI_CLICK_MS &&
      Math.abs(point.x - previous.x) < MULTI_CLICK_PX &&
      Math.abs(point.y - previous.y) < MULTI_CLICK_PX;
    const count = again ? Math.min(previous.count + 1, 3) : 1;
    lastClick.current = { at, ...point, count };
    return count;
  };

  // --- Touch: a tap clicks, a pan scrolls, and a tap on text raises the keyboard (T3's) ---
  const touch = useRef<TouchGestures | null>(null);
  touch.current ??= createTouchGestures();
  useEffect(() => {
    if (!canOperate) touch.current?.reset();
  }, [canOperate]);
  /** Page CSS pixels per client pixel on the canvas. */
  const pageScale = () => {
    const canvas = canvasRef.current;
    if (canvas === null || canvas.width === 0) return 1;
    const rect = canvas.getBoundingClientRect();
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    return viewport.current.width / (canvas.width * fit);
  };
  const run = (actions: readonly TouchAction[], timeStamp: number) => {
    for (const action of actions) {
      switch (action.type) {
        case "focus":
          inputRef.current?.focus({ preventScroll: true });
          break;
        case "blur":
          inputRef.current?.blur();
          break;
        case "wheel":
          send({
            type: "wheel",
            ...action.point,
            deltaX: action.deltaX,
            deltaY: action.deltaY,
            modifiers: 0,
          });
          break;
        case "tap": {
          const { point } = action;
          const clickCount = countClick(point, timeStamp);
          send({
            type: "mouse",
            action: "move",
            ...point,
            button: "none",
            buttons: 0,
            modifiers: 0,
          });
          send({
            type: "mouse",
            action: "down",
            ...point,
            button: "left",
            buttons: 1,
            clickCount,
            modifiers: 0,
          });
          send({
            type: "mouse",
            action: "up",
            ...point,
            button: "left",
            buttons: 0,
            clickCount,
            modifiers: 0,
          });
          break;
        }
        case "probe":
          void client
            .call<{ x: number; y: number; editable: boolean }>("preview.tab.probe", {
              threadId,
              tabId,
              viewer,
              ...action.point,
            })
            .then(
              (result) => {
                if (canOperateRef.current) run(touch.current!.answered(result), performance.now());
              },
              // Without an answer the tap still clicks; only the keyboard stays down.
              () => touch.current!.failed(action.point),
            );
          break;
      }
    }
  };
  /** Handles a touch pointer; false for a mouse or a pen. */
  const onTouch = (event: PointerEvent<HTMLCanvasElement>): boolean => {
    if (event.pointerType !== "touch") return false;
    const gestures = touch.current!;
    if (event.type === "pointercancel") {
      gestures.cancel(event.pointerId);
      return true;
    }
    const pointer = {
      pointerId: event.pointerId,
      isPrimary: event.isPrimary,
      clientX: event.clientX,
      clientY: event.clientY,
      point: pagePoint(event.clientX, event.clientY),
    };
    if (event.type === "pointerdown") {
      if (event.isPrimary) event.preventDefault();
      run(gestures.down(pointer), event.timeStamp);
    } else if (event.type === "pointermove")
      run(gestures.move(pointer, pageScale()), event.timeStamp);
    else run(gestures.up(pointer), event.timeStamp);
    return true;
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canOperate) return;
    if (onTouch(event)) return;
    const point = pagePoint(event.clientX, event.clientY);
    if (point === undefined) return;
    event.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const count = countClick(point, event.timeStamp);
    send({
      type: "mouse",
      action: "down",
      ...point,
      button: BUTTONS[event.button] ?? "left",
      buttons: event.buttons,
      clickCount: count,
      modifiers: modifiersOf(event),
    });
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canOperate) return;
    if (onTouch(event)) return;
    const point = pagePoint(event.clientX, event.clientY) ?? lastClick.current;
    send({
      type: "mouse",
      action: "up",
      x: point.x,
      y: point.y,
      button: BUTTONS[event.button] ?? "left",
      buttons: event.buttons,
      clickCount: lastClick.current.count,
      modifiers: modifiersOf(event),
    });
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canOperate) return;
    if (onTouch(event)) return;
    const point = pagePoint(event.clientX, event.clientY);
    if (point === undefined) return;
    send({
      type: "mouse",
      action: "move",
      ...point,
      button: event.buttons & 1 ? "left" : "none",
      buttons: event.buttons,
      modifiers: modifiersOf(event),
    });
  };

  // Wheel needs a listener that may prevent scrolling the app.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!canOperateRef.current) return;
      const point = pagePoint(event.clientX, event.clientY);
      if (point === undefined) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current.height : 1;
      send({
        type: "wheel",
        ...point,
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        modifiers: modifiersOf(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>, action: "down" | "up") => {
    if (!canOperate || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (action === "down" && event.key === "Escape" && event.shiftKey) {
      event.currentTarget.blur();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    // Paste goes through the native paste event.
    if ((mod && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert")) {
      return;
    }
    event.preventDefault();
    const held = event.code || event.key;
    if (action === "down") {
      heldKeys.current.set(held, { key: event.key, code: event.code, keyCode: event.keyCode });
    } else heldKeys.current.delete(held);
    // AltGr reads as Ctrl+Alt on Windows: its characters are still text.
    const altGraph = event.ctrlKey && event.altKey && !event.metaKey;
    const printable = event.key.length === 1 && (!mod || altGraph);
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && printable ? { text: event.key } : {}),
      ...(action === "down" && event.key === "Enter" && !mod ? { text: "\r" } : {}),
      modifiers: modifiersOf(event),
    });
  };

  /** Leaving the page lets go of what is held there, so no key stays down in it. */
  const releaseHeld = () => {
    for (const held of heldKeys.current.values()) {
      send({ type: "key", action: "up", key: held.key, code: held.code, keyCode: held.keyCode });
    }
    heldKeys.current.clear();
  };

  const fresh = agentPointer !== undefined && cursorFresh;
  const pointerOpacity = fresh ? 1 : props.humanControls ? 0.18 : 0.35;
  const canvas = canvasRef.current;
  const placeAgent = () => {
    if (agentPointer === undefined || canvas === null || canvas.width === 0) return undefined;
    const rect = canvas.getBoundingClientRect();
    const box = boxRef.current?.getBoundingClientRect();
    if (box === undefined) return undefined;
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const shownWidth = canvas.width * fit;
    const shownHeight = canvas.height * fit;
    return {
      x:
        rect.left -
        box.left +
        (rect.width - shownWidth) / 2 +
        (agentPointer.x / viewport.current.width) * shownWidth,
      y:
        rect.top -
        box.top +
        (rect.height - shownHeight) / 2 +
        (agentPointer.y / viewport.current.height) * shownHeight,
    };
  };
  const agentAt = canOperate ? undefined : placeAgent();

  return (
    <div className="relative size-full min-h-0 overflow-hidden" ref={boxRef}>
      <canvas
        aria-hidden="true"
        className="block size-full touch-none object-contain"
        data-preview-canvas=""
        data-painted={rendered > 0 ? "true" : "false"}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerCancel={(event) => {
          if (canOperate) onTouch(event);
        }}
        onPointerUp={onPointerUp}
        ref={canvasRef}
      />
      <textarea
        aria-description="Press Shift+Escape to leave the browser page."
        aria-label="Browser page"
        onBlur={releaseHeld}
        className="sr-only top-0 left-0 text-base"
        disabled={!canOperate}
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
        onKeyDown={(event) => onKey(event, "down")}
        onKeyUp={(event) => onKey(event, "up")}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          event.preventDefault();
          if (text.length > 0) send({ type: "text", text: text.slice(0, 10_000) });
        }}
        ref={inputRef}
        value=""
        onChange={() => undefined}
      />
      {agentAt === undefined ? null : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-40 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
          data-agent-cursor=""
          style={{
            opacity: pointerOpacity,
            transform: `translate3d(${agentAt.x}px, ${agentAt.y}px, 0)`,
          }}
        >
          {agentPointer?.click === true && fresh ? (
            <span className="absolute left-0.5 top-0.5 size-4 animate-status-ping rounded-full bg-primary/25" />
          ) : null}
          <MousePointer2Icon className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background text-primary drop-shadow-sm" />
        </div>
      )}
    </div>
  );
}
