import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
  type NodeConnection,
  type Route,
  THREADS_CAPABILITY,
  type ChatDrawerProps,
  type ThreadsCatalog,
  type ThreadIndicatorProps,
} from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import {
  TERMINALS_STREAM,
  TerminalEvents,
  terminalStream,
  type TerminalSummary,
} from "@jhin/terminal-api";
import { createTestKernel, mockCapability, type TestKernel, type TestPlugin } from "@jhin/testing";
import { Slot, SlotsProvider, UI_SLOTS_CAPABILITY, createSlotRegistry } from "@jhin/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { currentPlatform, isMacPlatform } from "../src/lib/keybindings.ts";
import { keybindingsPlugin } from "../src/plugins/keybindings.ts";
import { sourceControlPlugin } from "../src/plugins/source-control/index.tsx";
import { terminalPlugin } from "../src/plugins/terminal/index.tsx";

const A = "ws://a/rpc";
const summary = (extra: Partial<TerminalSummary>): TerminalSummary => ({
  threadId: "t1",
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
  startedAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  instance: "run-1",
  ...extra,
});

let kernel: TestKernel | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await kernel?.stop();
  kernel = undefined;
  localStorage.clear();
});

/** A node whose `terminals` stream says `terminals`; the route is thread t1 on it. */
async function start(
  terminals: TerminalSummary[],
  options: { endsWith?: string; plugins?: readonly TestPlugin[] } = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    state: "open",
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      // A running session with nothing printed yet.
      if (method === "terminals.get") return { ...summary({}), history: "", sequence: 1 };
      return {};
    },
    subscribe(stream: string, _options: unknown, onEvent: (event: unknown) => void) {
      if (stream === terminalStream("t1", "term-1") && options.endsWith !== undefined) {
        onEvent({ stream, sequence: 2, type: options.endsWith, payload: {}, at: "" });
      }
      if (stream === TERMINALS_STREAM) {
        onEvent({
          stream,
          sequence: 1,
          type: TerminalEvents.sessions,
          payload: { terminals },
          at: "",
        });
      }
      return { lastSequence: 1, dispose() {} };
    },
    onState: () => toDisposable(() => undefined),
  };
  const node = { id: A, url: A, label: "a", state: "open", client } as unknown as NodeConnection;
  const connections: Connections = {
    list: () => [node],
    get: (id) => (id === A ? node : undefined),
    add: () => node,
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  let route: Route = { node: A, thread: "t1" };
  const visited: Route[] = [];
  const navigated = new Set<() => void>();
  const navigation: Navigation = {
    current: () => route,
    navigate(next) {
      route = next;
      visited.push(next);
      for (const listener of Array.from(navigated)) listener();
    },
    subscribe: () => toDisposable(() => undefined),
  };
  const slots = createSlotRegistry();
  kernel = await createTestKernel({
    side: "client",
    plugins: [
      mockCapability(UI_SLOTS_CAPABILITY, slots),
      mockCapability(CONNECTIONS_CAPABILITY, connections),
      mockCapability(NAVIGATION_CAPABILITY, navigation),
      keybindingsPlugin,
      terminalPlugin,
      ...(options.plugins ?? []),
    ],
  });
  const stored = () =>
    JSON.parse(localStorage.getItem("jhin.terminal.ui") ?? "{}") as Record<
      string,
      { terminalOpen: boolean; terminalIds: string[]; activeTerminalId: string }
    >;
  /** Resolves on the next navigation. */
  const nextNavigation = () =>
    new Promise<void>((resolve) => {
      const listener = () => {
        navigated.delete(listener);
        resolve();
      };
      navigated.add(listener);
    });
  return { slots, visited, calls, stored, client, nextNavigation };
}

