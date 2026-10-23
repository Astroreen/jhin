// The header's toggle and the thread details panel it opens follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ThreadDetailsCard.tsx (the card, its
// popover and inline presentations), threadDetailsCardLayout.ts (where the inline card goes),
// and PanelLayoutControls.tsx (the toggle). A chunk of its own
// (D440), registered by thread-details.tsx. docs/plans/t3-parity.md, D802.
import type { ChatHeaderActionProps, ChatThreadDetailsProps, Keybindings } from "@jhin/client-api";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
  ScrollArea,
  Slot,
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import { SquareMenuIcon } from "lucide-react";
import {
  type ComponentType,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useShortcutLabels } from "../../lib/hooks.ts";
import {
  type DetailsPresentation,
  type DetailsVisibility,
  detailsKey,
  inlineDetailsPlacement,
  lanePadding,
} from "./thread-details.tsx";

/** T3's card: the sections of `chat.thread.details`, or "No details for this thread". */
function DetailsCard(props: ChatThreadDetailsProps & { readonly className?: string }) {
  const { target, thread, project } = props;
  return (
    <div
      aria-label="Thread details"
      className={cn(
        "dropdown-glass isolate grid grid-rows-[minmax(0,1fr)] overflow-hidden rounded-3xl",
        props.className,
      )}
      data-thread-details-card=""
      role="region"
    >
      <ScrollArea className="min-h-0" scrollFade>
        <div className="peer empty:hidden" data-thread-details-content="">
          <Slot
            name="chat.thread.details"
            props={
              {
                target,
                thread,
                ...(project === undefined ? {} : { project }),
              } satisfies ChatThreadDetailsProps
            }
          />
        </div>
        <p className="hidden px-4 py-3 text-sm text-muted-foreground peer-empty:block">
          No details for this thread
        </p>
      </ScrollArea>
    </div>
  );
}

/** The header's toggle, bound to the keybindings and the command's list of toggles. */
export function createThreadDetailsToggle(deps: {
  readonly keybindings: Keybindings | undefined;
  /** The toggles on screen, newest last, for `chat.thread-details.toggle`. */
  readonly toggles: (() => void)[];
  readonly visibility: DetailsVisibility;
}): ComponentType<ChatHeaderActionProps> {
  const { keybindings, toggles, visibility } = deps;
  return function ThreadDetailsToggle({ target, thread, project }: ChatHeaderActionProps) {
    const threadId = thread?.id;
    const key = threadId === undefined ? undefined : detailsKey(target, threadId);
    const presentation = useSyncExternalStore(visibility.subscribe, () =>
      key === undefined ? undefined : visibility.presentation(key),
    );
    // The card beside the chat when it has room and something to show, else the popover.
    const inline = useSyncExternalStore(
      visibility.subscribe,
      () => key !== undefined && visibility.effective(key) === "inline",
    );
    const open = useSyncExternalStore(visibility.subscribe, () =>
      key === undefined ? false : visibility.open(key, inline ? "inline" : "popover"),
    );
    const inlineOpen = useSyncExternalStore(
      visibility.subscribe,
      () => key !== undefined && visibility.open(key, "inline"),
    );
    const shortcut = useShortcutLabels(keybindings)("chat.thread-details.toggle");
    // The Lineage chunk loads while the panel is still closed.
    useEffect(() => {
      void import("./lineage.tsx").catch(() => undefined);
    }, []);
    useEffect(() => {
      if (key === undefined) return;
      const own = () => visibility.toggle(key);
      toggles.push(own);
      return () => {
        const at = toggles.indexOf(own);
        if (at !== -1) toggles.splice(at, 1);
      };
    }, [key]);
    if (thread === undefined || key === undefined) return null;
    const button = (
      <Toggle
        aria-label="Toggle thread details panel"
        className="relative shrink-0"
        // Where its details show, once the thread's view has measured its room, and whether
        // the card beside the chat is open (D1350).
        data-details-effective={
          presentation === undefined ? undefined : inline ? "inline" : "popover"
        }
        data-details-inline-open={presentation === "inline" ? inlineOpen : undefined}
        data-details-presentation={presentation}
        pressed={open}
        size="sm"
        variant="ghost"
        {...(inline ? { onPressedChange: () => visibility.toggle(key) } : {})}
      />
    );
    const tooltip = (trigger: ReactElement) => (
      <Tooltip>
        <TooltipTrigger render={trigger}>
          <SquareMenuIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Toggle thread details{shortcut ? ` (${shortcut})` : ""}
        </TooltipPopup>
      </Tooltip>
    );
    // Beside a wide chat the card is the view's own (D1350): the button only shows or hides it.
    if (inline) return tooltip(button);
    return (
      <Popover onOpenChange={(next) => visibility.set(key, "popover", next)} open={open}>
        {tooltip(<PopoverTrigger render={button} />)}
        <PopoverPopup align="end" padding="none" side="bottom" variant="panel">
          <DetailsCard
            className="max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))] w-80"
            target={target}
            thread={thread}
            {...(project === undefined ? {} : { project })}
          />
        </PopoverPopup>
      </Popover>
    );
  };
}

