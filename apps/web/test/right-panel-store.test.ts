// The right panel's state as data (t3-parity.md D1421, D1422), as T3's rightPanelStore.test.ts
// checks its own.
import type { RightPanelState } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_STATE,
  closeAll,
  closeOthers,
  closeSurface,
  closeToRight,
  move,
  readStored,
  reconcile,
  surfaceOf,
  upsert,
  writeStored,
} from "../src/plugins/right-panel/store.ts";

const ids = (state: RightPanelState) => state.surfaces.map((surface) => surface.id);

const three = (): RightPanelState =>
  [surfaceOf("diff"), surfaceOf("file", "a.ts"), surfaceOf("browser", "t1")].reduce(
    (state, surface) => upsert(state, surface),
    EMPTY_STATE,
  );

describe("the right panel's state", () => {
  it("adds a surface at the end and shows it, once", () => {
    const state = upsert(three(), surfaceOf("file", "a.ts"));
    expect(ids(state)).toEqual(["diff", "file:a.ts", "browser:t1"]);
    expect(state.activeId).toBe("file:a.ts");
    expect(state.open).toBe(true);
  });

  it("closing the active surface shows the one now in its place, else the last", () => {
    const middle = closeSurface({ ...three(), activeId: "file:a.ts" }, "file:a.ts");
    expect(ids(middle)).toEqual(["diff", "browser:t1"]);
    expect(middle.activeId).toBe("browser:t1");
    const last = closeSurface(three(), "browser:t1");
    expect(last.activeId).toBe("file:a.ts");
    const other = closeSurface(three(), "diff");
    expect(other.activeId).toBe("browser:t1");
  });

  it("closing the last surface closes the panel", () => {
    const one = upsert(EMPTY_STATE, surfaceOf("diff"));
    const closed = closeSurface(one, "diff");
    expect(closed).toMatchObject({ surfaces: [], activeId: null, open: false });
  });

  it("closes the others, those to the right and all", () => {
    expect(ids(closeOthers(three(), "file:a.ts"))).toEqual(["file:a.ts"]);
    expect(closeOthers(three(), "file:a.ts").activeId).toBe("file:a.ts");
    const right = closeToRight(three(), "diff");
    expect(ids(right)).toEqual(["diff"]);
    expect(right.activeId).toBe("diff");
    const unchanged = three();
    expect(closeToRight(unchanged, "browser:t1")).toBe(unchanged);
    expect(closeAll(three())).toMatchObject({ surfaces: [], open: false, activeId: null });
  });

  it("moves a surface to another place", () => {
    expect(ids(move(three(), "browser:t1", 0))).toEqual(["browser:t1", "diff", "file:a.ts"]);
  });

  it("reconciles a kind's surfaces with what it has, new ones at the end", () => {
    const state = reconcile(three(), "browser", ["t2", "t1"]);
    expect(ids(state)).toEqual(["diff", "file:a.ts", "browser:t1", "browser:t2"]);
    // Not activated: the panel keeps what it showed.
    expect(state.activeId).toBe("browser:t1");
    const gone = reconcile(three(), "browser", ["t2"]);
    expect(ids(gone)).toEqual(["diff", "file:a.ts", "browser:t2"]);
    // The active one went: the kind's first shows.
    expect(gone.activeId).toBe("browser:t2");
    const same = three();
    expect(reconcile(same, "browser", ["t1"])).toBe(same);
    // Open on "Open a surface": new tabs join the strip, and the chooser stays.
    const choosing = { ...EMPTY_STATE, open: true };
    expect(reconcile(choosing, "browser", ["t1"])).toMatchObject({
      activeId: null,
      open: true,
      surfaces: [{ id: "browser:t1" }],
    });
  });

  it("keeps places on the device and leaves out what is malformed", () => {
    const places = new Map([["n|t:1", { ...three(), maximized: true }]]);
    const back = readStored(writeStored(places));
    expect(back.get("n|t:1")).toEqual({ ...three(), maximized: true });
    const odd = readStored(
      JSON.stringify({
        a: { surfaces: [{ kind: "diff" }, { kind: 3 }, { kind: "diff" }], activeId: "nope" },
        b: "x",
        c: { surfaces: [] },
      }),
    );
    expect([...odd.keys()]).toEqual(["a"]);
    expect(odd.get("a")).toEqual({
      surfaces: [{ id: "diff", kind: "diff" }],
      activeId: null,
      open: false,
      maximized: false,
    });
    expect(readStored("{")).toEqual(new Map());
  });
});
