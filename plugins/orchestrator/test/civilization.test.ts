// The civilization scenario across two nodes (docs/plans/agents.md, M3: D1563):
// C3's scenario (D1101) with its team split over nodes a and b. The owner
// steers from a client of a; b goes away mid-mission and comes back
// (D1547–D1549). The fake agents' own acts are commands sent as them (D1102).
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  INBOX_STREAM,
  MESSAGES_STREAM,
  MessageEvents,
  ThreadEvents,
  threadStream,
} from "@jhin/agent-api";
import { MISSIONS_STREAM, type Mission, type Slice } from "@jhin/missions-api";
import type { StoredEvent } from "@jhin/storage-api";
import {
  createMemoryNetwork,
  memoryStoragePlugin,
  mockCapability,
  startMeshNode,
  type TestKernel,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import fake from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import agents from "@jhin/plugin-agents";
import health from "@jhin/plugin-health";
import missions from "@jhin/plugin-missions";
import orchestration from "@jhin/plugin-orchestration";
import teams from "@jhin/plugin-teams";
import { hostConfig, manifest, watch } from "../../agents/test/support.ts";
import orchestrator from "../src/index.ts";

/** What a thread's agent holds over MCP (mcp-api's AGENT_PERMISSIONS). */
const AGENT_GRANTS = [
  "threads.read",
  "threads.write",
  "missions.read",
  "missions.write",
  "agents.read",
  "agents.message",
];
const FAKE = "jhin.agent-fake";
const payloadOf = (event: StoredEvent) => event.payload as Record<string, any>;
const proof = (output: string) => [{ kind: "command" as const, command: "look", output }];
const member = (node: string, name: string) => `jhin://${node}/agents/crew-${name}`;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** What a node leaves behind to start again on. */
interface Restart {
  readonly data: string;
  readonly storage: ReturnType<typeof memoryStoragePlugin>;
  readonly layers: Record<string, Record<string, unknown>>;
}

async function meshNode(
  network: ReturnType<typeof createMemoryNetwork>,
  id: string,
  config: Record<string, unknown>,
  restart: Restart = {
    data: Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-civilization-${id}-`)),
    storage: memoryStoragePlugin(),
    layers: {
      node: {
        "jhin.threads": { defaultAgent: FAKE },
        "jhin.orchestrator": { refocusEveryTurns: 0 },
        ...config,
      },
    },
  },
) {
  const { data, storage, layers } = restart;
  let kernel: TestKernel | undefined;
  const node = await startMeshNode(network, id, {
    storage,
    config: layers,
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (plugin: string) => {
          Fs.mkdirSync(Path.join(data, plugin), { recursive: true });
          return Path.join(data, plugin);
        },
      }),
      mockCapability("host.identity", { nodeId: id }),
      hostConfig(() => kernel!, layers),
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: fake },
      { manifest: manifest("agents"), definition: agents },
      { manifest: manifest("teams"), definition: teams },
      { manifest: manifest("missions"), definition: missions },
      { manifest: manifest("orchestration"), definition: orchestration },
      { manifest: manifest("orchestrator"), definition: orchestrator },
      { manifest: manifest("health"), definition: health },
    ],
  });
  kernel = node.kernel;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await node.stop();
  };
  stops.push(stop);
  const { client } = node.connect();
  return { node, client, data, stop, restart };
}

describe("a civilization across two nodes (D1563)", () => {
  it("runs a mission whose slices work on each node, and goes on once a node away is back", async () => {
    const network = createMemoryNetwork();
    const crew = {
      lead: "lead",
      agents: {
        lead: { role: "Plans and runs the mission", runtime: FAKE },
        builder: { role: "Builds slices", runtime: FAKE },
        builder2: { role: "Builds slices", runtime: FAKE, node: "b" },
        reviewer: { role: "Checks the built work", runtime: FAKE, node: "b" },
      },
    };
    const a = await meshNode(network, "a", { "jhin.teams": { teams: { crew } } });
    let b = await meshNode(network, "b", {});
    await b.node.join(a.node);

    // The team comes up split over both nodes (D685).
    const up = await a.client.call<{ members: { address: string; result: string }[] }>("teams.up", {
      teamId: "crew",
    });
    expect(up.members.map((item) => item.address).toSorted()).toEqual(
      [
        member("a", "builder"),
        member("a", "lead"),
        member("b", "builder2"),
        member("b", "reviewer"),
      ].toSorted(),
    );

    // The owner, on a client of a, talks to the lead only.
    const aMessages = watch(a.client, MESSAGES_STREAM);
    const sent = await a.client.call<{ delivery: { threadId: string } }>("agents.send", {
      to: member("a", "lead"),
      body: "Build the doghouse; the builders are on both nodes.",
    });
    const leadThread = sent.delivery.threadId;
    const asLead = {
      threadId: leadThread,
      caller: { id: `${FAKE}:${leadThread}`, permissions: AGENT_GRANTS },
    };
    const lead = <T>(name: string, input: unknown) =>
      a.node.kernel.commands.execute(name, input, asLead) as Promise<T>;

    // The lead plans: an intent, a mission, two waves over both nodes.
    const project = await a.client.call<{ id: string }>("projects.create", { path: a.data });
    await lead("missions.intent.set", { projectId: project.id, intent: "Keep the dog dry" });
    const mission = await lead<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog has a shelter",
      status: "active",
    });
    const slice = (fields: Record<string, unknown>) =>
      lead<Slice>("slices.create", { missionId: mission.id, spec: "It stands", ...fields });
    const walls = await slice({ title: "Walls", assignee: member("a", "builder") });
    const roof = await slice({ title: "Roof", assignee: member("b", "builder2") });
    const door = await slice({ title: "Door", assignee: member("b", "builder2") });
    const inspect = await slice({
      title: "Inspect",
      wave: 2,
      assignee: member("b", "reviewer"),
      dependsOn: [walls.id, roof.id, door.id],
    });

    const missionsFeed = watch(a.client, MISSIONS_STREAM);
    const workflows = watch(a.client, "orchestration");
    const healthFeed = watch(a.client, "health");
    const inbox = watch(a.client, INBOX_STREAM);
    const becomes = (sliceId: string, status: string) =>
      missionsFeed
        .untilMatch(
          (event) =>
            payloadOf(event).slice?.id === sliceId && payloadOf(event).slice.status === status,
        )
        .then((event) => payloadOf(event).slice as Slice);
    const runEnds = (workflowId: string) =>
      workflows
        .untilMatch(
          (event) =>
            event.type === "orchestration.workflow.updated" &&
            payloadOf(event).workflowId === workflowId &&
            payloadOf(event).status !== "running",
        )
        .then(payloadOf);
    const orchestrate = () =>
      lead<{ workflowId: string }>("missions.orchestrate", { missionId: mission.id });

    const first = await orchestrate();
    const wallsActive = await becomes(walls.id, "active");
    const roofActive = await becomes(roof.id, "active");
    const doorActive = await becomes(door.id, "active");
    // Each handoff comes from the lead (D1106); builder2's two slices are one
    // message, taken in one thread of b (D1541, D1562).
    const handoff = await aMessages.untilMatch(
      (event) =>
        event.type === MessageEvents.delivered &&
        payloadOf(event).message.to === member("a", "builder"),
    );
    expect(payloadOf(handoff).message.from).toBe(member("a", "lead"));
    expect(roofActive.threads).toEqual([{ threadId: expect.any(String), nodeId: "b" }]);
    expect(doorActive.threads).toEqual(roofActive.threads);
    const builder2Thread = roofActive.threads[0]!.threadId;
    const taken = await watch(b.client, threadStream(builder2Thread)).until(
      ThreadEvents.turnStarted,
    );
    expect(payloadOf(taken).input.text).toContain("[Slices handed to you]");
    expect(payloadOf(taken).input.text).toContain(`pass \`node: "a"\``);

    // The builders prove: on a as itself, on b with the mission's node (D1542).
    await a.node.kernel.commands.execute(
      "slices.prove",
      { sliceId: walls.id, items: proof("four walls") },
      {
        threadId: wallsActive.threads[0]!.threadId,
        caller: { id: `${FAKE}:builder`, permissions: AGENT_GRANTS },
      },
    );
    const asBuilder2 = {
      threadId: builder2Thread,
      caller: { id: `${FAKE}:builder2`, permissions: AGENT_GRANTS },
    };
    await b.node.kernel.commands.execute(
      "slices.prove",
      { sliceId: roof.id, items: proof("a roof"), node: "a" },
      asBuilder2,
    );
    // builder2 tells a's owner something, then b goes away with the door open.
    const note = (await b.node.kernel.commands.execute(
      "agents.send",
      { to: "jhin://a/owner", body: "The door's wood is wet" },
      asBuilder2,
    )) as { message: { messageId: string } };
    await inbox.untilMatch(
      (event) =>
        event.type === MessageEvents.received &&
        payloadOf(event).message.messageId === note.message.messageId,
    );
    await b.stop();

    // The lead is woken with the decision (D1547), the owner warned (D1548),
    // and the ask's answer held until b is back (D1549).
    expect(await runEnds(first.workflowId)).toMatchObject({
      status: "completed",
      result: { outcome: "decide", decisions: [{ sliceId: door.id, reason: "away" }] },
    });
    const raised = await healthFeed.until("health.warning.raised");
    expect(payloadOf(raised).warning).toMatchObject({
      detector: "away",
      group: { kind: "mission", missionId: mission.id },
      // Every open slice assigned there waits on it, the next wave's too (D1551).
      summary: "2 slices of «Doghouse» wait on node b, which is away",
    });
    const { items } = await a.client.call<{ items: { away?: boolean }[] }>("agents.inbox.list", {});
    expect(items).toEqual([expect.objectContaining({ away: true })]);
    await expect(
      a.client.call("agents.inbox.answer", {
        messageId: note.message.messageId,
        answer: "Dry it first",
      }),
    ).rejects.toMatchObject({ code: "SENDER_AWAY" });

    // b comes back on its data: the warning clears, the answer reaches builder2.
    b = await meshNode(network, "b", {}, b.restart);
    await b.node.join(a.node);
    const cleared = await healthFeed.until("health.warning.cleared");
    expect(payloadOf(cleared)).toMatchObject({
      warningId: payloadOf(raised).warning.warningId,
      reason: "node-back",
    });
    expect(
      await a.client.call("agents.inbox.answer", {
        messageId: note.message.messageId,
        answer: "Dry it first",
      }),
    ).toMatchObject({ item: { status: "answered" } });

    // The lead runs the orchestrator again; the door is proven, then the next wave.
    const second = await orchestrate();
    await b.node.kernel.commands.execute(
      "slices.prove",
      { sliceId: door.id, items: proof("a dry door"), node: "a" },
      asBuilder2,
    );
    // Wave 1 is over: the mission's steps between waves are the lead's (D706).
    expect(await runEnds(second.workflowId)).toMatchObject({
      status: "completed",
      result: { outcome: "wave-done", wave: 1 },
    });
    const third = await orchestrate();
    const inspecting = await becomes(inspect.id, "active");
    expect(inspecting.threads).toEqual([{ threadId: expect.any(String), nodeId: "b" }]);
    await b.node.kernel.commands.execute(
      "slices.prove",
      { sliceId: inspect.id, items: proof("dry inside"), node: "a" },
      {
        threadId: inspecting.threads[0]!.threadId,
        caller: { id: `${FAKE}:reviewer`, permissions: AGENT_GRANTS },
      },
    );
    expect(await runEnds(third.workflowId)).toMatchObject({
      status: "completed",
      result: { outcome: "slices-done", missionId: mission.id },
    });

    // The lead closes it, and the owner gets the report (D1222).
    await lead("missions.close", {
      missionId: mission.id,
      status: "done",
      summary: "Built on both nodes.",
    });
    const report = await inbox.untilMatch(
      (event) =>
        event.type === MessageEvents.received &&
        String(payloadOf(event).message.body).includes("Mission report"),
    );
    expect(payloadOf(report).message.from).toBe(member("a", "lead"));
    expect(await a.client.call("missions.get", { missionId: mission.id })).toMatchObject({
      mission: { status: "done" },
    });
  });
});
