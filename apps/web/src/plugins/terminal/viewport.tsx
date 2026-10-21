// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): TerminalViewport in
// apps/web/src/components/ThreadTerminalDrawer.tsx, as it was with xterm.js (before
// acf761b2): the link provider, the selection menu ("Add to chat", "Copy") and the
// context menu of nightly eb7b35ac ("Paste", "Select all", "Jump to latest").
import "@xterm/xterm/css/xterm.css";

import type { RpcClient } from "@jhin/rpc";
import { Menu, MenuItem, MenuPopup, copyText } from "@jhin/ui";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { attachTerminal } from "./attach.ts";
import { terminalSelectionLines, type TerminalContextSelection } from "./context.ts";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "./links.ts";
import { muteRepliesWhileReplaying } from "./replay.ts";
import { terminalThemeFromApp } from "./theme.ts";

/** T3's monospace stack, used when no terminal font is set. */
export const DEFAULT_TERMINAL_FONT_STACK =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';

/** A font setting before the default stack, quoted where it needs quotes (T3's appearanceFontStack). */
export function terminalFontStack(custom: string): string {
  const families = custom
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) =>
      /^(['"]).*\1$/.test(name) || /^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)
        ? name
        : `"${name.replaceAll('"', "")}"`,
    );
  return families.length === 0
    ? DEFAULT_TERMINAL_FONT_STACK
    : `${families.join(", ")}, ${DEFAULT_TERMINAL_FONT_STACK}`;
}

function fitSafely(fit: FitAddon): boolean {
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}

const systemLine = (message: string) => `\r\n[terminal] ${message}\r\n`;

type MenuAction = "add-to-chat" | "copy" | "paste" | "select-all" | "scroll-to-bottom";
interface OpenMenu {
  readonly x: number;
  readonly y: number;
  /** The selection menu (after selecting), or the whole context menu (a right-click). */
  readonly kind: "selection" | "context";
  readonly selection: TerminalContextSelection | undefined;
  readonly clipboardText: string;
}

/** Keeps the menu's point inside the terminal and the window (T3's resolveSelectionActionPosition). */
function menuPoint(bounds: DOMRect, pointer: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(
      8,
      Math.min(Math.max(bounds.left, pointer.x), bounds.left + bounds.width, window.innerWidth - 8),
    ),
    y: Math.max(
      8,
      Math.min(Math.max(bounds.top, pointer.y), bounds.top + bounds.height, window.innerHeight - 8),
    ),
  };
}

