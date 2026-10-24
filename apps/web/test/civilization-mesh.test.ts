// Civilization mode reads every node of the mesh (docs/plans/agents.md, M1:
// D1527–D1531), against two in-memory nodes: the client is connected to a,
// and c is a member of a's mesh that the client reaches only through a.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { INBOX_STREAM, type InboxItem } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type MeshMember,
  type MeshMembership,
  type Modes,
  type Navigation,
  type NodeConnection,
} from "@jhin/client-api";
import type { Mission } from "@jhin/missions-api";
import { definePlugin, toDisposable } from "@jhin/sdk";
import {
  createMemoryNetwork,
  createTestKernel,
  mockCapability,
  startMeshNode,
  testManifest,
} from "@jhin/testing";
import { UI_SLOTS_CAPABILITY, createSlotRegistry } from "@jhin/ui";
import { afterEach, describe, expect, it } from "vite-plus/test";

import fake from "../../../plugins/agent-fake/src/index.ts";
import agents from "../../../plugins/agents/src/index.ts";
import missions from "../../../plugins/missions/src/index.ts";
import threads from "../../../plugins/threads/src/index.ts";
import { meshTargets } from "../src/lib/mesh-targets.ts";
import { createAgentsStore, type NodeAgents } from "../src/plugins/agents/store.ts";
import { civilizationPlugin } from "../src/plugins/civilization.tsx";
import { createInboxStore } from "../src/plugins/inbox/store.ts";
import { createMissionsStore, type MissionsView } from "../src/plugins/missions/store.ts";
import { modesPlugin } from "../src/plugins/modes.ts";

const manifest = (dir: string) =>
  JSON.parse(
    Fs.readFileSync(new URL(`../../../plugins/${dir}/package.json`, import.meta.url), "utf8"),
  ).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const quiet = { warn() {}, info() {} };

/** a, with nothing of Civilization, and c, its member, with an agent and missions. */
async function mesh() {
  const network = createMemoryNetwork();
  const a = await startMeshNode(network, "a");
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-web-civilization-mesh-"));
  const c = await startMeshNode(network, "c", {
    config: {
      node: {
        "jhin.threads": { defaultAgent: "jhin.agent-fake" },
        "jhin.agents": {
          agents: { builder: { title: "Builder", role: "Builds", runtime: "jhin.agent-fake" } },
        },
      },
    },
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      mockCapability("host.identity", { nodeId: "c" }),
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: fake },
      { manifest: manifest("agents"), definition: agents },
      { manifest: manifest("missions"), definition: missions },
    ],
  });
  await c.join(a);
  const { client } = a.connect();
  stops.push(async () => {
    client.close();
    await a.stop();
    await c.stop();
    Fs.rmSync(data, { recursive: true, force: true });
  });
  const connection = {
    id: "a",
    url: "mem://a",
    label: "Laptop",
    state: "open",
    client,
  } as unknown as NodeConnection;
  const connections = {
    list: () => [connection],
    get: (id: string) => (id === "a" ? connection : undefined),
    subscribe: () => toDisposable(() => {}),
  } as unknown as Connections;
  const members: MeshMember[] = [
    { nodeId: "a", name: "Laptop", self: true, reachable: true },
    { nodeId: "c", name: "Server", self: false, reachable: true },
  ];
  const membership = {
    members: (id: string) => (id === "a" ? members : undefined),
    subscribe: () => toDisposable(() => {}),
  } as unknown as MeshMembership;
  return { a, c, client, connections, membership };
}

/** Resolves once `test` holds, checked on every change `subscribe` reports: a fact, not a wait. */
function until<T>(
  subscribe: (listener: () => void) => { dispose(): void },
  read: () => T,
  test: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    let subscription: { dispose(): void } | undefined;
    let done = false;
    const check = () => {
      const value = read();
      if (done || !test(value)) return;
      done = true;
      subscription?.dispose();
      resolve(value);
    };
    subscription = subscribe(check);
    if (done) subscription.dispose();
    check();
  });
}

describe("the nodes Civilization reads (D1527)", () => {
  const open = (id: string, label = id) =>
    ({ id, label, state: "open", client: {} }) as unknown as NodeConnection;
  const member = (nodeId: string, self = false, reachable = true): MeshMember => ({
    nodeId,
    name: `node ${nodeId}`,
    self,
    reachable,
  });

  it("lists each connection, then its reachable members, a node once and through its own connection", () => {
    const connections = [open("one"), open("two"), { ...open("down"), state: "closed" }] as never;
    const members: Record<string, MeshMember[]> = {
      // one is node a; b and c are its members, d is out of reach.
      one: [member("a", true), member("b"), member("c"), member("d", false, false)],
      // two is node b itself, which also sees c.
      two: [member("b", true), member("a"), member("c")],
    };
    const shown = meshTargets(connections, (id) => members[id]);
    expect(shown.map((node) => node.key)).toEqual(["one", "one|c", "two"]);
    expect(shown[1]).toMatchObject({
      target: { node: "one", remote: "c" },
      label: "node c",
      nodeId: "c",
    });
  });
});

