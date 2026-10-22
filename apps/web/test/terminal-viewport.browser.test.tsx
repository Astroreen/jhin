import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import { TerminalEvents, type TerminalSnapshot } from "@jhin/terminal-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { TerminalContextSelection } from "../src/plugins/terminal/context.ts";
import { TerminalViewport } from "../src/plugins/terminal/viewport.tsx";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/**
 * Live output that ends with a query only it can be answered with: a
 * cursor position report at row 5, column 7. Every reply to what came
 * before (the replay, then this output) and every key sent meanwhile is
 * written by the time its reply is.
 */
const SENTINEL = `${ESC}[5;7H${ESC}[6n`;
const SENTINEL_REPLY = `${ESC}[5;7R`;
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
function render(options: {
  history: string;
  onFollow?: (container: HTMLElement) => void;
  onAddToChat?: (selection: TerminalContextSelection) => void;
}) {
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
        onAddToChat={options.onAddToChat}
        fontFamily=""
        fontSize={12}
        onSessionExited={() => undefined}
        resizeEpoch={0}
        terminalId="term-1"
        terminalLabel="Terminal 1"
        threadId="t"
        visible
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
    view.output(SENTINEL);
    await view.sent((data) => data === SENTINEL_REPLY);
    // Once, and before what the next live output made xterm answer.
    expect(view.writes).toEqual(["e", SENTINEL_REPLY]);
  });

  /** A node whose kept output is `history`; once followed, `live` is sent as live output. */
  async function replayThenLive(history: string, live: string) {
    let following!: () => void;
    const followed = new Promise<void>((resolve) => (following = resolve));
    const view = render({ history, onFollow: () => following() });
    await followed;
    // Parsed after the replay: xterm takes writes in order.
    view.output(`${live}${SENTINEL}`);
    await view.sent((data) => data === SENTINEL_REPLY);
    return view.writes;
  }

  it("answers queries in live output, never those in the replay", async () => {
    // A cursor position query (DSR 6) in the replay; the cursor is at row 1, column 3 then.
    expect(await replayThenLive(`$ ${ESC}[6n`, "")).toEqual([SENTINEL_REPLY]);
    // The same query live is answered.
    expect(await replayThenLive("$ ", `${ESC}[6n`)).toEqual([`${ESC}[1;3R`, SENTINEL_REPLY]);
  });

  it("keeps the colours a replayed sequence sets beside a query", async () => {
    // Sets colour 1 and asks for colour 2 in one sequence: only the question goes.
    expect(await replayThenLive(`${ESC}]4;1;rgb:12/34/56;2;?${BEL}`, "")).toEqual([SENTINEL_REPLY]);
    // Colour 1 is set: a live query of it says so.
    expect(await replayThenLive(`${ESC}]4;1;rgb:12/34/56;2;?${BEL}`, `${ESC}]4;1;?${BEL}`)).toEqual(
      [`${ESC}]4;1;rgb:1212/3434/5656${ESC}\\`, SENTINEL_REPLY],
    );
    // Dynamic colours the same way: the foreground set, the background asked.
    expect(await replayThenLive(`${ESC}]10;rgb:ab/cd/ef;?${BEL}`, `${ESC}]10;?${BEL}`)).toEqual([
      `${ESC}]10;rgb:abab/cdcd/efef${ESC}\\`,
      SENTINEL_REPLY,
    ]);
  });

  // Every query this xterm answers, from replay.ts's list. DA3, XTWINOPS
  // reports (off by default) and XTVERSION are muted too, but this xterm does
  // not answer them, so there is nothing to see here.
  const ANSWERED = {
    "DSR 5 (status)": `${ESC}[5n`,
    "DSR 6 (cursor position)": `${ESC}[6n`,
    "DEC DSR 6": `${ESC}[?6n`,
    DA1: `${ESC}[c`,
    DA2: `${ESC}[>c`,
    DECRQM: `${ESC}[4$p`,
    "DECRQM (DEC mode)": `${ESC}[?25$p`,
    DECRQSS: `${ESC}P$qm${ESC}\\`,
    "OSC 4 (palette colour)": `${ESC}]4;1;?\u0007`,
    "OSC 10 (foreground)": `${ESC}]10;?\u0007`,
    "OSC 11 (background)": `${ESC}]11;?\u0007`,
  };

  it.each(Object.entries(ANSWERED))("does not answer %s in the replay", async (_name, query) => {
    // Answered live: it is a query this xterm replies to.
    expect(await replayThenLive("", query)).toHaveLength(2);
    // Not answered when replayed.
    expect(await replayThenLive(query, "")).toEqual([SENTINEL_REPLY]);
  });

  /** Resolves with the menu item named `name` once the menu shows it. */
  function menuItem(name: string): Promise<HTMLElement> {
    const find = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === name,
      );
    const found = find();
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const item = find();
        if (item === undefined) return;
        observer.disconnect();
        resolve(item);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  it("adds what is selected to the chat from its context menu (D473)", async () => {
    const added: TerminalContextSelection[] = [];
    let following!: () => void;
    const followed = new Promise<void>((resolve) => (following = resolve));
    const view = render({
      history: "line one\r\nline two\r\n$ ",
      onFollow: () => following(),
      onAddToChat: (selection) => added.push(selection),
    });
    await followed;
    // Parsed once xterm answers the query after it.
    view.output(SENTINEL);
    await view.sent((data) => data === SENTINEL_REPLY);
    const viewport = view.container.querySelector<HTMLElement>("[data-terminal-viewport]")!;
    const rightClick = () =>
      act(() => {
        viewport.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 20,
          }),
        );
      });

    rightClick();
    // Nothing selected: Add to chat and Copy wait for a selection.
    expect((await menuItem("Add to chat")).getAttribute("aria-disabled")).toBe("true");
    for (const name of ["Copy", "Paste", "Select all", "Jump to latest"]) await menuItem(name);
    act(() => clickMenuItem("Select all"));
    rightClick();
    const add = await menuItem("Add to chat");
    expect(add.getAttribute("aria-disabled")).not.toBe("true");
    act(() => add.click());
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      terminalId: "term-1",
      terminalLabel: "Terminal 1",
      lineStart: 1,
    });
    expect(added[0]!.text).toContain("line one");
    expect(added[0]!.text).toContain("line two");
  });
});

function clickMenuItem(name: string): void {
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent === name)!
    .click();
}
