// `jhin.right-panel` with a fake route (t3-parity.md D1421–D1423): the route and the panel's tabs
// follow each other, a place's panel comes back with it, closing asks the kind first.
import {
  NAVIGATION_CAPABILITY,
  RIGHT_PANEL_CAPABILITY,
  type Navigation,
  type NavigateOptions,
  type RightPanel,
  type RightPanelSurface,
  type RightPanelSurfaceKind,
  type Route,
} from "@jhin/client-api";
import { definePlugin, toDisposable } from "@jhin/sdk";
import { createTestKernel, mockCapability, testManifest } from "@jhin/testing";
import { UI_SLOTS_CAPABILITY, createSlotRegistry } from "@jhin/ui";
import { describe, expect, it } from "vite-plus/test";

import { rightPanelPlugin } from "../src/plugins/right-panel/index.tsx";

function fakeNavigation(first: Route) {
  let route = first;
  const listeners = new Set<() => void>();
  /** Every navigation, with whether it replaced the entry. */
  const history: { route: Route; replace: boolean }[] = [];
  const navigation: Navigation = {
    current: () => route,
    navigate(next: Route, options?: NavigateOptions) {
      route = next;
      history.push({ route: next, replace: options?.replace === true });
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
  return { navigation, history };
}

const kind = (id: string, extra: Partial<RightPanelSurfaceKind> = {}): RightPanelSurfaceKind => ({
  id,
  title: id,
  icon: () => null,
  component: () => null,
  ...extra,
});

async function start(route: Route, kinds: readonly RightPanelSurfaceKind[]) {
  const { navigation, history } = fakeNavigation(route);
  let panel: RightPanel | undefined;
  const kernel = await createTestKernel({
    side: "client",
    plugins: [
      mockCapability(NAVIGATION_CAPABILITY, navigation, "1.1.0"),
      mockCapability(UI_SLOTS_CAPABILITY, createSlotRegistry()),
      rightPanelPlugin,
      {
        manifest: testManifest("app.surfaces", {
          side: "client",
          requires: { [RIGHT_PANEL_CAPABILITY]: "^1" },
        }),
        definition: definePlugin({
          activate(context) {
            panel = context.services.get<RightPanel>(RIGHT_PANEL_CAPABILITY);
            for (const entry of kinds) context.subscriptions.add(panel.register(entry));
          },
        }),
      },
    ],
  });
  return { kernel, panel: panel!, navigation, history };
}

const thread = { node: "n", thread: "t1" } as const;
const place = { target: { node: "n" }, threadId: "t1" };
const ids = (surfaces: readonly RightPanelSurface[]) => surfaces.map((surface) => surface.id);

describe("jhin.right-panel", () => {
  it("adds the surface a route names and shows it (D1421)", async () => {
    const { kernel, panel, navigation } = await start({ ...thread, panel: "diff" }, [
      kind("diff"),
      kind("file"),
    ]);
    expect(panel.state(place)).toMatchObject({ activeId: "diff", open: true });
    navigation.navigate({ ...thread, panel: "file", section: "src/a.ts" });
    navigation.navigate({ ...thread, panel: "file", section: "src/b.ts" });
    expect(ids(panel.state(place).surfaces)).toEqual(["diff", "file:src/a.ts", "file:src/b.ts"]);
    expect(panel.state(place).activeId).toBe("file:src/b.ts");
    // Another view of the same place leaves the tabs as they are; no panel closes it.
    navigation.navigate(thread);
    expect(panel.state(place)).toMatchObject({ open: false, activeId: "file:src/b.ts" });
    await kernel.stop();
  });

  it("toggles the panel on its active surface, and opens on none with no surfaces (D1423)", async () => {
    const { kernel, panel, navigation } = await start(thread, [kind("diff")]);
    await kernel.commands.execute("right-panel.toggle", {});
    expect(navigation.current()).toEqual({ ...thread, panel: "right-panel" });
    navigation.navigate({ ...thread, panel: "diff" });
    await kernel.commands.execute("right-panel.toggle", {});
    expect(navigation.current()).toEqual(thread);
    await kernel.commands.execute("right-panel.toggle", {});
    expect(navigation.current()).toEqual({ ...thread, panel: "diff" });
    expect(panel.state(place).open).toBe(true);
    await kernel.stop();
  });

  it("shows a place's panel again when the place comes back, in place of the entry (D1421)", async () => {
    const { kernel, navigation, history } = await start({ ...thread, panel: "diff" }, [
      kind("diff"),
    ]);
    navigation.navigate({ node: "n", thread: "t2" });
    navigation.navigate(thread);
    expect(navigation.current()).toEqual({ ...thread, panel: "diff" });
    expect(history.at(-1)).toEqual({ route: { ...thread, panel: "diff" }, replace: true });
    await kernel.stop();
  });

  it("closing the active surface shows its neighbour, the last closes the panel (D1422)", async () => {
    const { kernel, panel, navigation } = await start({ ...thread, panel: "diff" }, [
      kind("diff"),
      kind("file"),
    ]);
    navigation.navigate({ ...thread, panel: "file", section: "a.ts" });
    expect(await panel.close(place, "file:a.ts")).toBe(true);
    expect(navigation.current()).toEqual({ ...thread, panel: "diff" });
    await kernel.commands.execute("right-panel.close", {});
    expect(navigation.current()).toEqual(thread);
    expect(panel.state(place)).toMatchObject({ surfaces: [], open: false });
    await kernel.stop();
  });

  it("keeps a surface its kind does not release", async () => {
    let answer = false;
    const asked: string[][] = [];
    const { kernel, panel } = await start({ ...thread, panel: "browser", section: "t" }, [
      kind("browser", {
        release: (_place, surfaces) => {
          asked.push(ids(surfaces));
          return Promise.resolve(answer);
        },
      }),
    ]);
    expect(await panel.close(place, "browser:t")).toBe(false);
    expect(ids(panel.state(place).surfaces)).toEqual(["browser:t"]);
    answer = true;
    const closed = await kernel.commands.execute("right-panel.surfaces.close-all", {});
    expect(closed).toEqual({ changed: true });
    expect(asked).toEqual([["browser:t"], ["browser:t"]]);
    expect(panel.state(place).surfaces).toEqual([]);
    await kernel.stop();
  });

  it("closes only what its kind released, not a surface added while it asked", async () => {
    let answer!: (released: boolean) => void;
    let asked!: () => void;
    const askedOnce = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { kernel, panel } = await start({ ...thread, panel: "browser", section: "a" }, [
      kind("browser", {
        release: () => {
          asked();
          return new Promise<boolean>((resolve) => {
            answer = resolve;
          });
        },
      }),
    ]);
    panel.reconcile(place, "browser", ["a", "b"]);
    const closing = kernel.commands.execute("right-panel.surfaces.close-all", {});
    await askedOnce;
    // An agent opens another tab while the user is asked.
    panel.reconcile(place, "browser", ["a", "b", "c"]);
    answer(true);
    expect(await closing).toEqual({ changed: true });
    expect(ids(panel.state(place).surfaces)).toEqual(["browser:c"]);
    await kernel.stop();
  });

  it("closes the panel with its last surface, also when the kind removed it while releasing", async () => {
    let reconcileNow!: () => void;
    const { kernel, panel, navigation } = await start(
      { ...thread, panel: "browser", section: "a" },
      [
        kind("browser", {
          // The node's tab goes, and its feed takes the surface away, before the close answers.
          release: () => {
            reconcileNow();
            return Promise.resolve(true);
          },
        }),
      ],
    );
    reconcileNow = () => panel.reconcile(place, "browser", []);
    expect(await panel.close(place, "browser:a")).toBe(true);
    expect(panel.state(place)).toMatchObject({ surfaces: [], open: false });
    expect(navigation.current()).toEqual(thread);
    await kernel.stop();
  });

  it("reconciles a kind's surfaces and the route follows the one on screen", async () => {
    const { kernel, panel, navigation } = await start(
      { ...thread, panel: "browser", section: "a" },
      [kind("browser")],
    );
    panel.reconcile(place, "browser", ["a", "b"]);
    expect(ids(panel.state(place).surfaces)).toEqual(["browser:a", "browser:b"]);
    expect(navigation.current().section).toBe("a");
    panel.reconcile(place, "browser", ["b"]);
    expect(navigation.current()).toEqual({ ...thread, panel: "browser", section: "b" });
    await kernel.stop();
  });

  it("opens by itself only while the user has not changed the panel since (T3's openProactive)", async () => {
    const { kernel, panel, navigation } = await start(thread, [kind("diff"), kind("file")]);
    const revision = panel.revision(place);
    expect(panel.openProactive(place, { kind: "diff" }, revision)).toBe(true);
    expect(navigation.current()).toEqual({ ...thread, panel: "diff" });
    // Not the user's doing: the revision stays.
    expect(panel.revision(place)).toBe(revision);
    navigation.navigate({ ...thread, panel: "file", section: "a.ts" });
    expect(panel.openProactive(place, { kind: "diff" }, revision)).toBe(false);
    await kernel.stop();
  });

  it("lists, moves and activates surfaces as commands", async () => {
    const { kernel, navigation } = await start({ ...thread, panel: "diff" }, [
      kind("diff"),
      kind("file"),
    ]);
    navigation.navigate({ ...thread, panel: "file", section: "a.ts" });
    await kernel.commands.execute("right-panel.surface.move", { id: "file:a.ts", index: 0 });
    await kernel.commands.execute("right-panel.surface.activate", { id: "diff" });
    expect(await kernel.commands.execute("right-panel.surfaces.list", {})).toEqual({
      open: true,
      maximized: false,
      activeId: "diff",
      surfaces: [
        { id: "file:a.ts", kind: "file", resource: "a.ts" },
        { id: "diff", kind: "diff" },
      ],
    });
    expect(await kernel.commands.execute("right-panel.surface.open", { kind: "nope" })).toEqual({
      opened: false,
    });
    // Activating the surface already shown changes nothing; a far index moves to the end.
    expect(await kernel.commands.execute("right-panel.surface.activate", { id: "diff" })).toEqual({
      changed: false,
    });
    await kernel.commands.execute("right-panel.surface.move", { id: "file:a.ts", index: 9 });
    expect(
      (
        (await kernel.commands.execute("right-panel.surfaces.list", {})) as {
          surfaces: { id: string }[];
        }
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["diff", "file:a.ts"]);
    expect(await kernel.commands.execute("right-panel.maximize.toggle", {})).toEqual({
      maximized: true,
    });
    expect(await kernel.commands.execute("right-panel.maximize.toggle", {})).toEqual({
      maximized: false,
    });
    await kernel.stop();
  });
});
