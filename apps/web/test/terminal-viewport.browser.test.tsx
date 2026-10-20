import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import { TerminalEvents, type TerminalSnapshot } from "@jhin/terminal-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { TerminalViewport } from "../src/plugins/terminal/viewport.tsx";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const snapshot = (history: string): TerminalSnapshot => ({
  threadId: "t",
  terminalId: "term-1",
  cwd: "/work",
  status: "running",
  pid: 10,
  exitCode: null,
  signal: null,
  cols: 80,
  rows: 24,
  hasRunningSubprocess: false,
  label: "",
  startedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  instance: "run-1",
  history,
  sequence: 1,
});

/** Types one printable key into xterm's input, as a keyboard does (xterm takes it on keydown). */
function type(container: HTMLElement, key: string): void {
  const input = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key, keyCode: key.toUpperCase().charCodeAt(0), bubbles: true }),
  );
}

/**
 * A node with one running terminal whose kept output is `history`. `onFollow`
 * runs when the viewport subscribes to the stream: the replay is written to
 * xterm by then, not yet parsed.
 */
function render(options: { history: string; onFollow?: (container: HTMLElement) => void }) {
  const writes: string[] = [];
  const waiting: { test: (data: string) => boolean; resolve: () => void }[] = [];
  const container = document.createElement("div");
  container.style.height = "300px";
  container.style.width = "600px";
  let live: ((event: unknown) => void) | undefined;
  const client = {
    state: "open",
    onState: () => toDisposable(() => undefined),
    async call(method: string, params: { data?: string }) {
      if (method === "terminals.get") return snapshot(options.history);
      if (method === "terminals.write") {
        writes.push(params.data!);
        for (const waiter of waiting.filter((item) => item.test(params.data!))) {
          waiting.splice(waiting.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      return {};
    },
    subscribe(_stream: string, _options: unknown, onEvent: (event: unknown) => void) {
      live = onEvent;
      options.onFollow?.(container);
      return { lastSequence: 1, dispose() {} };
    },
  } as unknown as RpcClient;
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <TerminalViewport
        autoFocus={false}
        client={client}
        cwd="/work"
        drawerHeight={300}
        focusRequestId={0}
        onSessionExited={() => undefined}
        resizeEpoch={0}
        terminalId="term-1"
        terminalLabel="Terminal 1"
        threadId="t"
      />,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const sent = (test: (data: string) => boolean) =>
    writes.some(test)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiting.push({ test, resolve }));
  const output = (data: string) =>
    live?.({ stream: "", sequence: 2, type: TerminalEvents.output, payload: { data }, at: "" });
  return { writes, sent, output, container };
}

describe("the terminal viewport", () => {
  it("sends keys typed while the kept output is replayed", async () => {
    // The new split's shell printed its prompt before the viewport read it:
    // the prompt is replayed, and the user is typing already.
    const view = render({ history: "$ ", onFollow: (container) => type(container, "e") });
    await view.sent((data) => data === "e");
    expect(view.writes).toEqual(["e"]);
  });

  it("answers queries in live output, never those in the replay", async () => {
    // A cursor position query (DSR 6) in the replay, then one in live output.
    let following!: () => void;
    const followed = new Promise<void>((resolve) => (following = resolve));
    const view = render({ history: "$ \u001b[6n", onFollow: () => following() });
    await followed;
    // Parsed after the replay: xterm takes writes in order.
    view.output("\u001b[6n");
    await view.sent((data) => data.endsWith("R"));
    // One answer: to the live query; the replayed one stayed unanswered.
    const ESC = String.fromCharCode(27);
    const reports = view.writes.filter(
      (data) => data.startsWith(`${ESC}[`) && /^\[\d+;\d+R$/.test(data.slice(1)),
    );
    expect(reports).toHaveLength(1);
  });
});