describe("Civilization across the mesh (M1)", () => {
  it("lists a member's agents through its connection, live (D1528)", async () => {
    const { connections, membership, c } = await mesh();
    const store = createAgentsStore(connections, quiet, undefined, membership);
    // The roster's own subscription, held while the test looks.
    const roster = store.subscribe(() => {});
    stops.push(async () => {
      roster.dispose();
      store.dispose();
    });
    const subscribe = (listener: () => void) => store.subscribe(listener);
    const read = () => store.snapshot().get("a|c");
    const first = await until<NodeAgents | undefined>(
      subscribe,
      read,
      (state) => state?.status === "ready" && state.read.builder !== undefined,
    );
    expect(first?.agents.map((agent) => agent.address)).toEqual(["jhin://c/agents/builder"]);
    expect(store.nodes().map((node) => [node.key, node.label])).toEqual([
      ["a", "Laptop"],
      ["a|c", "Server"],
    ]);
    // a has no agents plugin: it shows none, and is no error.
    expect(store.snapshot().get("a")?.status).toBe("unsupported");
    // A new generation on c arrives through a's relay of c's `agents` stream.
    await c.kernel.commands.execute("agents.rotate", { agentId: "builder" });
    const rotated = await until<NodeAgents | undefined>(
      subscribe,
      read,
      (state) => (state?.agents[0]?.generations.length ?? 0) > 0,
    );
    expect(rotated?.agents[0]?.generations[0]?.number).toBe(1);
  });

  it("follows a member's inbox and tells an item that arrives there, with its node (D1530)", async () => {
    const { connections, membership, c } = await mesh();
    const told: { key: string; target: unknown; messageId: string }[] = [];
    let heard!: () => void;
    const arrived = new Promise<void>((resolve) => (heard = resolve));
    const store = createInboxStore(
      connections,
      quiet,
      (node, item: InboxItem) => {
        told.push({ key: node.key, target: node.target, messageId: item.message.messageId });
        heard();
      },
      membership,
    );
    stops.push(async () => store.dispose());
    await until(
      (listener) => store.subscribe(listener),
      () => store.snapshot().get("a|c"),
      (feed) => feed?.status === "ready",
    );
    const { generation } = (await c.kernel.commands.execute("agents.rotate", {
      agentId: "builder",
    })) as { generation: { threadId: string } };
    const asked = (await c.kernel.commands.execute(
      "agents.ask",
      { to: "jhin://c/owner", question: "Merge?" },
      {
        caller: { id: "jhin.agent-fake:builder", permissions: ["agents.message"] },
        threadId: generation.threadId,
      },
    )) as { message: { messageId: string } };
    await arrived;
    expect(told).toEqual([
      { key: "a|c", target: { node: "a", remote: "c" }, messageId: asked.message.messageId },
    ]);
    expect(
      store
        .snapshot()
        .get("a|c")
        ?.value.map((item) => item.message.messageId),
    ).toEqual([asked.message.messageId]);
    // Answering goes to c, through a.
    await store.target("a|c")!.channel.call("agents.inbox.answer", {
      messageId: asked.message.messageId,
      answer: "Yes.",
    });
    await until(
      (listener) => store.subscribe(listener),
      () => store.snapshot().get("a|c")?.value.length,
      (count) => count === 0,
    );
    expect(INBOX_STREAM).toBe("agents/inbox");
  });

  it("reads a member's missions and follows them (D1529)", async () => {
    const { connections, c } = await mesh();
    const store = createMissionsStore(connections, quiet);
    stops.push(async () => store.dispose());
    const target = { node: "a", remote: "c" };
    const subscribe = (listener: () => void) => store.subscribe(target, listener);
    await until<MissionsView>(
      subscribe,
      () => store.view(target),
      (view) => view.status === "ready",
    );
    const { id: projectId } = (await c.kernel.commands.execute("projects.create", {
      path: Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-web-mission-")),
    })) as { id: string };
    const mission = (await c.kernel.commands.execute("missions.create", {
      projectId,
      title: "Doghouse",
      outcome: "The dog sleeps dry.",
    })) as Mission;
    const view = await until<MissionsView>(
      subscribe,
      () => store.view(target),
      (next) => next.state.missions[mission.id] !== undefined,
    );
    expect(view.state.missions[mission.id]?.title).toBe("Doghouse");
    // The connected node itself has no missions plugin.
    await until<MissionsView>(
      (listener) => store.subscribe({ node: "a" }, listener),
      () => store.view({ node: "a" }),
      (next) => next.status === "unavailable",
    );
  });

  it("offers Civilization mode when only a member has agents (D1531)", async () => {
    const { connections, membership } = await mesh();
    let modes: Modes | undefined;
    let changed!: () => void;
    const offered = new Promise<void>((resolve) => (changed = resolve));
    const kernel = await createTestKernel({
      side: "client",
      plugins: [
        mockCapability(NAVIGATION_CAPABILITY, {
          current: () => ({ node: "a" }),
          navigate() {},
          subscribe: () => toDisposable(() => {}),
        } as unknown as Navigation),
        mockCapability(UI_SLOTS_CAPABILITY, createSlotRegistry()),
        mockCapability(CONNECTIONS_CAPABILITY, connections),
        mockCapability(MESH_CAPABILITY, membership),
        modesPlugin,
        civilizationPlugin,
        {
          manifest: testManifest("app.consumer", {
            side: "client",
            requires: { [MODES_CAPABILITY]: "^1" },
          }),
          definition: definePlugin({
            activate(context) {
              const found = context.services.get<Modes>(MODES_CAPABILITY);
              modes = found;
              context.subscriptions.add(
                found.subscribe(() => {
                  if (found.list().some((mode) => mode.id === "civilization")) changed();
                }),
              );
            },
          }),
        },
      ],
    });
    stops.push(() => kernel.stop());
    await offered;
    expect(modes!.list().map((mode) => mode.id)).toEqual(["threads", "civilization"]);
  });
});
