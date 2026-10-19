import {
  CONNECTIONS_CAPABILITY,
  MACHINE_KINDS,
  MACHINES_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type NodeConnection,
  type NodeMachines,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, type Logger } from "@jhin/sdk";
import { createTestKernel, mockCapability, testManifest, type TestKernel } from "@jhin/testing";
import { UI_SLOTS_CAPABILITY, createSlotRegistry, type SlotRegistry } from "@jhin/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MachineIcon } from "../src/lib/machine-icon.tsx";
import { useMachineKind } from "../src/lib/machines.ts";
import { machinesPlugin } from "../src/plugins/machines.tsx";

const A = "ws://a/rpc";

/** Renders `element` and returns the container's svg's attributes, then unmounts it. */
function svgOf(element: React.ReactElement): { machine: string | null; className: string } {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(element));
  const svg = container.querySelector("svg")!;
  const found = {
    machine: svg.getAttribute("data-machine"),
    className: svg.getAttribute("class") ?? "",
  };
  act(() => root.unmount());
  return found;
}

describe("a node's machine icon", () => {
  it("draws each kind T3 Code knows with its own icon", () => {
    const drawn = new Set<string>();
    for (const kind of MACHINE_KINDS) {
      const svg = svgOf(<MachineIcon className="size-3.5" kind={kind} />);
      expect(svg.machine).toBe(kind);
      expect(svg.className).toContain("size-3.5");
      drawn.add(markupOf(kind));
    }
    expect(drawn.size).toBe(MACHINE_KINDS.length);
    expect(svgOf(<MachineIcon kind="laptop" />).className).toContain("lucide-laptop");
  });

  it("is a server's for a kind this client does not know, or none yet", () => {
    for (const kind of ["toaster", undefined]) {
      const svg = svgOf(<MachineIcon kind={kind} />);
      expect(svg.machine).toBe("server");
      expect(svg.className).toContain("lucide-server");
    }
  });
});

/** The markup of a kind's icon, to tell icons apart. */
function markupOf(kind: string): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<MachineIcon kind={kind} />));
  const markup = host.querySelector("svg")!.innerHTML;
  act(() => root.unmount());
  return markup;
}

