// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ui/toast.tsx
// Thread-scoped toasts, anchored toasts and icon morphing are left out.
"use client";

import { Toast } from "@base-ui/react/toast";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { copyText } from "../clipboard.ts";
import { cn } from "../cn.ts";
import { Button, buttonVariants } from "./button.tsx";
import { Spinner } from "./spinner.tsx";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
} from "./toast-logic.ts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip.tsx";

type ActionVariant =
  | "default"
  | "destructive"
  | "destructive-outline"
  | "ghost"
  | "link"
  | "outline"
  | "secondary";

export interface ToastData {
  leadingIcon?: ReactNode;
  onClose?: (() => void) | undefined;
  /** Closes the toast after it was visible (page shown and focused) this long. */
  dismissAfterVisibleMs?: number;
  hideCopyButton?: boolean;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?: ActionVariant;
  /** Extra body shown after toggling "Show details". */
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  actionLayout?: "inline" | "stacked-end";
  actionVariant?: ActionVariant;
}

const toastManager = Toast.createToastManager<ToastData>();
type ToastId = ReturnType<typeof toastManager.add>;
const visibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: Spinner,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

/** Visually shorten long error bodies; clipboard copy still uses the full `description` string. */
const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;
function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || typeof description !== "string") return undefined;
  if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) return undefined;
  return "line-clamp-4";
}

/** Dismiss-only: circular control overlapping the card corner (iOS notification–style). */
const toastCornerDismissClass = "absolute z-20 -top-1.5 -right-1.5";
const toastCornerOrbClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm",
  "transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);

function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? "Copied error" : "Copy error";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={label}
            className="[--control-icon-color:currentColor] rounded-md text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground"
            onClick={() =>
              void copyText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          />
        }
      >
        {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Scrollable cap for long expandable lists (~10rem); keeps the toast from growing without bound. */
const toastExpandablePanelClassName =
  "mt-2 max-h-40 min-h-0 overflow-y-auto overscroll-contain pr-0.5 select-text";

function ToastExpandableSection({
  children,
  labels,
}: {
  children: ReactNode;
  labels: { expand?: string; collapse?: string };
}) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronUpIcon : ChevronDownIcon;
  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((previous) => !previous)}
        type="button"
      >
        <Icon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        {open ? (labels.collapse ?? "Hide details") : (labels.expand ?? "Show details")}
      </button>
      {open ? <div className={toastExpandablePanelClassName}>{children}</div> : null}
    </div>
  );
}

interface ToastLike {
  readonly id: ToastId;
  readonly type?: string | undefined;
  readonly description?: unknown;
  readonly actionProps?: { readonly children?: ReactNode } | undefined;
  readonly data?: ToastData | undefined;
}

function ToastBody({ toast }: { toast: ToastLike }) {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : undefined;
  const data = toast.data;
  const stacked = hasVisibleToastAction(toast.actionProps) && data?.actionLayout === "stacked-end";
  const copyErrorText =
    toast.type === "error" && typeof toast.description === "string" && !data?.hideCopyButton
      ? toast.description
      : null;
  const secondary = data?.secondaryActionProps;
  const trailing =
    copyErrorText !== null || hasVisibleToastAction(toast.actionProps) || secondary !== undefined;
  return (
    <>
      <div className={cn("flex min-h-0 min-w-0 flex-col gap-0.5", stacked ? "pr-5" : "flex-1")}>
        <div className="flex min-w-0 gap-2">
          {data?.leadingIcon ? (
            <div
              className="flex h-lh w-4 shrink-0 items-center justify-center"
              data-slot="toast-icon"
            >
              {data.leadingIcon}
            </div>
          ) : Icon ? (
            <div
              className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
              data-slot="toast-icon"
            >
              <Icon className="in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80" />
            </div>
          ) : null}
          <Toast.Title className="min-w-0 wrap-break-word font-medium" data-slot="toast-title" />
        </div>
        <Toast.Description
          className={cn(
            "min-w-0 select-text wrap-break-word text-muted-foreground",
            errorDescriptionClampClass(toast.type, toast.description),
          )}
          data-slot="toast-description"
        />
        {data?.expandableContent ? (
          <ToastExpandableSection labels={data.expandableLabels ?? {}}>
            {data.expandableContent}
          </ToastExpandableSection>
        ) : null}
      </div>
      {trailing ? (
        <div
          className={cn("flex items-center gap-1.5", stacked ? "w-full justify-end" : "shrink-0")}
        >
          {copyErrorText !== null ? <CopyErrorButton text={copyErrorText} /> : null}
          {secondary ? (
            <Button
              {...secondary}
              size="xs"
              type="button"
              variant={data?.secondaryActionVariant ?? "outline"}
            />
          ) : null}
          {hasVisibleToastAction(toast.actionProps) ? (
            <Toast.Action
              className={cn(
                buttonVariants({ size: "xs", variant: data?.actionVariant ?? "default" }),
                "shrink-0",
              )}
              data-slot="toast-action"
            >
              {toast.actionProps?.children}
            </Toast.Action>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Closes a toast once it has been visible for `dismissAfterVisibleMs`, pausing while the page is hidden. */
function VisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    let remainingMs = visibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;
    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };
    const closeToast = () => {
      if (closed) return;
      closed = true;
      visibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };
    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      visibleTimeoutRemainingMs.set(toastId, remainingMs);
    };
    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };
    const sync = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) start();
      else pause();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);
  return null;
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function ToastProvider({ children, position = "top-right", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ToastData>();
  const isTop = position.startsWith("top");
  const layout = buildVisibleToastLayout(toasts);

  useEffect(() => {
    const active = new Set(toasts.map((toast) => toast.id));
    for (const id of visibleTimeoutRemainingMs.keys()) {
      if (!active.has(id)) visibleTimeoutRemainingMs.delete(id);
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:var(--workspace-topbar-height)] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={{ "--toast-frontmost-height": `${layout.frontmostHeight}px` } as CSSProperties}
      >
        {layout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsed = shouldHideCollapsedToastContent(visibleIndex, layout.items.length);
          const stacked =
            hasVisibleToastAction(toast.actionProps) && toast.data?.actionLayout === "stacked-end";
          const trailing =
            (toast.type === "error" &&
              typeof toast.description === "string" &&
              !toast.data?.hideCopyButton) ||
            hasVisibleToastAction(toast.actionProps) ||
            toast.data?.secondaryActionProps !== undefined;
          return (
            <Toast.Root
              className={cn(
                "dropdown-glass absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-lg text-popover-foreground shadow-xl shadow-black/25 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-limited:opacity-0",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <VisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <div className={toastCornerDismissClass}>
                <button
                  aria-label="Dismiss notification"
                  className={toastCornerOrbClass}
                  data-slot="toast-close"
                  onClick={() => {
                    toast.data?.onClose?.();
                    toastManager.close(toast.id);
                  }}
                  type="button"
                >
                  <XIcon className="size-3" strokeWidth={2.25} />
                </button>
              </div>
              <Toast.Content
                className={cn(
                  "pointer-events-auto min-h-0 overflow-y-visible pl-3.5 text-sm transition-opacity duration-250 [overflow-x:clip] data-expanded:opacity-100",
                  stacked
                    ? "flex flex-col gap-2 py-2.5 pr-3.5"
                    : cn(
                        "py-3",
                        "flex items-center justify-between gap-1.5",
                        trailing ? "pr-6" : "pr-10",
                      ),
                  hideCollapsed &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastBody toast={toast} />
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { ToastProvider, toastManager, type ToastPosition };
