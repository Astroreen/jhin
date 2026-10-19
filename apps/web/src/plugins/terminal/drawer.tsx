// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ThreadTerminalDrawer.tsx
// (the drawer, its resize handle, action buttons, split panes and terminal sidebar) and
// apps/web/src/components/ui/panel-tab-close-button.tsx.
import type { RpcClient } from "@jhin/rpc";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  Plus,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  normalizeThreadTerminalUiState,
  type ThreadTerminalGroup,
  type ThreadTerminalUiState,
} from "../../lib/terminal-state.ts";
import { TerminalViewport } from "./viewport.tsx";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number, maxHeight = maxDrawerHeight()): number {
  const safe = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(Math.max(Math.round(safe), MIN_DRAWER_HEIGHT), maxHeight);
}

function PanelTabCloseButton(props: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  tooltip?: string;
}) {
  const button = (
    <button
      aria-label={props.label}
      className="group/close relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted"
      onClick={props.onClick}
      type="button"
    >
      <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
        {props.children}
      </span>
      <XIcon className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
    </button>
  );
  if (props.tooltip === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function TerminalActionButton(props: {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <button
            aria-disabled={props.disabled}
            aria-label={props.label}
            className={cn(props.className, props.disabled && "cursor-not-allowed opacity-45")}
            onClick={props.disabled ? undefined : props.onClick}
            type="button"
          />
        }
      >
        {props.children}
      </PopoverTrigger>
      <PopoverPopup
        align="center"
        className="pointer-events-none select-none"
        side="bottom"
        sideOffset={6}
        tooltipStyle
      >
        {props.label}
      </PopoverPopup>
    </Popover>
  );
}

export interface TerminalDrawerProps {
  client: RpcClient;
  threadId: string;
  cwd: string;
  state: ThreadTerminalUiState;
  /** The tab names: the program a terminal runs, else "Terminal N". */
  labelOf: (terminalId: string) => string;
  focusRequestId: number;
  shortcuts: {
    split?: string | undefined;
    splitVertical?: string | undefined;
    new?: string | undefined;
    close?: string | undefined;
  };
  onSplit: () => void;
  onSplitVertical: () => void;
  onNew: () => void;
  onActiveChange: (terminalId: string) => void;
  /** Asks first, as T3 does. */
  onCloseRequest: (terminalId: string) => void;
  /**
   * The process exited, or the session was closed (by another client, a
   * deleted thread, the node): the tab goes without asking.
   */
  onClosed: (terminalId: string, reason: "exited" | "closed") => void;
  onHeightChange: (height: number) => void;
}

/** T3's terminal drawer under the chat: one terminal, or split groups with a list of them. */
export function TerminalDrawer(props: TerminalDrawerProps) {
  const state = normalizeThreadTerminalUiState(props.state);
  const [windowMax, setWindowMax] = useState(maxDrawerHeight);
  const [heightState, setHeightState] = useState(() => ({
    threadId: props.threadId,
    height: state.terminalHeight,
  }));
  const preferredHeight =
    heightState.threadId === props.threadId ? heightState.height : state.terminalHeight;
  const drawerHeight = clampDrawerHeight(preferredHeight, windowMax);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    drawer: HTMLElement | null;
  } | null>(null);
  const didResizeRef = useRef(false);

  const terminalIds = state.terminalIds;
  const groups: readonly ThreadTerminalGroup[] = state.terminalGroups;
  const activeTerminalId = state.activeTerminalId;
  const activeGroupIndex = Math.max(
    0,
    groups.findIndex((group) => group.id === state.activeTerminalGroupId),
  );
  const visibleTerminalIds =
    groups[activeGroupIndex]?.terminalIds ?? (activeTerminalId === "" ? [] : [activeTerminalId]);
  const splitDirection = groups[activeGroupIndex]?.splitDirection ?? "horizontal";
  const hasTerminalSidebar = terminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    groups.length > 1 || groups.some((group) => group.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const { shortcuts } = props;
  const splitLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : shortcuts.split
      ? `Split Terminal Horizontally (${shortcuts.split})`
      : "Split Terminal Horizontally";
  const splitVerticalLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : shortcuts.splitVertical
      ? `Split Terminal Vertically (${shortcuts.splitVertical})`
      : "Split Terminal Vertically";
  const newLabel = shortcuts.new ? `New Terminal (${shortcuts.new})` : "New Terminal";
  const closeLabel = shortcuts.close ? `Close Terminal (${shortcuts.close})` : "Close Terminal";
  const onSplit = () => {
    if (!hasReachedSplitLimit) props.onSplit();
  };
  const onSplitVertical = () => {
    if (!hasReachedSplitLimit) props.onSplitVertical();
  };

  useLayoutEffect(() => {
    const resizeState = resizeStateRef.current;
    if (resizeState !== null) {
      resizeState.drawer?.style.setProperty("height", `${drawerHeightRef.current}px`);
      return;
    }
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
      drawer: event.currentTarget.parentElement,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (resizeState === null || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clamped = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clamped === drawerHeightRef.current) return;
    didResizeRef.current = true;
    drawerHeightRef.current = clamped;
    resizeState.drawer?.style.setProperty("height", `${clamped}px`);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (resizeState === null || resizeState.pointerId !== event.pointerId) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A drag that ends where it started keeps the stored preference.
    if (!didResizeRef.current || drawerHeightRef.current === resizeState.startHeight) {
      const rendered = clampDrawerHeight(preferredHeight);
      drawerHeightRef.current = rendered;
      resizeState.drawer?.style.setProperty("height", `${rendered}px`);
      return;
    }
    setHeightState({ threadId: props.threadId, height: drawerHeightRef.current });
    props.onHeightChange(drawerHeightRef.current);
    setResizeEpoch((value) => value + 1);
  };

  const onWindowResize = useEffectEvent(() => {
    const resizeState = resizeStateRef.current;
    const live = clampDrawerHeight(drawerHeightRef.current);
    if (resizeState !== null && live !== drawerHeightRef.current) {
      drawerHeightRef.current = live;
      resizeState.drawer?.style.setProperty("height", `${live}px`);
    }
    setWindowMax(maxDrawerHeight());
    setResizeEpoch((value) => value + 1);
  });
  useEffect(() => {
    const listener = () => onWindowResize();
    window.addEventListener("resize", listener);
    return () => window.removeEventListener("resize", listener);
  }, []);

  const handle = (
    <div
      className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
      onLostPointerCapture={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
    />
  );

  if (terminalIds.length === 0) {
    return (
      <aside
        aria-label="Terminal"
        className="thread-terminal-drawer relative z-45 flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
        data-terminal-owner="drawer"
        data-thread-terminal-drawer
        style={{ height: `${drawerHeight}px` }}
      >
        {handle}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
          <p>No terminal sessions for this thread yet.</p>
          <Button onClick={props.onNew} size="xs" variant="outline">
            {newLabel}
          </Button>
        </div>
      </aside>
    );
  }

  const viewport = (terminalId: string, autoFocus: boolean) => (
    <TerminalViewport
      autoFocus={autoFocus}
      client={props.client}
      cwd={props.cwd}
      drawerHeight={drawerHeight}
      focusRequestId={props.focusRequestId}
      key={terminalId}
      onSessionExited={(reason) => props.onClosed(terminalId, reason)}
      resizeEpoch={resizeEpoch}
      terminalId={terminalId}
      terminalLabel={props.labelOf(terminalId)}
      threadId={props.threadId}
    />
  );

  const actionClass = (base: string, limited: boolean) =>
    `${base} text-foreground/90 transition-colors ${
      limited ? "cursor-not-allowed opacity-64 hover:bg-transparent" : "hover:bg-accent"
    }`;

  return (
    <aside
      aria-label="Terminal"
      className="thread-terminal-drawer relative z-45 flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      data-terminal-owner="drawer"
      data-thread-terminal-drawer
      style={{ height: `${drawerHeight}px` }}
    >
      {handle}
      {hasTerminalSidebar ? null : (
        <div className="pointer-events-none absolute top-2 right-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background shadow-xs">
            <TerminalActionButton
              className={actionClass("p-1", hasReachedSplitLimit)}
              label={splitLabel}
              onClick={onSplit}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={actionClass("p-1", hasReachedSplitLimit)}
              label={splitVerticalLabel}
              onClick={onSplitVertical}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={actionClass("p-1", false)}
              label={newLabel}
              onClick={props.onNew}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={actionClass("p-1", false)}
              label={closeLabel}
              onClick={() => props.onCloseRequest(activeTerminalId)}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex h-full min-h-0 bg-(--terminal-background)",
            hasTerminalSidebar && "gap-1.5",
          )}
        >
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  splitDirection === "vertical"
                    ? { gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))` }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    className={cn(
                      "min-h-0 min-w-0",
                      splitDirection === "vertical"
                        ? "border-t first:border-t-0"
                        : "border-l first:border-l-0",
                      terminalId === activeTerminalId ? "border-border" : "border-border/70",
                    )}
                    key={terminalId}
                    onPointerDown={() => {
                      if (terminalId !== activeTerminalId) props.onActiveChange(terminalId);
                    }}
                  >
                    <div className="h-full">
                      {viewport(terminalId, terminalId === activeTerminalId)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full">{viewport(activeTerminalId, true)}</div>
            )}
          </div>

          {hasTerminalSidebar ? (
            <aside
              aria-label="Terminals"
              className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10"
            >
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={actionClass(
                      "inline-flex h-full items-center px-1",
                      hasReachedSplitLimit,
                    )}
                    label={splitLabel}
                    onClick={onSplit}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={actionClass(
                      "inline-flex h-full items-center border-l border-border/70 px-1",
                      hasReachedSplitLimit,
                    )}
                    label={splitVerticalLabel}
                    onClick={onSplitVertical}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={actionClass(
                      "inline-flex h-full items-center border-l border-border/70 px-1",
                      false,
                    )}
                    label={newLabel}
                    onClick={props.onNew}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={actionClass(
                      "inline-flex h-full items-center border-l border-border/70 px-1",
                      false,
                    )}
                    label={closeLabel}
                    onClick={() => props.onCloseRequest(activeTerminalId)}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {groups.map((group) => (
                  <TerminalSidebarGroup
                    activeTerminalId={activeTerminalId}
                    closeShortcut={shortcuts.close}
                    group={group}
                    key={group.id}
                    labelOf={props.labelOf}
                    onActiveChange={props.onActiveChange}
                    onClose={props.onCloseRequest}
                    showHeader={showGroupHeaders}
                  />
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function TerminalSidebarGroup(props: {
  group: ThreadTerminalGroup;
  activeTerminalId: string;
  showHeader: boolean;
  labelOf: (terminalId: string) => string;
  closeShortcut: string | undefined;
  onActiveChange: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
}) {
  const { group, activeTerminalId } = props;
  const isGroupActive = group.terminalIds.includes(activeTerminalId);
  const groupActiveTerminalId = isGroupActive
    ? activeTerminalId
    : (group.terminalIds[0] ?? activeTerminalId);
  const count = group.terminalIds.length;
  const isSplit = count > 1;
  const groupLabel = !isSplit
    ? "Single"
    : group.splitDirection === "vertical"
      ? "Stacked"
      : "Side by side";
  const GroupIcon = !isSplit
    ? Square
    : group.splitDirection === "vertical"
      ? SquareSplitVertical
      : SquareSplitHorizontal;
  return (
    <div className="pb-0.5">
      {props.showHeader ? (
        <button
          className={`flex h-[22px] w-full cursor-pointer items-center gap-1 rounded px-1.5 text-2xs ${
            isGroupActive
              ? "bg-accent/50 text-foreground"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          }`}
          onClick={() => props.onActiveChange(groupActiveTerminalId)}
          type="button"
        >
          <GroupIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{groupLabel}</span>
          <span className="text-3xs text-muted-foreground/70 tabular-nums">{count}</span>
        </button>
      ) : null}
      <div className="flex flex-col gap-0.5">
        {group.terminalIds.map((terminalId) => {
          const isActive = terminalId === activeTerminalId;
          const label = props.labelOf(terminalId);
          const closeLabel = `Close ${label}${
            isActive && props.closeShortcut ? ` (${props.closeShortcut})` : ""
          }`;
          return (
            <div
              className={cn(
                "group/tab flex h-6 w-full items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              key={terminalId}
            >
              <PanelTabCloseButton
                label={closeLabel}
                onClick={() => props.onClose(terminalId)}
                tooltip={closeLabel}
              >
                <TerminalSquare className="size-3 shrink-0" />
              </PanelTabCloseButton>
              <button
                aria-current={isActive ? "true" : undefined}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                onClick={() => props.onActiveChange(terminalId)}
                type="button"
              >
                <span className="truncate">{label}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