/** Node a and its mesh member b; each answers `host.identity` with its file's `jhin.host`. */
function world() {
  const files = new Map<string, Record<string, unknown>>();
  /** Nodes whose `host.identity` refuses this client, as a token without the permission would. */
  const denied = new Set<string>();
  const calls: { target: NodeTarget; method: string; params: unknown }[] = [];
  const connections: Connections = {
    list: () => [
      { id: A, url: A, label: "a", state: "open", client: {} } as unknown as NodeConnection,
    ],
    get: (id) => connections.list().find((node) => node.id === id),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  const threads = {
    async call(target: NodeTarget, method: string, params?: unknown) {
      calls.push({ target, method, params });
      const key = targetKey(target);
      if (method === "host.identity" && denied.has(key))
        throw Object.assign(new Error("Missing permission host.identity"), {
          code: "PERMISSION_DENIED",
        });
      if (method === "host.identity")
        return {
          nodeId: key,
          hostname: key,
          platform: "linux",
          arch: "x64",
          machine: files.get(key)?.["machine"] ?? "desktop",
          detectedMachine: "desktop",
        };
      if (method === "host.config.patch") {
        const { values, unset } = params as { values: Record<string, unknown>; unset?: string[] };
        const next = { ...files.get(key), ...values };
        for (const name of unset ?? []) delete next[name];
        files.set(key, next);
        return { applied: true, at: 1 };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as ThreadsCatalog;
  return { connections, threads, files, calls, denied };
}

let kernel: TestKernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
});

async function start(setup: (w: ReturnType<typeof world>) => void = () => undefined) {
  const w = world();
  setup(w);
  const slots = createSlotRegistry();
  let machines!: NodeMachines;
  // Warnings of the plugins, and a way to wait for the next one.
  const warnings: { message: string; fields: unknown }[] = [];
  let warned: (() => void) | undefined;
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn(message, fields) {
      warnings.push({ message, fields });
      warned?.();
    },
    error: () => undefined,
    child: () => logger,
  };
  const nextWarning = () => new Promise<void>((resolve) => (warned = resolve));
  kernel = await createTestKernel({
    side: "client",
    logger,
    plugins: [
      mockCapability(UI_SLOTS_CAPABILITY, slots),
      mockCapability(CONNECTIONS_CAPABILITY, w.connections),
      mockCapability(THREADS_CAPABILITY, w.threads),
      machinesPlugin,
      {
        manifest: testManifest("test.probe", { requires: { [MACHINES_CAPABILITY]: "^1" } }),
        definition: definePlugin({
          activate(context) {
            machines = context.services.get<NodeMachines>(MACHINES_CAPABILITY);
          },
        }),
      },
    ],
  });
  // The test follows each node it looks at for as long as it runs, as a view would.
  const waiting = new Map<string, ((kind: string | undefined) => void)[]>();
  /** Resolves with the target's kind the next time the store tells its followers. */
  const changed = (target: NodeTarget) =>
    new Promise<string | undefined>((resolve) => {
      const key = targetKey(target);
      if (!waiting.has(key)) {
        waiting.set(key, []);
        machines.subscribe(target, () => {
          for (const waiter of waiting.get(key)!.splice(0)) waiter(machines.get(target)?.kind);
        });
      }
      waiting.get(key)!.push(resolve);
    });
  const run = (input: unknown) => kernel!.commands.execute("node.set-machine", input);
  return {
    ...w,
    warnings,
    nextWarning,
    slots: slots as SlotRegistry,
    machines: () => machines,
    changed,
    run,
  };
}

describe("the node-machines plugin", () => {
  it("shows a node as what it reports, and re-renders when that changes", async () => {
    const t = await start();
    const container = document.createElement("div");
    const root = createRoot(container);
    function Probe() {
      return <MachineIcon kind={useMachineKind(t.machines(), { node: A })} />;
    }
    const answered = t.changed({ node: A });
    act(() => root.render(<Probe />));
    expect(container.querySelector("svg")!.getAttribute("data-machine")).toBe("server");
    await act(() => answered);
    expect(container.querySelector("svg")!.getAttribute("data-machine")).toBe("desktop");

    const changed = t.changed({ node: A });
    await act(async () => {
      await t.run({ node: A, machine: "laptop" });
      await changed;
    });
    expect(container.querySelector("svg")!.getAttribute("data-machine")).toBe("laptop");
    act(() => root.unmount());
  });

  it("sets a node's kind in its node config, and unsets it to follow detection again", async () => {
    const t = await start();
    const followed = t.changed({ node: A });
    expect(await followed).toBe("desktop");

    const laptop = t.changed({ node: A });
    expect(await t.run({ node: A, machine: "laptop" })).toEqual({ applied: true });
    expect(await laptop).toBe("laptop");
    expect(t.calls.find((call) => call.method === "host.config.patch")?.params).toEqual({
      layer: "node",
      section: "jhin.host",
      values: { machine: "laptop" },
    });

    const detected = t.changed({ node: A });
    await t.run({ node: A, machine: null });
    expect(await detected).toBe("desktop");
    expect(t.calls.findLast((call) => call.method === "host.config.patch")?.params).toEqual({
      layer: "node",
      section: "jhin.host",
      values: {},
      unset: ["machine"],
    });
    expect(t.files.get(A)).toEqual({});
  });

  it("sets the kind of a mesh member through its connection", async () => {
    const t = await start();
    const remote = { node: A, remote: "b" };
    expect(await t.changed(remote)).toBe("desktop");
    const cloud = t.changed(remote);
    await t.run({ ...remote, machine: "cloud" });
    expect(await cloud).toBe("cloud");
    expect(t.calls.find((call) => call.method === "host.config.patch")?.target).toEqual(remote);
  });

  it("refuses a node this client is not connected to, and a kind it does not know", async () => {
    const t = await start();
    await expect(t.run({ node: "ws://elsewhere/rpc", machine: "laptop" })).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
    await expect(t.run({ node: A, machine: "toaster" })).rejects.toThrow();
    expect(t.calls.some((call) => call.method === "host.config.patch")).toBe(false);
  });

  it("asks again after the node config page saved the jhin.host section, only that one", async () => {
    const t = await start();
    expect(await t.changed({ node: A })).toBe("desktop");
    const asked = () => t.calls.filter((call) => call.method === "host.identity").length;
    const before = asked();
    kernel!.events.emit("settings.node-config.saved", { connection: A, section: "jhin.http" });
    expect(asked()).toBe(before);

    t.files.set(A, { machine: "mac-studio" });
    const studio = t.changed({ node: A });
    kernel!.events.emit("settings.node-config.saved", { connection: A, section: "jhin.host" });
    expect(await studio).toBe("mac-studio");
  });

  it("logs why a node shows as a server when it refuses host.identity", async () => {
    const t = await start((w) => w.denied.add(A));
    const warning = t.nextWarning();
    t.machines().subscribe({ node: A }, () => undefined);
    await warning;
    expect(t.machines().get({ node: A })).toBeUndefined();
    expect(t.warnings).toEqual([
      {
        message: expect.stringContaining("host.identity failed"),
        fields: expect.objectContaining({
          node: A,
          code: "PERMISSION_DENIED",
          error: "Missing permission host.identity",
        }),
      },
    ]);
  });

  it("puts T3's Icon submenu into each node's menu", async () => {
    const t = await start();
    expect(t.slots.list("node.actions").map((item) => item.id)).toEqual([
      "jhin.node-machines.icon",
    ]);
  });
});
