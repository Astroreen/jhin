// Health warns when the node a mission's run runs on is away (docs/plans/agents.md,
// M3: D1571), against two in-memory nodes: a holds the mission and what it recorded
// of the run, b runs it.
import * as Fs from "node:fs";

import { HEALTH_STREAM, HealthEvents, type Warning } from "@jhin/health-api";
import { LIVE_STREAMS_CAPABILITY } from "@jhin/rpc";
import { MESH_STREAMS_CAPABILITY } from "@jhin/mesh-api";
import type { Mission } from "@jhin/missions-api";
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
type Recorded = { workflowId: string; nodeId: string; status: string };

async function node(
  network: Network,
  id: string,
  recorded: { current?: Recorded } = {},
  storage?: Storage,
  members?: Remembered,
) {
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
            // What the mission's node recorded of its run (D1545), as the orchestrator answers it.
            context.commands.register({
              name: "missions.orchestration",
              description: "The run of a mission, as recorded",
              input: z.object({ missionId: z.string(), offline: z.boolean().optional() }),
              output: z.object({ head: z.number(), run: z.null(), recorded: z.any().optional() }),
              handler: () => ({
                head: 0,
                run: null,
                ...(recorded.current === undefined ? {} : { recorded: recorded.current }),
              }),
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

const clearedFor = (warningId: string) => (event: StoredEvent) =>
  (event.payload as { warningId: string }).warningId === warningId;

const RAISED = (event: StoredEvent) => (event.payload as { warning: Warning }).warning;

/** a's mission, whose run b runs; b away, the warning raised. */
async function runAway() {
  const network = createMemoryNetwork();
  const recorded: { current?: Recorded } = {};
  const a = await node(network, "a", recorded);
  const b = await node(network, "b");
  await b.join(a);
  const { client } = a.connect();
  const mission = await client.call<Mission>("missions.create", {
    projectId: "p1",
    title: "Doghouse",
    outcome: "The dog sleeps dry.",
  });
  recorded.current = { workflowId: "w1", nodeId: "b", status: "running" };
  const subject = `away-run:${mission.id}`;
  const raised = nextAppended(a.log, HealthEvents.warningRaised, raisedFor(subject));
  const gone = listed(a, "b", false);
  network.down(b.address);
  await gone;
  const warning = RAISED(await raised);
  return { network, a, b, client, recorded, mission, subject, warning };
}

describe("a run on a node that is away (D1571)", () => {
  it("raises one warning for the mission, and clears it when the node is back", async () => {
    const { network, a, b, mission, warning } = await runAway();
    expect(warning).toMatchObject({
      detector: "away",
      status: "open",
      group: { kind: "mission", missionId: mission.id, title: "Doghouse" },
      summary: "The run of «Doghouse» runs on node b, which is away; nobody is woken",
    });
    const cleared = nextAppended(a.log, HealthEvents.warningCleared, clearedFor(warning.warningId));
    const back = listed(a, "b", true);
    network.up(b.address);
    await back;
    expect((await cleared).payload).toMatchObject({ reason: "node-back" });
  });

  it("clears it when the run ended, once health looks again", async () => {
    const { a, client, recorded, warning } = await runAway();
    const cleared = nextAppended(a.log, HealthEvents.warningCleared, clearedFor(warning.warningId));
    recorded.current = { workflowId: "w1", nodeId: "b", status: "completed" };
    // Health looks again at the next event it hears: a new mission is one.
    await client.call<Mission>("missions.create", {
      projectId: "p1",
      title: "Kennel",
      outcome: "The kennel stands.",
    });
    expect((await cleared).payload).toMatchObject({ reason: "run-ended" });
  });

  it("clears it when the run is recorded again from a node that is up", async () => {
    const { a, client, recorded, warning } = await runAway();
    const cleared = nextAppended(a.log, HealthEvents.warningCleared, clearedFor(warning.warningId));
    recorded.current = { workflowId: "w2", nodeId: "a", status: "running" };
    await client.call<Mission>("missions.create", {
      projectId: "p1",
      title: "Kennel",
      outcome: "The kennel stands.",
    });
    expect((await cleared).payload).toMatchObject({ reason: "node-back" });
  });
});
