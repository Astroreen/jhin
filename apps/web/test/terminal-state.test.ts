import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_THREAD_TERMINAL_UI_STATE,
  MAX_TERMINALS_PER_GROUP,
  closeThreadTerminal,
  createTerminalUiStore,
  newThreadTerminal,
  nextTerminalId,
  revealThreadTerminal,
  setThreadActiveTerminal,
  setThreadTerminalOpen,
  splitThreadTerminal,
  terminalLabel,
  terminalSessionLabel,
  type ThreadTerminalUiState,
} from "../src/lib/terminal-state.ts";

const open = () => setThreadTerminalOpen(DEFAULT_THREAD_TERMINAL_UI_STATE, true);

describe("terminal drawer state (T3's terminalUiStateStore)", () => {
  it("opens with a first terminal and hides without forgetting it", () => {
    const opened = open();
    expect(opened).toMatchObject({
      terminalOpen: true,
      terminalIds: ["term-1"],
      activeTerminalId: "term-1",
      terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
    });
    const hidden = setThreadTerminalOpen(opened, false);
    expect(hidden).toMatchObject({ terminalOpen: false, terminalIds: ["term-1"] });
  });

  it("splits next to the active terminal, side by side or stacked, at most four per group", () => {
    let state: ThreadTerminalUiState = open();
    state = splitThreadTerminal(state, "term-2");
    state = setThreadActiveTerminal(state, "term-1");
    state = splitThreadTerminal(state, "term-3", "vertical");
    expect(state.terminalGroups).toEqual([
      {
        id: "group-term-1",
        terminalIds: ["term-1", "term-3", "term-2"],
        splitDirection: "vertical",
      },
    ]);
    expect(state.activeTerminalId).toBe("term-3");

    state = splitThreadTerminal(state, "term-4");
    expect(state.terminalGroups[0]?.terminalIds).toHaveLength(MAX_TERMINALS_PER_GROUP);
    const full = splitThreadTerminal(state, "term-5");
    expect(full).toBe(state);
  });

  it("puts a new terminal in a group of its own", () => {
    const state = newThreadTerminal(splitThreadTerminal(open(), "term-2"), "term-3");
    expect(state.terminalGroups.map((group) => group.terminalIds)).toEqual([
      ["term-1", "term-2"],
      ["term-3"],
    ]);
    expect(state.activeTerminalGroupId).toBe("group-term-3");
  });

  it("closes a terminal, activating its neighbour; the last one resets the thread", () => {
    let state = newThreadTerminal(newThreadTerminal(open(), "term-2"), "term-3");
    state = setThreadActiveTerminal(state, "term-2");
    state = closeThreadTerminal(state, "term-2");
    expect(state).toMatchObject({ terminalIds: ["term-1", "term-3"], activeTerminalId: "term-3" });
    state = closeThreadTerminal(closeThreadTerminal(state, "term-3"), "term-1");
    expect(state).toBe(DEFAULT_THREAD_TERMINAL_UI_STATE);
  });

  it("reveals a terminal the node runs, as a card's indicator does", () => {
    const hidden = setThreadTerminalOpen(open(), false);
    expect(revealThreadTerminal(hidden, "term-1")).toMatchObject({
      terminalOpen: true,
      activeTerminalId: "term-1",
    });
    // One this device never showed (opened on another client): added as its own group.
    expect(revealThreadTerminal(hidden, "term-7")).toMatchObject({
      terminalOpen: true,
      terminalIds: ["term-1", "term-7"],
      activeTerminalId: "term-7",
    });
  });

  it("names tabs as T3 does and picks the lowest free number", () => {
    expect(terminalLabel("term-2")).toBe("Terminal 2");
    expect(terminalLabel("logs")).toBe("logs");
    expect(terminalSessionLabel("term-1", { label: "vim" })).toBe("vim");
    expect(terminalSessionLabel("term-1", { label: "" })).toBe("Terminal 1");
    expect(nextTerminalId(["term-1", "term-3"])).toBe("term-2");
  });
});

describe("the drawer state on this device", () => {
  const memoryStorage = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
  };

  it("keeps each thread's layout and forgets one back at the default", () => {
    const storage = memoryStorage();
    const store = createTerminalUiStore(storage);
    store.update("node|t1", (state) => setThreadTerminalOpen(state, true));
    expect(createTerminalUiStore(storage).get("node|t1").terminalIds).toEqual(["term-1"]);
    store.update("node|t1", (state) => closeThreadTerminal(state, "term-1"));
    expect(JSON.parse(storage.items.get("jhin.terminal.ui")!)).toEqual({});
  });

  it("drops stored values of the wrong shape", () => {
    const storage = memoryStorage();
    storage.setItem(
      "jhin.terminal.ui",
      JSON.stringify({
        bad: { terminalIds: "term-1" },
        good: { terminalOpen: true, terminalIds: ["term-1"], terminalGroups: [{ id: 3 }] },
      }),
    );
    const store = createTerminalUiStore(storage);
    expect(store.get("bad")).toBe(DEFAULT_THREAD_TERMINAL_UI_STATE);
    expect(store.get("good")).toMatchObject({
      terminalOpen: true,
      terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
    });
  });
});
