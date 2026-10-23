import type { Mode, Navigation, Route } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { createModes, persistedPlaces } from "../src/lib/modes.ts";

/** Navigation over a variable, as the fragment would be. */
function fakeNavigation(start: Route = {}): Navigation {
  let route = start;
  const listeners = new Set<() => void>();
  return {
    current: () => route,
    navigate(next) {
      route = next;
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as Navigation;
}

function memoryPlaces() {
  const places = new Map<string, Route>();
  return { get: (id: string) => places.get(id), set: (id: string, r: Route) => places.set(id, r) };
}

const mode = (id: string, order: number): Mode => ({
  id,
  title: id,
  order,
  sidebarSlot: `${id}.sidebar`,
  mainSlot: `${id}.main`,
});

describe("client.modes@1 (D742, D744)", () => {
  it("orders modes, makes the first the default and follows the route's mode", () => {
    const navigation = fakeNavigation({ node: "a" });
    const modes = createModes(navigation, memoryPlaces());
    const changes: (string | undefined)[] = [];
    modes.subscribe(() => changes.push(modes.current()?.id));

    modes.register(mode("civilization", 100));
    modes.register(mode("threads", 0));
    expect(modes.list().map((item) => item.id)).toEqual(["threads", "civilization"]);
    expect(modes.current()?.id).toBe("threads");

    navigation.navigate({ node: "a", mode: "civilization" });
    expect(modes.current()?.id).toBe("civilization");
    navigation.navigate({ node: "a", mode: "gone" });
    expect(modes.current()?.id).toBe("threads");
    expect(changes.at(-1)).toBe("threads");
    expect(() => modes.register(mode("threads", 0))).toThrow(/already registered/);
  });

  it("opens a mode at its last place, writing no mode for the default", () => {
    const navigation = fakeNavigation({ node: "a", thread: "t1" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    modes.register(mode("civilization", 100));

    modes.open("civilization");
    expect(navigation.current()).toEqual({ node: "a", mode: "civilization" });
    navigation.navigate({ node: "a", mode: "civilization", panel: "missions" });

    modes.open("threads");
    expect(navigation.current()).toEqual({ node: "a", thread: "t1" });
    modes.open("civilization");
    expect(navigation.current()).toEqual({ node: "a", mode: "civilization", panel: "missions" });
    expect(() => modes.open("nope")).toThrow(/No mode/);
  });

  it("tells subscribers once per change, and keeps no place for a mode the route did not name", () => {
    const navigation = fakeNavigation({ mode: "civilization", panel: "missions" });
    const places = memoryPlaces();
    const modes = createModes(navigation, places);
    let notified = 0;
    modes.subscribe(() => notified++);

    modes.register(mode("threads", 0));
    expect(notified).toBe(1);
    const civilization = modes.register(mode("civilization", 100));
    expect(notified).toBe(2);
    civilization.dispose();
    expect(notified).toBe(3);

    // A route naming a mode that is not registered shows Threads as a fallback only.
    navigation.navigate({ mode: "gone", panel: "teams" });
    expect(modes.current()?.id).toBe("threads");
    expect(places.get("threads")).not.toEqual({ mode: "gone", panel: "teams" });
  });

  it("keeps no app page as a mode's place, so switching back leaves Settings (D748)", () => {
    const navigation = fakeNavigation({ node: "a", thread: "t1" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    modes.register(mode("civilization", 100));

    navigation.navigate({ node: "a", thread: "t1", panel: "settings" });
    modes.open("civilization");
    modes.open("threads");
    expect(navigation.current()).toEqual({ node: "a", thread: "t1" });
  });

  it("opens a mode on the current node, not on the node of its last place", () => {
    const navigation = fakeNavigation({ node: "a", thread: "t1" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    modes.register(mode("civilization", 100));

    modes.open("civilization");
    navigation.navigate({ node: "b", mode: "civilization" });
    modes.open("threads");
    expect(navigation.current()).toEqual({ node: "b" });
  });

  it("leaves an app page for the active mode's own place when its button is pressed", () => {
    const navigation = fakeNavigation({ node: "a", thread: "t1" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    modes.register(mode("civilization", 100));

    navigation.navigate({ node: "a", thread: "t1", panel: "settings" });
    modes.open("threads");
    expect(navigation.current()).toEqual({ node: "a", thread: "t1" });
    modes.open("threads");
    expect(navigation.current()).toEqual({ node: "a", thread: "t1" });
  });

  it("drops the name of a mode that is gone when the default mode is opened", () => {
    const navigation = fakeNavigation({ node: "a", mode: "civilization", thread: "t1" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    modes.open("threads");
    expect(navigation.current()).toEqual({ node: "a", thread: "t1" });
  });

  it("takes the mode out of the route when the shown mode goes, so its return does not take the page", () => {
    const navigation = fakeNavigation({ node: "a", mode: "civilization", panel: "missions" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    const civilization = modes.register(mode("civilization", 100));
    civilization.dispose();
    // Not Civilization's own `panel`: Threads mode opens at its place (here the node alone).
    expect(navigation.current()).toEqual({ node: "a" });
    modes.register(mode("civilization", 100));
    expect(modes.current()?.id).toBe("threads");
  });

  it("returns to the default mode's last place when the shown mode goes", () => {
    const navigation = fakeNavigation({ node: "a", thread: "t1" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    const civilization = modes.register(mode("civilization", 100));
    modes.open("civilization");
    navigation.navigate({ node: "a", mode: "civilization", panel: "missions" });
    civilization.dispose();
    expect(navigation.current()).toEqual({ node: "a", thread: "t1" });
  });

  it("falls back to the default mode when the active one goes away", () => {
    const navigation = fakeNavigation({ mode: "civilization" });
    const modes = createModes(navigation, memoryPlaces());
    modes.register(mode("threads", 0));
    const civilization = modes.register(mode("civilization", 100));
    expect(modes.current()?.id).toBe("civilization");
    civilization.dispose();
    expect(modes.current()?.id).toBe("threads");
    expect(modes.list()).toHaveLength(1);
  });

  it("adds up the badges of a mode, even before it is registered (D1273)", () => {
    const modes = createModes(fakeNavigation(), memoryPlaces());
    let told = 0;
    modes.subscribe(() => told++);
    const first = modes.badge("a");
    const second = modes.badge("a");
    first.set(2);
    second.set(3);
    expect(modes.badges().get("a")).toBe(5);
    const before = modes.badges();
    first.set(2);
    expect(modes.badges()).toBe(before);
    expect(told).toBe(2);
    first.dispose();
    expect(modes.badges().get("a")).toBe(3);
    second.set(0);
    expect(modes.badges().has("a")).toBe(false);
  });
});

describe("mode places survive a reload (D1389)", () => {
  /** A storage over a map; `fail` makes every call throw, as a blocked one does. */
  function memoryStorage(initial: Record<string, string> = {}, fail = false) {
    const items = new Map(Object.entries(initial));
    const check = () => {
      if (fail) throw new Error("blocked");
    };
    return {
      items,
      getItem: (key: string) => (check(), items.get(key) ?? null),
      setItem: (key: string, value: string) => (check(), void items.set(key, value)),
    };
  }

  it("keeps a place for the next page load", () => {
    const storage = memoryStorage();
    const navigation = fakeNavigation({ node: "a" });
    const modes = createModes(navigation, persistedPlaces({}, storage, "k"));
    modes.register(mode("threads", 0));
    modes.register(mode("civilization", 100));
    modes.open("civilization");
    navigation.navigate({ node: "a", mode: "civilization", panel: "missions" });

    // A fresh page: new places over the same storage, a new navigation.
    const reloaded = fakeNavigation({ node: "a" });
    const again = createModes(reloaded, persistedPlaces({}, storage, "k"));
    again.register(mode("threads", 0));
    again.register(mode("civilization", 100));
    again.open("civilization");
    expect(reloaded.current()).toEqual({ node: "a", mode: "civilization", panel: "missions" });
  });

  it("drops what is stored but not a route, and what is not JSON", () => {
    const stored = JSON.stringify({
      ok: { node: "a", panel: "missions" },
      extra: { node: "a", surprise: "x" },
      number: { node: 1 },
      list: ["a"],
      text: "a",
      nothing: null,
    });
    const places = persistedPlaces({}, memoryStorage({ k: stored }), "k");
    expect(places.get("ok")).toEqual({ node: "a", panel: "missions" });
    for (const id of ["extra", "number", "list", "text", "nothing"]) {
      expect(places.get(id)).toBeUndefined();
    }
    for (const bad of ["{not json", "[]", "7", "null"]) {
      expect(persistedPlaces({}, memoryStorage({ k: bad }), "k").get("ok")).toBeUndefined();
    }
  });

  it("never stores an app page, even if one was stored", () => {
    const storage = memoryStorage({ k: JSON.stringify({ threads: { panel: "settings" } }) });
    const places = persistedPlaces({}, storage, "k");
    expect(places.get("threads")).toBeUndefined();

    const navigation = fakeNavigation({ node: "a", thread: "t1" });
    const modes = createModes(navigation, places);
    modes.register(mode("threads", 0));
    navigation.navigate({ node: "a", panel: "settings" });
    expect(JSON.parse(storage.items.get("k") ?? "{}")).toEqual({
      threads: { node: "a", thread: "t1" },
    });
  });

  it("falls back to the page's places when there is no storage or it throws", () => {
    for (const storage of [undefined, memoryStorage({}, true)]) {
      const places = persistedPlaces({ threads: { node: "a" } }, storage, "k");
      expect(places.get("threads")).toEqual({ node: "a" });
      places.set("civilization", { mode: "civilization" });
      expect(places.get("civilization")).toEqual({ mode: "civilization" });
    }
  });
});
