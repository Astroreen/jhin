// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/RightPanelTabs.tsx (the strip: tabs, their context menu, dragging,
// scrolling, "Add panel surface", "Open a surface" and its letters),
// apps/web/src/components/ui/panel-tab-close-button.tsx, apps/web/src/components/chat/
// PanelLayoutControls.tsx (RightPanelMaximizeControl), components/preview/PreviewPanelShell.tsx
// and RightPanelResizeHandle.tsx (the shell and its resize handle).
//
// The right panel (t3-parity.md D1421–D1423), a chunk of its own (D440).
import type {
  RightPanelAvailability,
  RightPanelOfferOption,
  RightPanelPlace,
  RightPanelState,
  RightPanelSurface,
  RightPanelSurfaceKind,
  RightPanelSurfaceProps,
  RightPanelTab,
} from "@jhin/client-api";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Button,
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Kbd,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  Component,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

// --- Width (D403's, kept under its key) --------------------------------------------------

const WIDTH_KEY = "jhin:preview-panel-width";
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 540;
const MIN_CHAT_WIDTH = 360;

function maxWidth(): number {
  return Math.max(
    MIN_WIDTH,
    Math.min(Math.floor(window.innerWidth * 0.7), window.innerWidth - MIN_CHAT_WIDTH),
  );
}

function readWidth(): number {
  let stored = Number.NaN;
  try {
    stored = Number(localStorage.getItem(WIDTH_KEY));
  } catch {
    // Blocked storage: the default width.
  }
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
}

/** T3's PreviewPanelShell: inline right of the chat with its resize handle, or over it. */
function PanelShell(props: { children: ReactNode; maximized: boolean }) {
  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  const shown = Math.min(width, maxWidth());
  return (
    <aside
      aria-label="Right panel"
      className={cn(
        "flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        props.maximized
          ? "absolute inset-0 z-30 w-full"
          : "relative shrink-0 border-l border-border",
      )}
      data-right-panel=""
      data-right-panel-maximized={props.maximized ? "true" : "false"}
      style={props.maximized ? undefined : ({ width: `${shown}px` } as CSSProperties)}
    >
      {props.maximized ? null : (
        <div
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemax={maxWidth()}
          aria-valuemin={MIN_WIDTH}
          aria-valuenow={shown}
          className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none"
          onDoubleClick={() => {
            localStorage.removeItem(WIDTH_KEY);
            setWidth(DEFAULT_WIDTH);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startX: event.clientX, startWidth: shown };
          }}
          onPointerMove={(event) => {
            if (drag.current === undefined) return;
            const next = drag.current.startWidth + (drag.current.startX - event.clientX);
            setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(next))));
          }}
          onPointerUp={() => {
            drag.current = undefined;
            localStorage.setItem(WIDTH_KEY, String(width));
          }}
          role="separator"
          tabIndex={-1}
        >
          <div className="mx-auto h-full w-px group-hover:bg-border group-active:bg-primary/60" />
        </div>
      )}
      {props.children}
    </aside>
  );
}

// --- A surface's body ---------------------------------------------------------------------

/** A kind's broken component shows a note in the panel instead of taking it down. */
class SurfaceBoundary extends Component<
  { kind: string; onError: (kind: string, error: unknown) => void; children: ReactNode },
  { error: unknown }
> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(this.props.kind, error);
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="p-4 text-xs text-error-foreground" role="alert">
        {this.props.kind} failed to render
      </div>
    );
  }
}

// --- "Add panel surface" and "Open a surface" -----------------------------------------------

/** Layers whose keys the letters must leave alone (T3's LAUNCHER_SHORTCUT_BLOCKING_LAYERS). */
const BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

/** One kind as the menu and the empty state offer it. */
interface Offer {
  readonly kind: RightPanelSurfaceKind;
  readonly label: string;
  readonly shortcut: string;
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly hint: string | undefined;
  readonly options: readonly RightPanelOfferOption[];
}

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

/** T3's `surfaceShortcutActionForKey`: the available entry whose letter was pressed. */
export function offerForKey(offers: readonly Offer[], event: ShortcutEvent): Offer | undefined {
  if (event.defaultPrevented || event.isComposing) return undefined;
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  return offers.find(
    (offer) =>
      offer.available &&
      offer.shortcut !== "" &&
      offer.shortcut.toLowerCase() === event.key.toLowerCase(),
  );
}

