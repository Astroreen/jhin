import type { Mode, Navigation, Route } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { createModes } from "../src/lib/modes.ts";

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
});
