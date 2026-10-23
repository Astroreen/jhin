import {
  CONNECTIONS_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Mode,
  type Modes,
  type Navigation,
  type NodeConnection,
  type Route,
} from "@jhin/client-api";
import { definePlugin, toDisposable } from "@jhin/sdk";
import { createTestKernel, mockCapability, testManifest } from "@jhin/testing";
import { UI_SLOTS_CAPABILITY, createSlotRegistry } from "@jhin/ui";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { civilizationPlugin } from "../src/plugins/civilization.tsx";
import { modesPlugin } from "../src/plugins/modes.ts";

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

/** One node whose `agents.catalog` calls wait until the test answers them. */
function fakeConnections() {
  const pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  const listeners = new Set<() => void>();
  let state: NodeConnection["state"] = "open";
  /** The streams followed on this node; `disposed` once the follower let go. */
  const streams: { stream: string; after: number | undefined; send(): void; disposed: boolean }[] =
    [];
  const connection = {
    id: "a",
    url: "ws://a",
    label: "a",
    get state() {
      return state;
    },
    client: {
      subscribe: (
        stream: string,
        options: { after?: number },
        onEvent: (event: unknown) => void,
      ) => {
        const followed = {
          stream,
          after: options.after,
          // A client delivers nothing to a subscription that was disposed.
          send: () => {
            if (!followed.disposed) onEvent({});
          },
          disposed: false,
        };
        streams.push(followed);
        return {
          dispose: () => {
            followed.disposed = true;
          },
        };
      },
      call: (method: string) => {
        if (method !== "agents.catalog") return Promise.reject(new Error(`unexpected ${method}`));
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
  } as unknown as NodeConnection;
  const connections = {
    list: () => [connection],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as Connections;
  return {
    connections,
    /** The `agents.catalog` calls asked so far, oldest first. */
    pending,
    /** The streams followed so far, oldest first. */
    streams,
    setState(next: NodeConnection["state"]) {
      state = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** Lets every queued promise reaction run: an answer's handling is then done. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function start(options: { connections?: Connections; enabled?: string } = {}) {
  let modes: Modes | undefined;
  const navigation = fakeNavigation({ node: "a" });
  const kernel = await createTestKernel({
    side: "client",
    ...(options.enabled === undefined
      ? {}
      : { config: { node: { "jhin.civilization": { enabled: options.enabled } } } }),
    plugins: [
      mockCapability(NAVIGATION_CAPABILITY, navigation),
      mockCapability(UI_SLOTS_CAPABILITY, createSlotRegistry()),
      mockCapability(CONNECTIONS_CAPABILITY, options.connections ?? fakeConnections().connections),
      modesPlugin,
      civilizationPlugin,
      {
        manifest: testManifest("app.consumer", {
          side: "client",
          requires: { [MODES_CAPABILITY]: "^1" },
        }),
        definition: definePlugin({
          activate(context) {
            modes = context.services.get(MODES_CAPABILITY);
          },
        }),
      },
    ],
  });
  const ids = () => modes!.list().map((mode) => mode.id);
  return { kernel, modes: modes!, ids, navigation };
}

describe("jhin.modes", () => {
  it("offers ui.mode.next only while there are two modes or more (D746)", async () => {
    const { kernel, modes } = await start({ enabled: "off" });
    const names = () => kernel.commands.list().map((command) => command.name);
    expect(names()).toContain("ui.mode.switch");
    expect(names()).not.toContain("ui.mode.next");

    const other: Mode = {
      id: "other",
      title: "Other",
      order: 50,
      sidebarSlot: "o.s",
      mainSlot: "o.m",
    };
    const registration = modes.register(other);
    expect(names()).toContain("ui.mode.next");
    await kernel.commands.execute("ui.mode.next", {});
    expect(modes.current()?.id).toBe("other");

    registration.dispose();
    expect(names()).not.toContain("ui.mode.next");
    expect(modes.current()?.id).toBe("threads");
    await kernel.stop();
  });
});

describe("jhin.modes places (D1389)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the places the browser kept, and writes a change back", async () => {
    const items = new Map([
      ["jhin.modes.places", JSON.stringify({ other: { node: "a", panel: "x" } })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    });
    const { kernel, modes, navigation } = await start({ enabled: "off" });
    modes.register({ id: "other", title: "Other", order: 50, sidebarSlot: "o.s", mainSlot: "o.m" });
    modes.open("other");
    expect(navigation.current()).toEqual({ node: "a", panel: "x", mode: "other" });
    navigation.navigate({ node: "a", mode: "other", panel: "y" });
    expect(JSON.parse(items.get("jhin.modes.places")!).other).toEqual({
      node: "a",
      mode: "other",
      panel: "y",
    });
    await kernel.stop();
  });

  it("works where the browser's storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const { kernel, modes, navigation } = await start({ enabled: "off" });
    modes.register({ id: "other", title: "Other", order: 50, sidebarSlot: "o.s", mainSlot: "o.m" });
    navigation.navigate({ node: "a", mode: "other", panel: "y" });
    modes.open("threads");
    modes.open("other");
    expect(navigation.current()).toEqual({ node: "a", mode: "other", panel: "y" });
    await kernel.stop();
  });
});

describe("jhin.civilization (D747)", () => {
  it("follows the config: off never offers the mode, on always does", async () => {
    const { kernel, ids } = await start({ enabled: "off" });
    expect(ids()).toEqual(["threads"]);
    kernel.config.setLayer("node", { "jhin.civilization": { enabled: "on" } });
    expect(ids()).toEqual(["threads", "civilization"]);
    kernel.config.setLayer("node", { "jhin.civilization": { enabled: "off" } });
    expect(ids()).toEqual(["threads"]);
    await kernel.stop();
  });

  it("offers the mode while an open node has an agent, and asks again after it reopens or fails", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    expect(node.pending).toHaveLength(1);
    node.pending[0]!.resolve({ head: 1, agents: [{ id: "lead" }] });
    await drain();
    expect(ids()).toEqual(["threads", "civilization"]);

    // Closed: no longer offered, and the old answer is not kept for the next opening.
    node.setState("closed");
    expect(ids()).toEqual(["threads"]);
    node.setState("open");
    expect(ids()).toEqual(["threads"]);
    expect(node.pending).toHaveLength(2);

    // A failure that is not a missing plugin is asked again on the next change, not at once.
    node.pending[1]!.reject(Object.assign(new Error("slow"), { code: "TIMEOUT" }));
    await drain();
    expect(node.pending).toHaveLength(2);
    node.setState("open");
    expect(node.pending).toHaveLength(3);
    node.pending[2]!.resolve({ head: 0, agents: [] });
    await drain();
    expect(ids()).toEqual(["threads"]);
    await kernel.stop();
  });

  it("asks again when an agents event arrives on a node that had none (D1398)", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    // The agents plugin is not active yet: no such command, taken as none for now.
    node.pending[0]!.reject(Object.assign(new Error("none"), { code: "COMMAND_NOT_FOUND" }));
    await drain();
    expect(ids()).toEqual(["threads"]);
    expect(node.streams.map((followed) => followed.stream)).toEqual(["agents"]);
    // No catalog to say where the stream is: followed from its start.
    expect(node.streams[0]!.after).toBe(0);
    expect(node.streams[0]!.disposed).toBe(false);

    // An agent is defined once the plugin is up: the node is asked again, at once.
    node.streams[0]!.send();
    expect(node.pending).toHaveLength(2);
    node.pending[1]!.resolve({ head: 1, agents: [{ id: "lead" }] });
    await drain();
    expect(ids()).toEqual(["threads", "civilization"]);
    // It has agents: the stream is let go, and a later event asks nothing.
    expect(node.streams[0]!.disposed).toBe(true);
    node.streams[0]!.send();
    expect(node.pending).toHaveLength(2);
    await kernel.stop();
  });

  it("follows the stream from the catalog's head, asks once more when an event came meanwhile, and follows the unknown too (D1398)", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    node.pending[0]!.resolve({ head: 5, agents: [] });
    await drain();
    // From the head the catalog was read at: no backlog is replayed.
    expect(node.streams.map((followed) => followed.after)).toEqual([5]);

    // An event asks at once; one more while that answer is awaited asks once more.
    node.streams[0]!.send();
    expect(node.pending).toHaveLength(2);
    node.streams[0]!.send();
    node.streams[0]!.send();
    expect(node.pending).toHaveLength(2);
    node.pending[1]!.resolve({ head: 7, agents: [] });
    await drain();
    expect(node.pending).toHaveLength(3);
    node.pending[2]!.reject(Object.assign(new Error("slow"), { code: "TIMEOUT" }));
    await drain();
    expect(ids()).toEqual(["threads"]);
    // Not known: still followed, and an event asks again without a change of the connections.
    expect(node.streams[0]!.disposed).toBe(false);
    node.streams[0]!.send();
    expect(node.pending).toHaveLength(4);
    node.pending[3]!.resolve({ head: 9, agents: [{ id: "lead" }] });
    await drain();
    expect(ids()).toEqual(["threads", "civilization"]);
    expect(node.streams).toHaveLength(1);
    await kernel.stop();
  });

  it("leaves a node that may not read its agents alone, and drops the stream with the opening or the plugin (D1398)", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    node.pending[0]!.reject(Object.assign(new Error("no"), { code: "PERMISSION_DENIED" }));
    await drain();
    // Final for the opening: nothing is followed.
    expect(node.streams).toHaveLength(0);
    expect(ids()).toEqual(["threads"]);

    // A closed connection lets its follower go; the next opening follows afresh.
    node.setState("closed");
    node.setState("open");
    expect(node.pending).toHaveLength(2);
    node.pending[1]!.resolve({ head: 0, agents: [] });
    await drain();
    const followed = node.streams[0]!;
    expect(followed.disposed).toBe(false);
    node.setState("closed");
    expect(followed.disposed).toBe(true);

    node.setState("open");
    node.pending[2]!.resolve({ head: 0, agents: [] });
    await drain();
    const last = node.streams[1]!;
    await kernel.stop();
    expect(last.disposed).toBe(true);
  });

  it("gives up on a node after three unknown answers in one opening", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    for (let failure = 0; failure < 3; failure++) {
      node.pending[failure]!.reject(Object.assign(new Error("slow"), { code: "TIMEOUT" }));
      await drain();
      node.setState("open");
    }
    expect(node.pending).toHaveLength(3);
    expect(ids()).toEqual(["threads"]);

    // A new opening asks again, and so does a changed setting.
    node.setState("closed");
    node.setState("open");
    expect(node.pending).toHaveLength(4);
    kernel.config.setLayer("node", { "jhin.civilization": { enabled: "auto" } });
    expect(node.pending).toHaveLength(5);
    await kernel.stop();
  });

  it("drops an answer from an earlier opening of the connection", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    node.setState("closed");
    node.setState("open");
    expect(node.pending).toHaveLength(2);

    node.pending[0]!.resolve({ head: 1, agents: [{ id: "lead" }] });
    await drain();
    expect(ids()).toEqual(["threads"]);
    node.pending[1]!.resolve({ head: 0, agents: [] });
    await drain();
    expect(ids()).toEqual(["threads"]);
    await kernel.stop();
  });

  it("registers nothing for an answer that arrives after it was deactivated", async () => {
    const node = fakeConnections();
    const { kernel, ids } = await start({ connections: node.connections });
    await kernel.reload("jhin.civilization");
    expect(node.pending).toHaveLength(2);

    node.pending[0]!.resolve({ head: 1, agents: [{ id: "lead" }] });
    await drain();
    expect(ids()).toEqual(["threads"]);
    // The live activation still offers it; a leaked one would make this register throw.
    node.pending[1]!.resolve({ head: 1, agents: [{ id: "lead" }] });
    await drain();
    expect(ids()).toEqual(["threads", "civilization"]);
    await kernel.stop();
  });
});
