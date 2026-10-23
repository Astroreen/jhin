// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/device/
// DeviceStreamView.tsx (the flat view: the frame fitted to the panel, pointer touches, keys,
// the MJPEG image, "Input disconnected", "Connecting video…" and "Reconnect"),
// DeviceControlsRail.tsx (Home, Back, Recents, Rotate device), DeviceLoadingView.tsx and
// deviceFrameLayout.ts at eb7b35ac. Without T3's 3D phone, Duo and fold scenes.
// docs/plans/preview.md, D1208.
import { Button, Spinner, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import {
  ChevronLeftIcon,
  HomeIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SquareIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  createCanvasFrameSink,
  createDeviceStreamClient,
  type DeviceHardwareButton,
  type DeviceHubAccess,
  type DevicePlatform,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "./stream.ts";

const CONTROLS_RAIL_WIDTH = 56;

/** The largest box at `aspect` that fits, so a narrow panel shows a shorter phone, not a squeezed one. */
function fitDeviceFrame(aspect: number, width: number, height: number, rightInset = 0) {
  const availableWidth = Math.max(0, width - rightInset);
  if (availableWidth === 0 || height === 0) return { width: 0, height: 0 };
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= availableWidth
    ? byHeight
    : { width: availableWidth, height: availableWidth / aspect };
}

function screenAspect(platform: DevicePlatform, screen: DeviceScreenSize | null): number {
  if (!screen) return platform === "ios" ? 9 / 19.5 : 9 / 20;
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const w = landscape
    ? Math.max(screen.width, screen.height)
    : Math.min(screen.width, screen.height);
  const h = landscape
    ? Math.min(screen.width, screen.height)
    : Math.max(screen.width, screen.height);
  return w / h;
}

// serve-sim streams the raw framebuffer; rotate the display for a device
// that reports landscape while its frames stay portrait.
function screenRotation(platform: DevicePlatform, screen: DeviceScreenSize | null): number {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
  switch (screen.orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

function DeviceLoadingView(props: {
  readonly name: string;
  readonly description?: string;
  readonly message: string;
  readonly error?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div
      role={props.error ? "alert" : "status"}
      className="flex size-full items-center justify-center bg-background px-6 py-10"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="grid size-12 place-items-center rounded-xl border bg-muted/30">
          <SmartphoneIcon className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{props.name}</p>
          {props.description ? (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {!props.error ? <Spinner className="size-3" /> : null}
          <span>{props.message}</span>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function RailButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            {...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed })}
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon-sm"
            variant={props.pressed === true ? "secondary" : "ghost"}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="left">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** T3's control rail, with the buttons the hub's input socket takes. */
function DeviceControlsRail(props: {
  platform: DevicePlatform;
  inputConnected: boolean;
  pressButton: (button: DeviceHardwareButton) => void;
  rotate: () => void;
  /** T3's "Device tools" toggle (D1333), when the panel offers the tools. */
  tools?: { open: boolean; toggle: () => void };
}) {
  const disabled = !props.inputConnected;
  return (
    <aside
      aria-label="Device controls"
      className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 flex-col items-center justify-center gap-2 py-3 pr-2"
    >
      <div className="pointer-events-auto flex flex-col items-center gap-1 rounded-full border border-border/50 bg-background/80 p-2 shadow-sm">
        <RailButton disabled={disabled} label="Home" onClick={() => props.pressButton("home")}>
          <HomeIcon />
        </RailButton>
        {props.platform === "android" ? (
          <>
            <RailButton disabled={disabled} label="Back" onClick={() => props.pressButton("back")}>
              <ChevronLeftIcon />
            </RailButton>
            <RailButton
              disabled={disabled}
              label="Recents"
              onClick={() => props.pressButton("recents")}
            >
              <SquareIcon />
            </RailButton>
          </>
        ) : (
          <RailButton disabled={disabled} label="Rotate device" onClick={props.rotate}>
            <RotateCcwIcon />
          </RailButton>
        )}
        {props.tools === undefined ? null : (
          <RailButton label="Device tools" onClick={props.tools.toggle} pressed={props.tools.open}>
            <SlidersHorizontalIcon />
          </RailButton>
        )}
      </div>
    </aside>
  );
}

/** A device's live screen from the node's device hub, with touches, keys and the rail. */
export function DeviceStreamView(props: {
  readonly access: DeviceHubAccess;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceDescription: string;
  /** The ticket was refused: ask the node for a fresh one. */
  readonly onUnauthorized: () => void;
  /** Video is showing. */
  readonly onStreaming?: () => void;
  /** T3's "Device tools" toggle in the rail (D1333). */
  readonly tools?: { open: boolean; toggle: () => void };
}) {
  const { access, platform, deviceId, onUnauthorized } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DeviceStreamClient | null>(null);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [mjpegGeneration, setMjpegGeneration] = useState(0);
  const [input, setInput] = useState<{ connected: boolean; detail?: string }>({
    connected: false,
  });
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const streaming = useRef(props.onStreaming);
  streaming.current = props.onStreaming;
  // A new ref callback per render would detach and reattach the MJPEG image.
  const attachMjpegImage = useCallback((image: HTMLImageElement | null) => {
    clientRef.current?.setMjpegImage(image);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const client = createDeviceStreamClient(
      { platform, deviceId, access },
      createCanvasFrameSink(canvas),
      {
        onStatus: (next, nextDetail) => {
          setStatus(next);
          setDetail(nextDetail);
          if (next === "streaming") streaming.current?.();
        },
        onScreen: setScreen,
        onUnauthorized: () => unauthorized.current(),
        onMjpegFallback: (url) => {
          setMjpegUrl(url);
          setMjpegGeneration((generation) => generation + 1);
        },
        onInputConnected: (connected, nextDetail) =>
          setInput({ connected, ...(nextDetail ? { detail: nextDetail } : {}) }),
      },
    );
    clientRef.current = client;
    setMjpegUrl(null);
    setInput({ connected: false });
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
      setScreen(null);
    };
  }, [access, platform, deviceId]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setHost((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const frame = fitDeviceFrame(
    screenAspect(platform, screen),
    host.width,
    host.height,
    CONTROLS_RAIL_WIDTH,
  );
  const rotation = screenRotation(platform, screen);
  const sideways = rotation === 90 || rotation === -90;
  const mediaStyle: CSSProperties = sideways
    ? {
        width: frame.height,
        height: frame.width,
        left: (frame.width - frame.height) / 2,
        top: (frame.height - frame.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: frame.width,
        height: frame.height,
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      };

  const pointerActive = useRef(false);
  const normalizedPoint = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };
  const touchEnd = (event: PointerEvent<HTMLElement>) => {
    if (!pointerActive.current) return;
    pointerActive.current = false;
    const { x, y } = normalizedPoint(event);
    clientRef.current?.sendTouch("end", x, y);
  };

  return (
    <div className="relative flex size-full min-h-0 min-w-0 bg-black/90">
      <DeviceControlsRail
        inputConnected={input.connected}
        platform={platform}
        pressButton={(button) => clientRef.current?.pressButton(button)}
        rotate={() => clientRef.current?.rotate()}
        {...(props.tools === undefined ? {} : { tools: props.tools })}
      />
      <div
        aria-label={`${platform === "ios" ? "iOS Simulator" : "Android Emulator"} screen`}
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden pr-14 outline-none"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.metaKey && !["r", "R"].includes(event.key)) return;
          event.preventDefault();
          clientRef.current?.sendKey(event.nativeEvent, "down");
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget) return;
          clientRef.current?.sendKey(event.nativeEvent, "up");
        }}
        ref={hostRef}
        role="application"
        tabIndex={0}
      >
        <div
          className="relative touch-none select-none"
          onPointerCancel={touchEnd}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            (event.currentTarget.parentElement as HTMLElement | null)?.focus();
            pointerActive.current = true;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("begin", x, y);
          }}
          onPointerMove={(event) => {
            if (!pointerActive.current) return;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("move", x, y);
          }}
          onPointerUp={touchEnd}
          style={{ width: frame.width, height: frame.height }}
        >
          <canvas
            className={cn("absolute top-0 left-0", mjpegUrl && "hidden")}
            ref={canvasRef}
            style={mediaStyle}
          />
          {mjpegUrl ? (
            <img
              alt=""
              className="absolute top-0 left-0 object-contain"
              draggable={false}
              key={mjpegGeneration}
              ref={attachMjpegImage}
              style={mediaStyle}
            />
          ) : null}
        </div>
        {status === "streaming" && !input.connected ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
            <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground">
              Input disconnected{input.detail ? ` (${input.detail})` : ""}, reconnecting…
            </span>
          </div>
        ) : null}
        {status !== "streaming" ? (
          <div className="absolute inset-0">
            <DeviceLoadingView
              description={props.deviceDescription}
              error={status === "error"}
              message={status === "error" ? (detail ?? "Stream failed.") : "Connecting video…"}
              name={props.deviceName}
            >
              {status === "error" ? (
                <Button
                  onClick={() => {
                    // An expired ticket surfaces as unauthorized on restart and refreshes access.
                    clientRef.current?.stop();
                    clientRef.current?.start();
                  }}
                  size="sm"
                  variant="outline"
                >
                  Reconnect
                </Button>
              ) : null}
            </DeviceLoadingView>
          </div>
        ) : null}
      </div>
    </div>
  );
}