export function TerminalViewport(props: {
  client: RpcClient;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  /** The process exited or the session closed: T3 closes its tab. */
  onSessionExited: (reason: "exited" | "closed") => void;
  /** "Add to chat" for a selection; without it the menus leave the item out. */
  onAddToChat?: ((selection: TerminalContextSelection) => void) | undefined;
  focusRequestId: number;
  autoFocus: boolean;
  /** Shown: a hidden terminal stays mounted and fits again when it shows (D474). */
  visible: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  fontFamily: string;
  fontSize: number;
}) {
  const { client, threadId, terminalId, cwd } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const runningRef = useRef(false);
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);
  const handleSessionExited = useEffectEvent((reason: "exited" | "closed") =>
    props.onSessionExited(reason),
  );
  const readAutoFocus = useEffectEvent(() => props.autoFocus && props.visible);
  const readLabel = useEffectEvent(() => props.terminalLabel);
  const readFont = useEffectEvent(() => ({ family: props.fontFamily, size: props.fontSize }));

  const resize = (terminal: Terminal) => {
    if (!runningRef.current) return;
    void client
      .call("terminals.resize", { threadId, terminalId, cols: terminal.cols, rows: terminal.rows })
      .catch(() => undefined);
  };

  useEffect(() => {
    const mount = containerRef.current;
    if (mount === null) return;
    const fit = new FitAddon();
    const font = readFont();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1,
      fontSize: font.size,
      scrollback: 5_000,
      fontFamily: terminalFontStack(font.family),
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fit);
    terminal.open(mount);
    fitSafely(fit);
    terminalRef.current = terminal;
    fitRef.current = fit;

    // What xterm answers to queries in replayed output (cursor position, colours)
    // was meant for a program long gone: those answers are muted while a replay
    // is parsed. Typing is not: keys pressed meanwhile go to the shell.
    let replaying = 0;
    const muted = muteRepliesWhileReplaying(terminal, () => replaying > 0);
    const attachment = attachTerminal({
      client,
      threadId,
      terminalId,
      cwd,
      size: () => ({ cols: terminal.cols, rows: terminal.rows }),
      sink: {
        reset() {
          runningRef.current = true;
          terminal.reset();
          if (readAutoFocus()) requestAnimationFrame(() => terminal.focus());
        },
        write(data, replay) {
          // Done once xterm parsed it: the node sends more as output is shown (D470).
          return new Promise<void>((resolve) => {
            if (!replay) {
              terminal.write(data, resolve);
              return;
            }
            replaying += 1;
            terminal.write(data, () => {
              replaying -= 1;
              resolve();
            });
          });
        },
        system: (message) => terminal.write(systemLine(message)),
        ended(reason) {
          runningRef.current = false;
          setTimeout(() => handleSessionExited(reason), 0);
        },
      },
    });

    const input = terminal.onData((data) => {
      if (!muted.isReply()) attachment.write(data);
    });

    // Links (D472): URLs open in a new tab with ⌘-click (macOS) or Ctrl-click.
    const links = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const wrapped = collectWrappedTerminalLinkLine(bufferLineNumber, (index) =>
          terminal.buffer.active.getLine(index),
        );
        if (wrapped === null) {
          callback(undefined);
          return;
        }
        const found = extractTerminalLinks(wrapped.text)
          // A path has nowhere to open yet: only URLs are links.
          .filter((match) => match.kind === "url")
          .map((match) => ({ match, range: resolveWrappedTerminalLinkRange(wrapped, match) }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        callback(
          found.length === 0
            ? undefined
            : found.map(({ match, range }) => ({
                text: match.text,
                range,
                activate(event: MouseEvent) {
                  if (!isTerminalLinkActivation(event)) return;
                  window.open(match.text, "_blank", "noopener,noreferrer");
                },
              })),
        );
      },
    });

    /** What the selection is, for the menus; none when nothing is selected. */
    const readSelection = (): { selection: TerminalContextSelection; text: string } | undefined => {
      if (!terminal.hasSelection()) return undefined;
      const text = terminal.getSelection();
      const position = terminal.getSelectionPosition();
      if (position === undefined || text.replace(/\s+/g, "").length === 0) return undefined;
      return {
        text,
        selection: {
          terminalId,
          terminalLabel: readLabel(),
          ...terminalSelectionLines(position),
          text,
        },
      };
    };
    const openMenu = (kind: OpenMenu["kind"], pointer: { x: number; y: number }) => {
      const found = readSelection();
      if (kind === "selection" && found === undefined) return;
      setMenu({
        kind,
        ...menuPoint(mount.getBoundingClientRect(), pointer),
        selection: found?.selection,
        clipboardText: found?.text ?? "",
      });
    };
    // The selection menu shows once a drag or a double-click selected something.
    let selecting = false;
    /** The frame that opens the selection menu, cancelled with the viewport. */
    let menuFrame: number | undefined;
    const onPointerDown = (event: PointerEvent) => {
      selecting = event.isPrimary && event.button === 0;
      setMenu(undefined);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!selecting || event.button !== 0) return;
      selecting = false;
      const pointer = { x: event.clientX, y: event.clientY };
      menuFrame = requestAnimationFrame(() => openMenu("selection", pointer));
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      openMenu("context", { x: event.clientX, y: event.clientY });
    };
    mount.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("mouseup", onMouseUp);
    mount.addEventListener("contextmenu", onContextMenu);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalThemeFromApp(containerRef.current);
      terminal.refresh(0, terminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // The drawer's size settles after layout; the shell learns it then. A
    // hidden terminal has no size: it fits again once it shows.
    const observer = new ResizeObserver(() => {
      if (mount.clientWidth === 0 || mount.clientHeight === 0) return;
      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      const before = `${terminal.cols}x${terminal.rows}`;
      if (!fitSafely(fit)) return;
      if (wasAtBottom) terminal.scrollToBottom();
      if (`${terminal.cols}x${terminal.rows}` !== before) resize(terminal);
    });
    observer.observe(mount);

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      mount.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("mouseup", onMouseUp);
      mount.removeEventListener("contextmenu", onContextMenu);
      if (menuFrame !== undefined) cancelAnimationFrame(menuFrame);
      links.dispose();
      attachment.dispose();
      input.dispose();
      muted.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [client, cwd, terminalId, threadId]);

  // Fonts follow the settings as they change (D472).
  useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (terminal === null || fit === null) return;
    terminal.options.fontFamily = terminalFontStack(props.fontFamily);
    terminal.options.fontSize = props.fontSize;
    const before = `${terminal.cols}x${terminal.rows}`;
    if (fitSafely(fit) && `${terminal.cols}x${terminal.rows}` !== before) resize(terminal);
  }, [props.fontFamily, props.fontSize]);

  useEffect(() => {
    if (!props.autoFocus || !props.visible) return;
    const terminal = terminalRef.current;
    if (terminal === null) return;
    const frame = requestAnimationFrame(() => terminal.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.autoFocus, props.focusRequestId, props.visible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (terminal === null || fit === null || !props.visible) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = requestAnimationFrame(() => {
      fitSafely(fit);
      if (wasAtBottom) terminal.scrollToBottom();
      resize(terminal);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.drawerHeight, props.resizeEpoch, props.visible, terminalId, threadId]);

  const run = async (action: MenuAction, opened: OpenMenu) => {
    setMenu(undefined);
    const terminal = terminalRef.current;
    if (terminal === null) return;
    switch (action) {
      case "add-to-chat":
        if (opened.selection !== undefined) props.onAddToChat?.(opened.selection);
        terminal.clearSelection();
        break;
      case "copy":
        await copyText(opened.clipboardText).catch((error: unknown) =>
          terminal.write(
            systemLine((error as Error).message || "Unable to copy terminal selection"),
          ),
        );
        break;
      case "paste": {
        const text = await navigator.clipboard.readText().catch(() => undefined);
        if (text === undefined) {
          terminal.write(systemLine("Unable to read the clipboard"));
          break;
        }
        if (text.length > 0) terminal.paste(text);
        break;
      }
      case "select-all":
        terminal.selectAll();
        break;
      case "scroll-to-bottom":
        terminal.scrollToBottom();
        break;
    }
    terminal.focus();
  };

  // One anchor per opened menu: a new one each render would move the menu each time.
  const anchor = useMemo(
    () =>
      menu === undefined
        ? undefined
        : {
            getBoundingClientRect: () =>
              DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
          },
    [menu],
  );
  const items: { id: MenuAction; label: string; disabled?: boolean }[] =
    menu === undefined
      ? []
      : [
          ...(props.onAddToChat === undefined
            ? []
            : [
                {
                  id: "add-to-chat" as const,
                  label: "Add to chat",
                  disabled: menu.selection === undefined,
                },
              ]),
          { id: "copy", label: "Copy", disabled: menu.selection === undefined },
          ...(menu.kind === "context"
            ? [
                { id: "paste" as const, label: "Paste" },
                { id: "select-all" as const, label: "Select all" },
                { id: "scroll-to-bottom" as const, label: "Jump to latest" },
              ]
            : []),
        ];

  return (
    <>
      <div
        aria-label={props.terminalLabel}
        className="relative h-full w-full overflow-hidden rounded-[4px] bg-background"
        data-terminal-viewport={terminalId}
        ref={containerRef}
        role="group"
      />
      <Menu
        onOpenChange={(open) => {
          if (!open) setMenu(undefined);
        }}
        open={menu !== undefined}
      >
        {menu === undefined ? null : (
          <MenuPopup align="start" anchor={anchor} side="bottom" sideOffset={2}>
            {items.map((item) => (
              <MenuItem
                disabled={item.disabled === true}
                key={item.id}
                onClick={() => void run(item.id, menu)}
              >
                {item.label}
              </MenuItem>
            ))}
          </MenuPopup>
        )}
      </Menu>
    </>
  );
}
