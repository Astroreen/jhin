// The inbox's away mark follows the mesh while the page is open (docs/plans/agents.md,
// M3: D1565), against two in-memory nodes: the client is connected to a, whose
// owner's inbox holds an ask from an agent of c; c stops, comes back.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { InboxItem } from "@jhin/agent-api";
import type { Connections, MeshMember, MeshMembership, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import {
  createMemoryNetwork,
  mockCapability,
  startMeshNode,
  type MemoryMeshNode,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import fake from "../../../plugins/agent-fake/src/index.ts";
import agents from "../../../plugins/agents/src/index.ts";
import threads from "../../../plugins/threads/src/index.ts";
import { createInboxStore } from "../src/plugins/inbox/store.ts";

const manifest = (dir: string) =>
  JSON.parse(
    Fs.readFileSync(new URL(`../../../plugins/${dir}/package.json`, import.meta.url), "utf8"),
  ).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const quiet = { warn() {}, info() {} };

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

describe("the inbox's away mark follows the mesh (D1565)", () => {
  it("marks an open item away when its sender's node stops, and clears it when the node is back", async () => {
    const network = createMemoryNetwork();
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-web-inbox-away-"));
    const start = (id: string) =>
      startMeshNode(network, id, {
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
            dataDir: (plugin: string) => {
              Fs.mkdirSync(Path.join(data, id, plugin), { recursive: true });
              return Path.join(data, id, plugin);
            },
          }),
          mockCapability("host.identity", { nodeId: id }),
          { manifest: manifest("threads"), definition: threads },
          { manifest: manifest("agent-fake"), definition: fake },
          { manifest: manifest("agents"), definition: agents },
        ],
      });
    const a = await start("a");
    const c = await start("c");
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
    // The membership a client keeps from a's `mesh` stream, here read from a's mesh itself.
    const read = (node: MemoryMeshNode): readonly MeshMember[] =>
      node.mesh.members().map((member) => ({
        nodeId: member.record.nodeId,
        name: member.record.nodeId,
        self: false,
        reachable: member.reachable,
      }));
    const membership = {
      members: (id: string) =>
        id === "a"
          ? [{ nodeId: "a", name: "a", self: true, reachable: true }, ...read(a)]
          : undefined,
      subscribe: (_id: string, listener: () => void) => a.mesh.onChange(listener),
    } as unknown as MeshMembership;

    // c's agent asks a's owner; the ask waits in a's inbox.
    const { generation } = (await c.kernel.commands.execute("agents.rotate", {
      agentId: "builder",
    })) as { generation: { threadId: string } };
    void c.kernel.commands
      .execute(
        "agents.ask",
        { to: "jhin://a/owner", question: "Merge?" },
        {
          caller: { id: "jhin.agent-fake:builder", permissions: ["agents.message"] },
          threadId: generation.threadId,
        },
      )
      .catch(() => {});

    const store = createInboxStore(connections, quiet, () => {}, membership);
    stops.push(async () => store.dispose());
    const open = (): InboxItem | undefined => store.snapshot().get("a")?.value[0];
    const watch = (test: (item: InboxItem | undefined) => boolean) =>
      until((listener) => store.subscribe(listener), open, test);

    const waiting = await watch((item) => item !== undefined);
    expect(waiting?.away).toBeUndefined();

    // c stops: the item turns away, with no reload.
    const reachable = (node: MemoryMeshNode, to: string, expected: boolean) =>
      until(
        (listener) => node.mesh.onChange(listener),
        () => node.mesh.members().find((member) => member.record.nodeId === to)?.reachable,
        (value) => value === expected,
      );
    const gone = reachable(a, "c", false);
    network.down(c.address);
    await gone;
    expect((await watch((item) => item?.away === true))?.away).toBe(true);

    // c is back: the mark clears.
    const back = reachable(a, "c", true);
    network.up(c.address);
    await back;
    expect(
      (await watch((item) => item !== undefined && item.away === undefined))?.away,
    ).toBeUndefined();
  });
});
