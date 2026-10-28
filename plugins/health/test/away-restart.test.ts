// Since when a node is away survives a restart of the mission's node
// (docs/plans/agents.md, M3: D1570), against two in-memory nodes: a holds the
// mission and restarts on the same storage while b, which its slice waits on,
// stays away or comes back meanwhile.
import * as Fs from "node:fs";

import { HEALTH_STREAM, HealthEvents, type Warning } from "@jhin/health-api";
import { LIVE_STREAMS_CAPABILITY } from "@jhin/rpc";
import { MESH_STREAMS_CAPABILITY } from "@jhin/mesh-api";
import type { Mission, Slice } from "@jhin/missions-api";
import { definePlugin, z } from "@jhin/sdk";
import type { EventLog, StoredEvent } from "@jhin/storage-api";
import {
  createMemoryNetwork,
  memoryStoragePlugin,
  startMeshNode,
  testManifest,
  type MemoryMeshNode,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import missions from "@jhin/plugin-missions";
import health from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

type Network = ReturnType<typeof createMemoryNetwork>;
type Remembered = NonNullable<NonNullable<Parameters<typeof startMeshNode>[2]>["members"]>;
type Storage = ReturnType<typeof memoryStoragePlugin>;

/** A node with missions and health, and a stand-in for the analyst health asks. */
async function node(network: Network, id: string, storage?: Storage, members?: Remembered) {
  const started = await startMeshNode(network, id, {
    ...(storage === undefined ? {} : { storage }),
    ...(members === undefined ? {} : { members }),
    plugins: [
      { manifest: manifest("missions"), definition: missions },
      {
        manifest: testManifest("test.agents", {
          side: "server",
          requires: { [LIVE_STREAMS_CAPABILITY]: "^1.1", [MESH_STREAMS_CAPABILITY]: "^1" },
        }),
        definition: definePlugin({
          activate(context) {
            context.commands.register({
              name: "host.identity",
              description: "This node's id",
              input: z.object({}),
              output: z.object({ nodeId: z.string() }),
              handler: () => ({ nodeId: id }),
            });
            context.commands.register({
              name: "agents.ask",
              description: "Answers as an analyst would",
              input: z.object({ to: z.string(), question: z.string() }).passthrough(),
              output: z.object({ status: z.string(), answer: z.string().optional() }),
              handler: () => ({ status: "answered", answer: "noted" }),
            });
          },
        }),
      },
      { manifest: manifest("health"), definition: health },
    ],
  });
  stops.push(() => started.stop());
  return started;
}

/** The next event of `type` appended to `stream`: a fact, not a wait for time. */
function nextAppended(log: EventLog, type: string, test: (event: StoredEvent) => boolean) {
  return new Promise<StoredEvent>((resolve) => {
    const subscription = log.subscribe(HEALTH_STREAM, (event) => {
      if (event.type !== type || !test(event)) return;
      subscription.dispose();
      resolve(event);
    });
  });
}

const raisedFor = (subject: string) => (event: StoredEvent) =>
  (event.payload as { warning: Warning }).warning.subject === subject;

/** Resolves once `from` lists `to` with `reachable`. */
function listed(from: MemoryMeshNode, to: string, reachable: boolean) {
  return new Promise<void>((resolve) => {
    const test = () =>
      from.mesh.members().some((m) => m.record.nodeId === to && m.reachable === reachable);
    const subscription = from.mesh.onChange(check);
    function check() {
      if (!test()) return;
      subscription.dispose();
      resolve();
    }
    check();
  });
}

/** a's mission with a slice for b, b away, its warning raised and dismissed. */
async function dismissedWhileAway() {
  const network = createMemoryNetwork();
  const storage = memoryStoragePlugin();
  const a = await node(network, "a", storage);
  const b = await node(network, "b");
  await b.join(a);
  const { client } = a.connect();
  const mission = await client.call<Mission>("missions.create", {
    projectId: "p1",
    title: "Doghouse",
    outcome: "The dog sleeps dry.",
  });
  await client.call<Slice>("slices.create", {
    missionId: mission.id,
    title: "Floor",
    spec: "The floor holds the dog.",
    assignee: "jhin://b/agents/builder",
  });
  const subject = `away:${mission.id}:b`;
  const raised = nextAppended(a.log, HealthEvents.warningRaised, raisedFor(subject));
  const gone = listed(a, "b", false);
  network.down(b.address);
  await gone;
  const { payload } = await raised;
  const { warningId } = (payload as { warning: Warning }).warning;
  await client.call("health.warnings.dismiss", { warningId });
  return { network, storage, a, b, mission, subject };
}

describe("since when a node is away survives a restart (D1570)", () => {
  it("does not raise a dismissed away warning again for a node away all along", async () => {
    const { network, storage, a, b, mission, subject } = await dismissedWhileAway();
    // What jhin.mesh remembers of its members across the restart.
    const remembered = a.mesh.members().map((member) => member.record);
    await a.stop();
    const again = await node(network, "a", storage, remembered);
    await listed(again, "b", false);
    // A second mission waits on b too: its warning is raised in the same pass
    // that decides on the first, after it, so the first was left quiet.
    const { client } = again.connect();
    const other = await client.call<Mission>("missions.create", {
      projectId: "p1",
      title: "Kennel",
      outcome: "The kennel stands.",
    });
    const second = nextAppended(
      again.log,
      HealthEvents.warningRaised,
      raisedFor(`away:${other.id}:b`),
    );
    await client.call<Slice>("slices.create", {
      missionId: other.id,
      title: "Roof",
      spec: "The roof is on.",
      assignee: "jhin://b/agents/builder",
    });
    await second;
    const raisedForFirst = (await again.log.read(HEALTH_STREAM)).filter(
      (event) => event.type === HealthEvents.warningRaised && raisedFor(subject)(event),
    );
    expect(raisedForFirst).toHaveLength(1);
    expect(mission.id).not.toBe(other.id);
    expect(b.id).toBe("b");
  });

  it("counts from the node's return when it came back while the mission's node was down", async () => {
    const { network, storage, a, b, subject } = await dismissedWhileAway();
    const remembered = a.mesh.members().map((member) => member.record);
    await a.stop();
    network.up(b.address);
    const again = await node(network, "a", storage, remembered);
    await listed(again, "b", true);
    // b goes away again: this is a new absence, so the dismissal does not hold.
    const raised = nextAppended(again.log, HealthEvents.warningRaised, raisedFor(subject));
    const gone = listed(again, "b", false);
    network.down(b.address);
    await gone;
    await raised;
  });
});