/**
 * T3's inline presentation (D1350): the card at the top right of a chat wide enough for it,
 * below the find bar while that is open. It tells the store which presentation fits, so the
 * header's toggle works this card or its popover.
 */
export function ThreadDetailsInline(
  props: ChatThreadDetailsProps & {
    readonly visibility: DetailsVisibility;
    readonly findOpen: boolean;
  },
) {
  const { target, thread, project, visibility } = props;
  const key = detailsKey(target, thread.id);
  const frame = useRef<HTMLDivElement>(null);
  /** `undefined` until measured: the store hears of no presentation before that. */
  const [size, setSize] = useState<
    { width: number; height: number; findBottom: number; padding: number } | undefined
  >();
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => measure());
    // The lane's padding follows Tailwind's `sm`, a media query of the viewport.
    const wide = window.matchMedia("(min-width: 40rem)");
    let findBar: HTMLElement | null = null;
    const measure = () => {
      // The bar is a chunk of its own: it may come a moment after it was opened.
      const bar = props.findOpen
        ? (element.parentElement?.querySelector<HTMLElement>("[data-thread-find-bar]") ?? null)
        : null;
      if (bar !== findBar) {
        if (findBar !== null) observer.unobserve(findBar);
        if (bar !== null) observer.observe(bar);
        findBar = bar;
      }
      const bounds = element.getBoundingClientRect();
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        findBottom: bar === null ? 0 : bar.getBoundingClientRect().bottom - bounds.top,
        padding: lanePadding(),
      };
      setSize((current) =>
        current !== undefined &&
        current.width === next.width &&
        current.height === next.height &&
        current.findBottom === next.findBottom &&
        current.padding === next.padding
          ? current
          : next,
      );
    };
    measure();
    observer.observe(element);
    wide.addEventListener("change", measure);
    const children = new MutationObserver(measure);
    if (element.parentElement !== null) {
      children.observe(element.parentElement, { childList: true });
    }
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", measure);
      children.disconnect();
    };
  }, [props.findOpen]);
  // Below the find bar, as T3 slides its card down to make room for it.
  const placement =
    size === undefined
      ? null
      : inlineDetailsPlacement(size.width, size.height, size.findBottom, size.padding);
  const presentation: DetailsPresentation | undefined =
    size === undefined ? undefined : placement === null ? "popover" : "inline";
  useLayoutEffect(() => {
    visibility.setPresentation(key, presentation);
  }, [key, presentation]);
  // Leaving the thread forgets its room: the next view measures its own.
  useLayoutEffect(() => () => visibility.setPresentation(key, undefined), [key]);
  const open = useSyncExternalStore(visibility.subscribe, () => visibility.open(key, "inline"));
  // Whether the card holds a section: mounted while there is room, open or not, so the toggle
  // knows whether it works this card or the popover.
  const card = useRef<HTMLDivElement>(null);
  const room = placement !== null;
  useLayoutEffect(() => {
    const element = card.current;
    // Without room it is the popover anyway: what the card held stays known across a resize.
    if (!room || element === null) return;
    // A section shows something to read; one that renders an empty element shows nothing.
    const report = () =>
      visibility.setFilled(
        key,
        (element.querySelector("[data-thread-details-content]")?.textContent ?? "").trim() !== "",
      );
    report();
    const observer = new MutationObserver(report);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [key, room]);
  const filled = useSyncExternalStore(
    visibility.subscribe,
    () => visibility.effective(key) === "inline",
  );
  // Forgotten when the thread is left, with its room.
  useLayoutEffect(() => () => visibility.setFilled(key, false), [key]);
  return (
    <div className="pointer-events-none absolute inset-0 z-30" ref={frame}>
      {placement === null ? null : (
        // No landmark of its own: the card inside is the "Thread details" region.
        <div
          ref={card}
          // Closed, or with nothing to show (T3's always has its workspace), it stays out of the
          // way; mounted all the same, so it is known whether it has something.
          className={cn("pointer-events-auto absolute", (!open || !filled) && "hidden")}
          data-thread-details-panel="inline"
          style={{
            right: placement.right,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.height,
          }}
        >
          <DetailsCard
            className="max-h-full"
            target={target}
            thread={thread}
            {...(project === undefined ? {} : { project })}
          />
        </div>
      )}
    </div>
  );
}
