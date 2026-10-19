// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): TerminalViewport in
// apps/web/src/components/ThreadTerminalDrawer.tsx, as it was with xterm.js (before
// acf761b2). Links, "Add to chat" and the selection menu are not ported.
import "@xterm/xterm/css/xterm.css";

import type { RpcClient } from "@jhin/rpc";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useEffectEvent, useRef } from "react";

import { attachTerminal } from "./attach.ts";
import { terminalThemeFromApp } from "./theme.ts";

function fitSafely(fit: FitAddon): boolean {
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}

const systemLine = (message: string) => `\r\n[terminal] ${message}\r\n`;

export function TerminalViewport(props: {
  client: RpcClient;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  /** The process exited or the session closed: T3 closes its tab. */
  onSessionExited: (reason: "exited" | "closed") => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
}) {
  const { client, threadId, terminalId, cwd } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const runningRef = useRef(false);
  const handleSessionExited = useEffectEvent((reason: "exited" | "closed") =>
    props.onSessionExited(reason),
  );
  const readAutoFocus = useEffectEvent(() => props.autoFocus);

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
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily:
        '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fit);
    terminal.open(mount);
    fitSafely(fit);
    terminalRef.current = terminal;
    fitRef.current = fit;

    // What xterm answers to queries in replayed output (cursor position, colours)
    // was meant for a program long gone: it must not reach the shell as input.
    let replaying = 0;
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
          if (!replay) {
            terminal.write(data);
            return;
          }
          replaying += 1;
          terminal.write(data, () => {
            replaying -= 1;
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
      if (replaying === 0) attachment.write(data);
    });

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalThemeFromApp(containerRef.current);
      terminal.refresh(0, terminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // The drawer's size settles after layout; the shell learns it then.
    const observer = new ResizeObserver(() => {
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
      attachment.dispose();
      input.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [client, cwd, terminalId, threadId]);

  useEffect(() => {
    if (!props.autoFocus) return;
    const terminal = terminalRef.current;
    if (terminal === null) return;
    const frame = requestAnimationFrame(() => terminal.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.autoFocus, props.focusRequestId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (terminal === null || fit === null) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = requestAnimationFrame(() => {
      fitSafely(fit);
      if (wasAtBottom) terminal.scrollToBottom();
      resize(terminal);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.drawerHeight, props.resizeEpoch, terminalId, threadId]);

  return (
    <div
      aria-label={props.terminalLabel}
      className="relative h-full w-full overflow-hidden rounded-[4px] bg-background"
      data-terminal-viewport={terminalId}
      ref={containerRef}
      role="group"
    />
  );
}