/** T3's `surfaceShortcutTargetsTypingContext`. */
function typesText(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}

const alwaysAvailable = () => ({ available: true });
const NO_OPTIONS: readonly RightPanelOfferOption[] = Object.freeze([]);
const noOptions = () => NO_OPTIONS;

/**
 * Asks one kind whether it can be added here; a component of its own so each kind's hook keeps
 * its place among the hooks however the kinds change.
 */
function OfferProbe(props: {
  kind: RightPanelSurfaceKind;
  place: RightPanelPlace;
  onChange: (id: string, availability: Availability) => void;
}) {
  const use = props.kind.offer?.useAvailability ?? alwaysAvailable;
  const useOptions = props.kind.offer?.useOptions ?? noOptions;
  const { available, reason, hint } = use(props.place) as RightPanelAvailability;
  const options = useOptions(props.place);
  // Compared by what they say, so a fresh array each render is fine.
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    props.onChange(props.kind.id, { available, reason, hint: hint ?? reason, options });
  }, [available, reason, hint, optionsKey]);
  return null;
}

interface Availability {
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly hint: string | undefined;
  readonly options: readonly RightPanelOfferOption[];
}

/** The kinds offered here, in order, with what each kind's hook says of this place. */
function useOffers(kinds: readonly RightPanelSurfaceKind[], place: RightPanelPlace) {
  const [availability, setAvailability] = useState<Readonly<Record<string, Availability>>>({});
  const offered = kinds.filter((kind) => kind.offer !== undefined);
  const offers: Offer[] = offered.map((kind) => {
    const known = availability[kind.id];
    return {
      kind,
      label: kind.offer?.label ?? kind.title,
      shortcut: kind.offer?.shortcut ?? "",
      // Until its hook says, an entry is not offered (no flash of an entry that cannot be).
      available: known?.available ?? false,
      reason: known?.reason,
      hint: known?.hint,
      options: known?.options ?? NO_OPTIONS,
    };
  });
  const probes = offered.map((kind) => (
    <OfferProbe
      key={kind.id}
      kind={kind}
      onChange={(id, next) =>
        setAvailability((current) =>
          current[id]?.available === next.available &&
          current[id]?.reason === next.reason &&
          current[id]?.hint === next.hint &&
          JSON.stringify(current[id]?.options) === JSON.stringify(next.options)
            ? current
            : { ...current, [id]: next },
        )
      }
      place={place}
    />
  ));
  return { offers, probes };
}

function KindIcon(props: { kind: RightPanelSurfaceKind; className?: string }) {
  const Icon = props.kind.icon as ComponentType<{ className?: string }>;
  return <Icon className={props.className ?? "size-4"} />;
}