function renderIndicator(slots: ReturnType<typeof createSlotRegistry>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props: ThreadIndicatorProps = {
    target: { node: A },
    thread: { id: "t1", projectId: "p", title: "t1", createdAt: "2026-10-19T10:00:00.000Z" },
    active: false,
  };
  act(() =>
    root.render(
      <SlotsProvider registry={slots}>
        <Slot name="sidebar.thread.indicators" props={props} />
      </SlotsProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

describe("the card's terminal indicator (sidebar.thread.indicators)", () => {
  it("shows while a program runs in a thread's terminal and opens that terminal", async () => {
    const { slots, visited, stored } = await start([
      summary({ terminalId: "term-2", hasRunningSubprocess: true, label: "sleep" }),
      summary({ threadId: "other", hasRunningSubprocess: true }),
    ]);
    const container = renderIndicator(slots);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("1 terminal process running. Open terminal");
    expect(button.className).toContain("text-teal-600");

    act(() => button.click());
    expect(visited).toEqual([{ node: A, thread: "t1" }]);
    expect(stored()[`${A}|t1`]).toMatchObject({
      terminalOpen: true,
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("is not there while the terminals only wait at a prompt", async () => {
    const { slots } = await start([summary({})]);
    expect(renderIndicator(slots).querySelector("button")).toBeNull();
  });
});

/** Resolves when the drawer layout is next written to this device's storage. */
function nextWrite(): Promise<void> {
  const original = Storage.prototype.setItem;
  return new Promise((resolve) => {
    Storage.prototype.setItem = function (key: string, value: string) {
      original.call(this, key, value);
      if (key !== "jhin.terminal.ui") return;
      Storage.prototype.setItem = original;
      resolve();
    };
  });
}

describe("terminal commands and the terminalFocus key (D61)", () => {
  it("toggles the open thread's drawer and splits with mod+d only while a terminal has focus", async () => {
    const { stored } = await start([]);
    await kernel!.commands.execute("terminal.toggle", {});
    expect(stored()[`${A}|t1`]).toMatchObject({ terminalOpen: true, terminalIds: ["term-1"] });

    const mac = isMacPlatform(currentPlatform());
    const press = (target: HTMLElement) => {
      const event = new KeyboardEvent("keydown", {
        key: "d",
        // `mod`: ⌘ on macOS, Ctrl elsewhere.
        ctrlKey: !mac,
        metaKey: mac,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const outside = document.createElement("textarea");
    const drawer = document.createElement("aside");
    drawer.dataset["terminalOwner"] = "drawer";
    const input = document.createElement("textarea");
    drawer.append(input);
    document.body.append(outside, drawer);
    cleanups.push(() => {
      outside.remove();
      drawer.remove();
    });

    // Outside a terminal, mod+d is not the terminal's.
    outside.focus();
    expect(press(outside)).toBe(false);

    input.focus();
    const written = nextWrite();
    expect(press(input)).toBe(true);
    await written;
    expect(stored()[`${A}|t1`]?.terminalIds).toEqual(["term-1", "term-2"]);

    // Hidden again; its terminals keep running on the node.
    await kernel!.commands.execute("terminal.toggle", {});
    expect(stored()[`${A}|t1`]).toMatchObject({ terminalOpen: false });
  });
});

describe("a terminal that ends under the drawer", () => {
  async function drawerEndingWith(type: string) {
    const { slots, calls, stored } = await start([], { endsWith: type });
    await kernel!.commands.execute("terminal.toggle", {});
    const container = document.createElement("div");
    container.style.height = "600px";
    document.body.append(container);
    const root = createRoot(container);
    const props: ChatDrawerProps = {
      target: { node: A },
      thread: { id: "t1", projectId: "p", title: "t1", createdAt: "2026-10-19T10:00:00.000Z" },
      project: { id: "p", name: "p", path: "/work", scratch: false, createdAt: "" },
    };
    // The tab goes once the drawer hears the end: its layout is written then.
    const written = nextWrite();
    act(() =>
      root.render(
        <SlotsProvider registry={slots}>
          <Slot name="chat.drawer" props={props} />
        </SlotsProvider>,
      ),
    );
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    await written;
    expect(stored()[`${A}|t1`]).toBeUndefined();
    return calls.map((call) => call.method);
  }

  it("closes an exited terminal on its node", async () => {
    expect(await drawerEndingWith(TerminalEvents.exited)).toContain("terminals.close");
  });

  it("only drops the tab of a terminal closed elsewhere, never closing its id again", async () => {
    // Another client closed it, and may have opened a new term-1 since.
    expect(await drawerEndingWith(TerminalEvents.closed)).not.toContain("terminals.close");
  });
});

describe("mod+d with source control (D147)", () => {
  it("toggles the diff outside a terminal and splits inside one", async () => {
    const threads = {
      catalog: () => ({ status: "loading", projects: [], threads: [] }),
      subscribe: () => toDisposable(() => undefined),
      call: async () => ({}),
      open: async () => "",
    } as unknown as ThreadsCatalog;
    const { stored, visited, nextNavigation } = await start([], {
      plugins: [mockCapability(THREADS_CAPABILITY, threads), sourceControlPlugin],
    });
    await kernel!.commands.execute("terminal.toggle", {});
    const mac = isMacPlatform(currentPlatform());
    const press = (target: HTMLElement) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          ctrlKey: !mac,
          metaKey: mac,
          bubbles: true,
          cancelable: true,
        }),
      );
    const outside = document.createElement("textarea");
    const drawer = document.createElement("aside");
    drawer.dataset["terminalOwner"] = "drawer";
    const input = document.createElement("textarea");
    drawer.append(input);
    document.body.append(outside, drawer);
    cleanups.push(() => {
      outside.remove();
      drawer.remove();
    });

    outside.focus();
    const diff = nextNavigation();
    press(outside);
    await diff;
    expect(visited.at(-1)).toMatchObject({ node: A, thread: "t1", panel: "diff" });
    expect(stored()[`${A}|t1`]?.terminalIds).toEqual(["term-1"]);

    input.focus();
    const split = nextWrite();
    press(input);
    await split;
    expect(stored()[`${A}|t1`]?.terminalIds).toEqual(["term-1", "term-2"]);
    expect(visited).toHaveLength(1);
  });
});
