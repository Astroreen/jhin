// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx
// (the floating browser preview: its drag handle and pill, its eight resize handles and the
// server tab's surface at the page's own size) and components/chat/chatCanvasLayout.ts (a player
// not yet moved sits in the bottom corner, above the composer) (docs/plans/preview.md, D1202).
import type { PreviewTab } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { Button, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import { PanelRightIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
  type PreviewMiniPlayerResizeDirection,
  type PreviewMiniPlayerSize,
} from "./mini-player-layout.ts";
import type { MiniPlayerState, MiniPlayers } from "./mini-player-store.ts";
import { BrowserSurface } from "./surface.tsx";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: PreviewMiniPlayerResizeDirection | null;
  moved: boolean;
}

const HANDLE_TAP_SLOP_PX = 6;

const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: PreviewMiniPlayerResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nesw-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

/** The page's size until its first frame says (the node's default viewport). */
const DEFAULT_SOURCE: PreviewMiniPlayerSize = { width: 1280, height: 800 };

export interface MiniPlayerProps {
  readonly client: RpcClient;
  readonly threadId: string;
  readonly threadKey: string;
  readonly tab: PreviewTab;
  readonly state: MiniPlayerState;
  readonly players: MiniPlayers;
  readonly viewer: string;
  readonly composerHeight: number;
  readonly onOpenInPanel: () => void;
  readonly onError: (error: unknown) => void;
}

/** The size of the layer the player floats in, kept while it resizes. */
function useContainerSize(): [
  (element: HTMLDivElement | null) => void,
  PreviewMiniPlayerSize | null,
] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<PreviewMiniPlayerSize | null>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) =>
        current?.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

/** T3's floating browser preview of a thread's tab, over the chat (D1202). */
export function MiniPlayer(props: MiniPlayerProps) {
  const { tab, state, players, threadKey } = props;
  const [containerRef, container] = useContainerSize();
  const [source, setSource] = useState<PreviewMiniPlayerSize>(
    tab.size.width > 0 && tab.size.height > 0 ? tab.size : DEFAULT_SOURCE,
  );
  const gestureRef = useRef<PointerGesture | null>(null);
  // Touch has no hover, so tapping the handle toggles the pill instead. The
  // toggle waits for the tap's click, which would otherwise land on the pill.
  const [pillOpen, setPillOpen] = useState(false);
  const handleTappedRef = useRef(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pillOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && handleRef.current?.contains(event.target)) return;
      setPillOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [pillOpen]);

  // The composer spans the chat's width at the bottom of the layer.
  const obstacles: PreviewMiniPlayerObstacles = {
    composer:
      container === null ? null : { left: 0, right: container.width, height: props.composerHeight },
    detailsCard: null,
  };
  const frame = (() => {
    if (container === null) return null;
    const resolved = resolvePreviewMiniPlayerFrame({
      width: state.width,
      position: state.position,
      source,
      container,
      obstacles,
    });
    if (state.position !== null) return resolved;
    // Not moved yet: the bottom corner, above the composer (T3's chat canvas).
    return {
      ...resolved,
      ...clampPreviewMiniPlayerPosition(
        { x: resolved.x, y: container.height - resolved.height - PREVIEW_MINI_PLAYER_EDGE_GAP },
        container,
        resolved,
        obstacles,
      ),
    };
  })();

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: PreviewMiniPlayerResizeDirection | null,
  ) => {
    if (event.button !== 0 || frame === null) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId || container === null) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    if (!gesture.moved && Math.hypot(delta.x, delta.y) < HANDLE_TAP_SLOP_PX) return;
    gesture.moved = true;
    if (gesture.direction === null) {
      players.move(
        threadKey,
        tab.tabId,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
          obstacles,
        ),
      );
      return;
    }
    const next = resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source,
      container,
      obstacles,
    });
    players.resize(threadKey, tab.tabId, next.width, { x: next.x, y: next.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    handleTappedRef.current =
      event.type === "pointerup" &&
      gesture.direction === null &&
      gesture.pointerType === "touch" &&
      !gesture.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const radius = PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  const pillInset = Math.max(8, Math.round(radius * 0.55));
  const recording = tab.recording;
  return (
    <div className="pointer-events-none absolute inset-0" ref={containerRef}>
      {frame === null ? null : (
        <section
          aria-label="Floating browser preview"
          className="pointer-events-none absolute select-none"
          data-preview-mini-player={tab.tabId}
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            borderRadius: radius,
          }}
        >
          <div
            className="group pointer-events-auto absolute z-[49] size-3 touch-none cursor-grab active:cursor-grabbing pointer-coarse:-m-2.5 pointer-coarse:size-8"
            data-pill-open={pillOpen ? "" : undefined}
            data-preview-mini-player-handle=""
            onClick={() => {
              if (!handleTappedRef.current) return;
              handleTappedRef.current = false;
              setPillOpen((open) => !open);
            }}
            onPointerCancel={endGesture}
            onPointerDown={(event) => beginGesture(event, null)}
            onPointerMove={handlePointerMove}
            onPointerUp={endGesture}
            ref={handleRef}
            style={{ right: pillInset, top: pillInset }}
          >
            <div
              aria-hidden={!recording}
              aria-label={recording ? "Recording preview" : undefined}
              className="absolute right-0 top-0 size-2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-data-pill-open:opacity-0 pointer-coarse:right-2.5 pointer-coarse:top-2.5"
              role={recording ? "status" : undefined}
            >
              <span
                className={cn(
                  "block size-2 rounded-full shadow-sm ring-1 ring-background/70",
                  recording
                    ? "bg-destructive motion-safe:animate-status-pulse"
                    : "bg-foreground/25",
                )}
              />
            </div>
            <div className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-pill-open:pointer-events-auto group-data-pill-open:opacity-100 active:cursor-grabbing pointer-coarse:right-2.5 pointer-coarse:top-2.5">
              {recording ? (
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                  <span className="size-2 rounded-full bg-destructive motion-safe:animate-status-pulse" />
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Open preview in right panel"
                      onClick={props.onOpenInPanel}
                      onPointerDown={(event) => event.stopPropagation()}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <PanelRightIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Open in right panel</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Close floating preview"
                      onClick={() => players.close(threadKey)}
                      onPointerDown={(event) => event.stopPropagation()}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Close floating preview</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          <div className="absolute inset-0 z-[47] rounded-[inherit] bg-muted shadow-2xl/35" />
          <div className="pointer-events-auto absolute inset-0 z-[48] overflow-hidden rounded-[inherit]">
            <BrowserSurface
              canOperate={tab.controller === props.viewer}
              client={props.client}
              followSize={false}
              humanControls={tab.controller !== null}
              onError={props.onError}
              onViewport={(size) =>
                setSource((current) =>
                  current.width === size.width && current.height === size.height
                    ? current
                    : { width: size.width, height: size.height },
                )
              }
              tabId={tab.tabId}
              threadId={props.threadId}
              viewer={props.viewer}
            />
          </div>
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-[inherit] ring-1 ring-inset ring-border/80" />
          {RESIZE_HANDLES.map(({ direction, className }) => (
            <div
              className={cn("pointer-events-auto absolute z-[49] touch-none", className)}
              data-preview-mini-player-resize={direction}
              key={direction}
              onPointerCancel={endGesture}
              onPointerDown={(event) => beginGesture(event, direction)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              role="presentation"
            />
          ))}
        </section>
      )}
    </div>
  );
}