function DisabledReason(props: { reason: string | undefined; trigger: ReactElement }) {
  if (props.reason === undefined) return props.trigger;
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/** T3's RightPanelEmptyState: "Open a surface". */
function EmptyState(props: {
  offers: readonly Offer[];
  onAdd: (kind: RightPanelSurfaceKind, option?: string) => void;
}) {
  const [highlight, setHighlight] = useState(-1);
  const available = props.offers.filter((offer) => offer.available);
  const index = available.length === 0 ? -1 : Math.min(highlight, available.length - 1);
  const offersRef = useRef(available);
  offersRef.current = available;
  const onAddRef = useRef(props.onAdd);
  onAddRef.current = props.onAdd;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const offer = offerForKey(offersRef.current, event);
      if (offer === undefined) return;
      if (document.querySelector(BLOCKING_LAYERS) !== null) return;
      if (typesText(event.composedPath()[0] ?? event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onAddRef.current(offer.kind);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (available.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((index + 1) % available.length);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        index === -1 ? available.length - 1 : (index - 1 + available.length) % available.length,
      );
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      const offer = available[index];
      if (offer === undefined) return;
      event.preventDefault();
      props.onAdd(offer.kind);
    }
  };

  return (
    <div
      aria-label="Open a surface"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none"
      data-surface-launcher-keys={available.map((offer) => offer.shortcut).join("")}
      onKeyDown={onKeyDown}
      ref={focusOnMount}
      tabIndex={0}
    >
      <div className="w-full max-w-xs py-6">
        <h3 className="mb-3 text-center text-sm font-medium text-foreground">Open a surface</h3>
        <div className="flex flex-col gap-0.5">
          {props.offers.map((offer) =>
            offer.available ? (
              <div
                className="group relative"
                key={offer.kind.id}
                onMouseEnter={() => setHighlight(available.indexOf(offer))}
                onMouseLeave={() =>
                  setHighlight((current) => (current === available.indexOf(offer) ? -1 : current))
                }
              >
                <button
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                    available[index] === offer && "bg-accent/60",
                  )}
                  onClick={() => props.onAdd(offer.kind)}
                  type="button"
                >
                  <KindIcon kind={offer.kind} />
                  <span
                    className={cn("min-w-0 flex-1 truncate", offer.options.length > 1 && "pr-7")}
                  >
                    {offer.label}
                  </span>
                  {offer.shortcut === "" ? null : <Kbd>{offer.shortcut}</Kbd>}
                </button>
                {offer.options.length > 1 ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label={offer.kind.offer?.optionsLabel ?? `Open ${offer.label}`}
                          className="absolute top-1/2 right-8 -translate-y-1/2"
                          size="icon-xs"
                          variant="ghost-muted"
                        />
                      }
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end" className="max-w-56" side="bottom" sideOffset={6}>
                      {offer.options.map((option) => (
                        <MenuItem
                          key={option.id}
                          onClick={() => props.onAdd(offer.kind, option.id)}
                        >
                          <span className="min-w-0 truncate">{option.label}</span>
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : null}
              </div>
            ) : (
              <DisabledReason
                key={offer.kind.id}
                reason={offer.hint}
                trigger={
                  <div
                    aria-disabled="true"
                    className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-left text-sm opacity-50"
                    tabIndex={0}
                  >
                    <KindIcon kind={offer.kind} />
                    <span className="min-w-0 flex-1 truncate">{offer.label}</span>
                    {offer.shortcut === "" ? null : <Kbd>{offer.shortcut}</Kbd>}
                  </div>
                }
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// Module-level so React runs it on mount and unmount only (T3's focusOnMount).
function focusOnMount(node: HTMLDivElement | null) {
  node?.focus();
}

// --- The strip --------------------------------------------------------------------------

const defaultTab = (kind: RightPanelSurfaceKind) => () => ({ title: kind.title });

interface TabProps {
  readonly kind: RightPanelSurfaceKind;
  readonly props: RightPanelSurfaceProps;
  readonly active: boolean;
  readonly index: number;
  readonly count: number;
  onActivate(): void;
  onClose(): void;
  onCloseOthers(): void;
  onCloseToRight(): void;
  onCloseAll(): void;
}

/** One tab: T3's RightPanelTab with its PanelTabCloseButton and its context menu. */
function Tab(props: TabProps) {
  const { kind } = props;
  const useTab = kind.useTab ?? defaultTab(kind);
  const tab = useTab(props.props) as RightPanelTab;
  const items = kind.menuItems?.(props.props) ?? [];
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.props.surface.id,
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              "group/tab flex h-6 max-w-36 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
              props.active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              isDragging && "relative z-10",
            )}
            data-active-tab={props.active}
            data-surface-id={props.props.surface.id}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            {...listeners}
            ref={setNodeRef}
            style={{ transform: CSS.Translate.toString(transform), transition }}
          />
        }
      >
        <button
          aria-label={`Close ${tab.title}`}
          className="group/close relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted"
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
          type="button"
        >
          <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
            {tab.icon === undefined ? (
              <KindIcon className="size-3 shrink-0" kind={kind} />
            ) : (
              (tab.icon as ReactNode)
            )}
          </span>
          <XIcon className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-selected={props.active}
                className="flex min-w-0 cursor-pointer items-center outline-none"
                onClick={props.onActivate}
                role="tab"
                type="button"
              />
            }
          >
            <span className="truncate">{tab.title}</span>
          </TooltipTrigger>
          <TooltipPopup>{tab.title}</TooltipPopup>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        {items.map((item) => (
          <MenuItem disabled={item.disabled} key={item.id} onClick={item.onSelect}>
            {item.label}
          </MenuItem>
        ))}
        {items.length === 0 ? null : <MenuSeparator />}
        <MenuItem onClick={props.onClose}>Close</MenuItem>
        <MenuItem disabled={props.count <= 1} onClick={props.onCloseOthers}>
          Close others
        </MenuItem>
        <MenuItem disabled={props.index >= props.count - 1} onClick={props.onCloseToRight}>
          Close to the right
        </MenuItem>
        <MenuItem disabled={props.count === 0} onClick={props.onCloseAll}>
          Close all
        </MenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

const SCROLL_EDGE = 1;

export interface RightPanelViewProps {
  readonly place: RightPanelPlace;
  readonly state: RightPanelState;
  readonly kinds: readonly RightPanelSurfaceKind[];
  /** A kind's registration key, new when its plugin registers it again. */
  kindKey(id: string): string | undefined;
  /** Bumped to open "Add panel surface" (`right-panel.new`). */
  readonly newSurfaceRequests: { current(): number; subscribe(listener: () => void): () => void };
  onActivate(surface: RightPanelSurface): void;
  onAdd(kind: RightPanelSurfaceKind, option?: string): void;
  onClose(id: string): void;
  onCloseOthers(id: string): void;
  onCloseToRight(id: string): void;
  onCloseAll(): void;
  onMove(id: string, index: number): void;
  onToggleMaximized(): void;
  onError(kind: string, error: unknown): void;
}

/** T3's RightPanelTabs: the strip, then the active surface or "Open a surface". */
export function RightPanelView(props: RightPanelViewProps) {
  const { place, state } = props;
  const byId = new Map(props.kinds.map((kind) => [kind.id, kind]));
  // A surface whose kind is not registered keeps its place but has no tab (D1421).
  const surfaces = state.surfaces.filter((surface) => byId.has(surface.kind));
  const active = surfaces.find((surface) => surface.id === state.activeId);
  const { offers, probes } = useOffers(props.kinds, place);
  const [menuOpen, setMenuOpen] = useState(false);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // ⌘/Ctrl+T (`right-panel.new`) opens the menu, as T3's `rightPanel.new` does.
  const requests = useSyncExternalStore(
    props.newSurfaceRequests.subscribe,
    props.newSurfaceRequests.current,
  );
  const seenRequests = useRef(requests);
  useEffect(() => {
    if (requests === seenRequests.current) return;
    seenRequests.current = requests;
    addTrigger.current?.focus();
    setMenuOpen(true);
  }, [requests]);

  useEffect(() => {
    const viewport = strip.current;
    if (viewport === null) return;
    const measure = () => {
      const overflow = viewport.scrollWidth - viewport.clientWidth > SCROLL_EDGE;
      const left = overflow && viewport.scrollLeft > SCROLL_EDGE;
      const right =
        overflow && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - SCROLL_EDGE;
      setScroll((current) =>
        current.overflow === overflow && current.left === left && current.right === right
          ? current
          : { overflow, left, right },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (viewport.firstElementChild !== null) observer.observe(viewport.firstElementChild);
    viewport.addEventListener("scroll", measure, { passive: true });
    // T3's wheel: a vertical wheel scrolls the strip sideways.
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;
      const before = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === before) return;
      event.preventDefault();
      measure();
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    measure();
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
      viewport.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    if (!scroll.overflow) return;
    strip.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId, scroll.overflow]);

  const scrollBy = (direction: -1 | 1) => {
    const viewport = strip.current;
    if (viewport === null) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const offer = offerForKey(offers, event.nativeEvent);
    if (offer === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
    props.onAdd(offer.kind);
  };

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (over === null || dragged.id === over.id) return;
    const toIndex = state.surfaces.findIndex((surface) => surface.id === over.id);
    if (toIndex >= 0) props.onMove(String(dragged.id), toIndex);
  };

  const maximizeLabel = state.maximized ? "Restore panel size" : "Maximize panel";
  const ActiveKind = active === undefined ? undefined : byId.get(active.kind);
  const Body = ActiveKind?.component as ComponentType<RightPanelSurfaceProps> | undefined;
  return (
    <PanelShell maximized={state.maximized}>
      {probes}
      <div
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pr-2 pl-2"
        data-right-panel-tabbar=""
      >
        <div
          className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-right-panel-tab-list=""
          ref={strip}
        >
          <div
            aria-label="Panel surfaces"
            className="flex h-full w-max min-w-full items-center gap-1"
            role="tablist"
          >
            <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
              <SortableContext
                items={surfaces.map((surface) => surface.id)}
                strategy={horizontalListSortingStrategy}
              >
                {surfaces.map((surface, index) => {
                  const kind = byId.get(surface.kind)!;
                  return (
                    <Tab
                      active={surface.id === active?.id}
                      count={surfaces.length}
                      index={index}
                      key={`${surface.id}|${props.kindKey(surface.kind) ?? ""}`}
                      kind={kind}
                      onActivate={() => props.onActivate(surface)}
                      onClose={() => props.onClose(surface.id)}
                      onCloseAll={props.onCloseAll}
                      onCloseOthers={() => props.onCloseOthers(surface.id)}
                      onCloseToRight={() => props.onCloseToRight(surface.id)}
                      props={{ place, surface }}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
            <Menu onOpenChange={setMenuOpen} open={menuOpen}>
              <MenuTrigger
                ref={addTrigger}
                render={
                  <Button
                    aria-label="Add panel surface"
                    className="shrink-0"
                    size="icon-xs"
                    variant="ghost-muted"
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup
                align="start"
                onKeyDownCapture={onMenuKeyDown}
                side="bottom"
                sideOffset={6}
              >
                {offers.map((offer) => {
                  if (offer.available && offer.options.length > 1) {
                    // T3's Browser entry: a submenu of profiles; clicking it opens the default.
                    return (
                      <MenuSub key={offer.kind.id}>
                        <MenuSubTrigger
                          aria-keyshortcuts={offer.shortcut === "" ? undefined : offer.shortcut}
                          onClick={(event) => {
                            const pointer = (event.nativeEvent as PointerEvent).pointerType;
                            if (pointer === "touch") return;
                            setMenuOpen(false);
                            props.onAdd(offer.kind);
                          }}
                        >
                          <KindIcon kind={offer.kind} />
                          {offer.label}
                          {offer.shortcut === "" ? null : (
                            <MenuShortcut>{offer.shortcut}</MenuShortcut>
                          )}
                        </MenuSubTrigger>
                        <MenuSubPopup className="max-w-56">
                          {offer.options.map((option) => (
                            <MenuItem
                              key={option.id}
                              onClick={() => props.onAdd(offer.kind, option.id)}
                            >
                              <span className="min-w-0 truncate">{option.label}</span>
                            </MenuItem>
                          ))}
                        </MenuSubPopup>
                      </MenuSub>
                    );
                  }
                  const item = (
                    <MenuItem
                      aria-keyshortcuts={offer.shortcut === "" ? undefined : offer.shortcut}
                      className={offer.available ? undefined : "data-disabled:pointer-events-auto"}
                      disabled={!offer.available}
                      key={offer.kind.id}
                      onClick={() => props.onAdd(offer.kind)}
                    >
                      <KindIcon kind={offer.kind} />
                      {offer.label}
                      {offer.shortcut === "" ? null : <MenuShortcut>{offer.shortcut}</MenuShortcut>}
                    </MenuItem>
                  );
                  return offer.available ? (
                    item
                  ) : (
                    <DisabledReason key={offer.kind.id} reason={offer.reason} trigger={item} />
                  );
                })}
              </MenuPopup>
            </Menu>
          </div>
        </div>
        {scroll.overflow ? (
          <div
            aria-label="Scroll panel tabs"
            className="flex shrink-0 items-center gap-0.5"
            role="group"
          >
            <Button
              aria-label="Scroll tabs left"
              disabled={!scroll.left}
              onClick={() => scrollBy(-1)}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              aria-label="Scroll tabs right"
              disabled={!scroll.right}
              onClick={() => scrollBy(1)}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={maximizeLabel}
                className="shrink-0"
                onPressedChange={props.onToggleMaximized}
                pressed={state.maximized}
                size="sm"
                variant="ghost"
              />
            }
          >
            {state.maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{maximizeLabel}</TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content="">
        {active === undefined || Body === undefined ? (
          <EmptyState offers={offers} onAdd={props.onAdd} />
        ) : (
          <SurfaceBoundary
            key={`${active.id}|${props.kindKey(active.kind) ?? ""}`}
            kind={active.kind}
            onError={props.onError}
          >
            <Body place={place} surface={active} />
          </SurfaceBoundary>
        )}
      </div>
    </PanelShell>
  );
}
