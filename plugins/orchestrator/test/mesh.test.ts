// A mission of one node worked on across the mesh (docs/plans/agents.md, M2: D1541–D1545).
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  INBOX_STREAM,
  MESSAGES_STREAM,
  MessageEvents,
  ThreadEvents,
  threadAddress,
  threadStream,
} from "@jhin/agent-api";
import { MISSIONS_STREAM, type Mission, type Slice } from "@jhin/missions-api";
import type { StoredEvent } from "@jhin/storage-api";
import {
  createMemoryNetwork,
  memoryStoragePlugin,
  mockCapability,
  startMeshNode,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import fake from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import agents from "@jhin/plugin-agents";
import health from "@jhin/plugin-health";
import { manifest, watch } from "../../agents/test/support.ts";
import missions from "@jhin/plugin-missions";
import orchestration from "@jhin/plugin-orchestration";
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
const builderOf = (node: string) => `jhin://${node}/agents/builder`;
const payloadOf = (event: StoredEvent) => event.payload as Record<string, any>;
const PROOF = [{ kind: "command" as const, command: "look", output: "it stands" }];

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** What a node leaves behind to start again on: its data folder and storage. */
interface Restart {
  readonly data: string;
  readonly storage: ReturnType<typeof memoryStoragePlugin>;
}

async function meshNode(
  network: ReturnType<typeof createMemoryNetwork>,
  id: string,
  restart: Restart = {
    data: Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-mesh-missions-${id}-`)),
    storage: memoryStoragePlugin(),
  },
) {
  const { data, storage } = restart;
  const node = await startMeshNode(network, id, {
    storage,
    config: {
      node: {
        "jhin.threads": { defaultAgent: "jhin.agent-fake" },
        "jhin.agents": {
          agents: { builder: { role: "Builds slices", runtime: "jhin.agent-fake" } },
        },
        "jhin.orchestrator": { refocusEveryTurns: 0 },
      },
    },
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (plugin: string) => {
          Fs.mkdirSync(Path.join(data, plugin), { recursive: true });
          return Path.join(data, plugin);
        },
      }),
      mockCapability("host.identity", { nodeId: id }),
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: fake },
      { manifest: manifest("agents"), definition: agents },
      { manifest: manifest("missions"), definition: missions },
      { manifest: manifest("orchestration"), definition: orchestration },
      { manifest: manifest("orchestrator"), definition: orchestrator },
      { manifest: manifest("health"), definition: health },
    ],
  });
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

/** Nodes a and b joined, and a mission on a with its project's intent. */
async function mesh() {
  const network = createMemoryNetwork();
  const a = await meshNode(network, "a");
  const b = await meshNode(network, "b");
  await b.node.join(a.node);
  const project = await a.client.call<{ id: string }>("projects.create", { path: a.data });
  await a.client.call("missions.intent.set", {
    projectId: project.id,
    intent: "Keep the dog dry",
  });
  const mission = await a.client.call<Mission>("missions.create", {
    projectId: project.id,
    title: "Doghouse",
    outcome: "The dog has a shelter",
  });
  const slice = (fields: Record<string, unknown>) =>
    a.client.call<Slice>("slices.create", { missionId: mission.id, spec: "It stands", ...fields });
  return { a, b, mission, slice };
}

describe("a slice handed to an agent of another node (D1541–D1543)", () => {
  it("links its thread there, and its agent works on it with node", async () => {
    const { a, b, slice } = await mesh();
    const walls = await slice({ title: "Walls", assignee: builderOf("b") });
    expect(await a.client.call("missions.next", { missionId: walls.missionId })).toMatchObject({
      ready: [walls.id],
      decisions: [],
    });

    const handed = await a.client.call<{ threadId: string; nodeId: string }>("slices.handoff", {
      sliceId: walls.id,
    });
    expect(handed).toMatchObject({ delivered: "agent", nodeId: "b", handed: true });
    expect(await a.client.call("slices.get", { sliceId: walls.id })).toMatchObject({
      status: "active",
      threads: [{ threadId: handed.threadId, nodeId: "b" }],
    });
    // Handing it again names the same thread, on its node.
    expect(await a.client.call("slices.handoff", { sliceId: walls.id })).toMatchObject({
      handed: false,
      threadId: handed.threadId,
      nodeId: "b",
    });

    // The builder on b is told to name the mission's node with its tools (D1542).
    const events = watch(b.client, threadStream(handed.threadId));
    const turn = await events.until(ThreadEvents.turnStarted);
    const text = payloadOf(turn).input.text as string;
    expect(text).toContain("The mission lives on node `a`");
    expect(text).toContain(`slices_prove { sliceId, items, node: "a" }`);

    // As that agent, on its own node: the proof lands on a.
    const asBuilder = {
      threadId: handed.threadId,
      caller: { id: `jhin.agent-fake:${handed.threadId}`, permissions: AGENT_GRANTS },
    };
    await expect(
      b.node.kernel.commands.execute(
        "slices.update",
        { sliceId: walls.id, step: "build" },
        asBuilder,
      ),
    ).rejects.toMatchObject({ code: "SLICE_NOT_FOUND" });
    expect(
      await b.node.kernel.commands.execute(
        "slices.prove",
        { sliceId: walls.id, items: PROOF, node: "a" },
        asBuilder,
      ),
    ).toMatchObject({ id: walls.id, status: "done" });
    expect(await a.client.call("slices.get", { sliceId: walls.id })).toMatchObject({
      status: "done",
      proof: { by: "node:b" },
    });
  });

  it("is refocused on its node from the slice on the mission's node", async () => {
    const { a, b, slice } = await mesh();
    const walls = await slice({
      title: "Walls",
      spec: "Four walls stand",
      assignee: builderOf("b"),
    });
    const { threadId } = await a.client.call<{ threadId: string }>("slices.handoff", {
      sliceId: walls.id,
    });
    const events = watch(b.client, threadStream(threadId));
    await events.until(ThreadEvents.turnCompleted);

    // A compaction on b brings the slice's chain from a, as for a slice of b (D1543).
    await b.client.call("threads.send", { threadId, text: "/compact" });
    await events.until(ThreadEvents.contextCompacted);
    const steered = await events.until(ThreadEvents.turnSteered);
    const text = payloadOf(steered).input.text as string;
    expect(text).toContain("[Refocus: your context was compacted]");
    expect(text).toContain("Four walls stand");
    expect(text).toContain("Keep the dog dry");
    await events.until(ThreadEvents.turnCompleted, 1);

    // On request too; once the slice is done there, the thread is no longer followed.
    expect(await b.client.call("refocus.send", { threadId })).toMatchObject({
      outcome: "started",
    });
    await events.until(ThreadEvents.turnCompleted, 2);
    await a.client.call("slices.prove", { sliceId: walls.id, items: PROOF });
    await expect(b.client.call("refocus.send", { threadId })).rejects.toMatchObject({
      code: "SLICE_NOT_FOUND",
    });
  });
});

describe("what only the mission's node may ask (D1543, D1545)", () => {
  it("refuses a follow or a run record a node makes for another", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a");
    const b = await meshNode(network, "b");
    const c = await meshNode(network, "c");
    await b.node.join(a.node);
    await c.node.join(a.node);
    const thread = await b.client.call<{ id: string }>("threads.create", { title: "Work" });
    // c asks b to follow b's thread for a's slices: only a may.
    await expect(
      c.client.call("mesh.call", {
        node: "b",
        method: "refocus.follow",
        params: { threadId: thread.id, node: "a" },
      }),
    ).rejects.toMatchObject({ code: "MESH_ONLY" });

    const project = await a.client.call<{ id: string }>("projects.create", { path: a.data });
    const mission = await a.client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog has a shelter",
    });
    const record = { missionId: mission.id, workflowId: "w", status: "running" };
    // Not from another node: refused.
    await expect(
      a.client.call("missions.orchestration.record", {
        ...record,
        parentThreadId: thread.id,
        lead: threadAddress("a", thread.id),
      }),
    ).rejects.toMatchObject({ code: "MESH_ONLY" });
    // From c, naming a lead of b: refused.
    await expect(
      c.client.call("mesh.call", {
        node: "a",
        method: "missions.orchestration.record",
        params: { ...record, parentThreadId: thread.id, lead: threadAddress("b", thread.id) },
      }),
    ).rejects.toMatchObject({ code: "MESH_ONLY" });
    expect(await a.client.call("missions.orchestration", { missionId: mission.id })).toMatchObject({
      run: null,
    });
    // c reaches b's missions through a: a relays no member's call to a third (D416).
    await expect(
      c.client.call("mesh.call", {
        node: "a",
        method: "missions.list",
        params: { node: "b" },
      }),
    ).rejects.toMatchObject({ code: "RELAY_REFUSED" });
  });
});

describe("a run's end that comes before its start (D1545)", () => {
  it("is reported once the start is recorded", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a");
    const b = await meshNode(network, "b");
    await b.node.join(a.node);
    const lead = await b.client.call<{ id: string }>("threads.create", { title: "Lead" });
    const project = await a.client.call<{ id: string }>("projects.create", { path: a.data });
    const mission = await a.client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog has a shelter",
    });
    const inbox = watch(a.client, INBOX_STREAM);
    const record = (params: Record<string, unknown>) =>
      b.client.call("mesh.call", {
        node: "a",
        method: "missions.orchestration.record",
        params: { missionId: mission.id, workflowId: "w-1", ...params },
      });
    expect(await record({ status: "failed", error: "the script broke" })).toMatchObject({
      recorded: false,
    });
    expect(
      await record({
        status: "running",
        parentThreadId: lead.id,
        lead: threadAddress("b", lead.id),
      }),
    ).toMatchObject({ recorded: true });
    const report = await inbox.untilMatch((event) => event.type === MessageEvents.received);
    expect(payloadOf(report).message).toMatchObject({
      from: threadAddress("b", lead.id),
      messageId: `report-${mission.id}-w-1`,
    });
  });
});

describe("a lead on another node (D1544, D1545)", () => {
  async function leadOnB() {
    const world = await mesh();
    const lead = await world.b.client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    const asLead = {
      threadId: lead.id,
      caller: { id: `jhin.agent-fake:${lead.id}`, permissions: AGENT_GRANTS },
    };
    const orchestrate = () =>
      world.b.node.kernel.commands.execute(
        "missions.orchestrate",
        { missionId: world.mission.id, node: "a" },
        asLead,
      ) as Promise<{ workflowId: string; existing: boolean }>;
    return { ...world, lead, asLead, orchestrate };
  }
  const workflowEnds = (feed: ReturnType<typeof watch>, workflowId: string) =>
    feed
      .untilMatch(
        (event) =>
          event.type === "orchestration.workflow.updated" &&
          payloadOf(event).workflowId === workflowId &&
          payloadOf(event).status !== "running",
      )
      .then(payloadOf);
  const becomes = (feed: ReturnType<typeof watch>, sliceId: string, status: string) =>
    feed.untilMatch(
      (event) => payloadOf(event).slice?.id === sliceId && payloadOf(event).slice.status === status,
    );

  it("runs the orchestrator there, which hands out the mission's slices as the lead", async () => {
    const { a, b, slice, mission, lead, orchestrate } = await leadOnB();
    const walls = await slice({ title: "Walls", assignee: builderOf("a") });
    const roof = await slice({ title: "Roof", assignee: builderOf("b") });
    const missionsFeed = watch(a.client, MISSIONS_STREAM);
    const messages = watch(a.client, MESSAGES_STREAM);
    const workflows = watch(b.client, "orchestration");

    const started = await orchestrate();
    expect(started).toMatchObject({ existing: false });
    await becomes(missionsFeed, walls.id, "active");
    await becomes(missionsFeed, roof.id, "active");
    // The builder on a hears it from the lead's thread on b (D1106, D1545).
    const handoff = await messages.untilMatch(
      (event) =>
        event.type === MessageEvents.delivered && payloadOf(event).message.to === builderOf("a"),
    );
    expect(payloadOf(handoff).message.from).toBe(threadAddress("b", lead.id));
    // The builder on b took it in a thread of b, linked as such on a.
    const roofThread = (await a.client.call<Slice>("slices.get", { sliceId: roof.id })).threads;
    expect(roofThread).toEqual([{ threadId: expect.any(String), nodeId: "b" }]);
    // The mission's node knows the run, and where it runs.
    expect(await a.client.call("missions.orchestration", { missionId: mission.id })).toMatchObject({
      run: { workflowId: started.workflowId, nodeId: "b", parentThreadId: lead.id },
    });
    expect(await orchestrate()).toMatchObject({
      workflowId: started.workflowId,
      existing: true,
    });

    await a.client.call("slices.prove", { sliceId: walls.id, items: PROOF });
    await a.client.call("slices.prove", { sliceId: roof.id, items: PROOF });
    expect(await workflowEnds(workflows, started.workflowId)).toMatchObject({
      status: "completed",
      result: { outcome: "slices-done", missionId: mission.id, node: "a" },
    });
  });

  it("stops the run and the agents at work on every node, and the owner hears it", async () => {
    const { a, b, slice, mission, lead, orchestrate } = await leadOnB();
    const walls = await slice({ title: "Walls", assignee: builderOf("a") });
    const roof = await slice({ title: "Roof", assignee: builderOf("b") });
    const missionsFeed = watch(a.client, MISSIONS_STREAM);
    const inbox = watch(a.client, INBOX_STREAM);
    const workflows = watch(b.client, "orchestration");
    const started = await orchestrate();
    await becomes(missionsFeed, walls.id, "active");
    await becomes(missionsFeed, roof.id, "active");

    const stopped = await a.client.call<{ run: unknown; agents: unknown[] }>("missions.stop", {
      missionId: mission.id,
    });
    expect(stopped.run).toMatchObject({ workflowId: started.workflowId, nodeId: "b" });
    expect(stopped.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: builderOf("a"), stoppedAt: expect.any(String) }),
        expect.objectContaining({ address: builderOf("b"), stoppedAt: expect.any(String) }),
      ]),
    );
    expect(await b.client.call("agents.get", { agentId: "builder" })).toMatchObject({
      stoppedAt: expect.any(String),
    });
    expect(await workflowEnds(workflows, started.workflowId)).toMatchObject({
      status: "stopped",
    });
    // b tells a the run ended; a reports it to its owner as the lead (D1222, D1545).
    const report = await inbox.untilMatch((event) => event.type === MessageEvents.received);
    expect(payloadOf(report).message).toMatchObject({
      from: threadAddress("b", lead.id),
      messageId: `report-${mission.id}-${started.workflowId}`,
    });
  });
});

describe("a node that goes away mid-mission (D1547–D1551)", () => {
  it("is a decision for the lead, a warning for the owner, and holds the answers to it", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a");
    let b = await meshNode(network, "b");
    await b.node.join(a.node);
    const project = await a.client.call<{ id: string }>("projects.create", { path: a.data });
    const mission = await a.client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog has a shelter",
    });
    const walls = await a.client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Walls",
      spec: "It stands",
      assignee: builderOf("b"),
    });
    const lead = await a.client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    const missionsFeed = watch(a.client, MISSIONS_STREAM);
    const workflows = watch(a.client, "orchestration");
    const healthFeed = watch(a.client, "health");
    const run = await a.client.call<{ workflowId: string }>("missions.orchestrate", {
      missionId: mission.id,
      parentThreadId: lead.id,
    });
    const active = await missionsFeed.untilMatch(
      (event) =>
        payloadOf(event).slice?.id === walls.id && payloadOf(event).slice.status === "active",
    );
    // The builder on b tells a's owner something, then b goes away.
    const asBuilder = {
      threadId: payloadOf(active).slice.threads[0].threadId as string,
      caller: { id: "jhin.agent-fake:builder", permissions: AGENT_GRANTS },
    };
    const note = (await b.node.kernel.commands.execute(
      "agents.send",
      { to: "jhin://a/owner", body: "The wood is wet" },
      asBuilder,
    )) as { message: { messageId: string } };
    await b.stop();

    // The orchestrator ends at once with the decision for the lead (D1547).
    const ended = await workflows.untilMatch(
      (event) =>
        event.type === "orchestration.workflow.updated" &&
        payloadOf(event).workflowId === run.workflowId &&
        payloadOf(event).status !== "running",
    );
    expect(payloadOf(ended).result).toMatchObject({
      outcome: "decide",
      decisions: [{ sliceId: walls.id, reason: "away" }],
    });
    const next = await a.client.call<{ head: number }>("missions.next", {
      missionId: mission.id,
    });
    expect(next).toMatchObject({
      working: [],
      decisions: [{ sliceId: walls.id, reason: "away" }],
    });
    // A wait by a caller that saw no node away ends at once, and nothing is handed there.
    expect(
      await a.client.call("missions.wait", { missionId: mission.id, after: next.head, away: [] }),
    ).toMatchObject({ changed: true });
    const roof = await a.client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Roof",
      spec: "It keeps the rain out",
      wave: 1,
      assignee: builderOf("b"),
    });
    await expect(a.client.call("slices.handoff", { sliceId: roof.id })).rejects.toMatchObject({
      code: "SLICE_NOT_READY",
      details: { reason: "away" },
    });
    await a.client.call("slices.delete", { sliceId: roof.id });
    // Health warns the owner (D1548), with nobody asked to analyse it.
    const raised = await healthFeed.until("health.warning.raised");
    expect(payloadOf(raised).warning).toMatchObject({
      detector: "away",
      subject: `away:${mission.id}:b`,
      group: { kind: "mission", missionId: mission.id },
      summary: "1 slice of «Doghouse» wait on node b, which is away",
    });
    // The inbox says its sender is away, and keeps the item open (D1549).
    const { items } = await a.client.call<{ items: { away?: boolean }[] }>("agents.inbox.list", {});
    expect(items).toEqual([expect.objectContaining({ away: true })]);
    await expect(
      a.client.call("agents.inbox.answer", {
        messageId: note.message.messageId,
        answer: "Dry it first",
      }),
    ).rejects.toMatchObject({ code: "SENDER_AWAY" });

    // b comes back on its data: the warning clears itself, and the answer goes.
    b = await meshNode(network, "b", b.restart);
    await b.node.join(a.node);
    const cleared = await healthFeed.until("health.warning.cleared");
    expect(payloadOf(cleared)).toMatchObject({
      warningId: payloadOf(raised).warning.warningId,
      reason: "node-back",
    });
    expect(await a.client.call("missions.next", { missionId: mission.id })).toMatchObject({
      working: [walls.id],
      decisions: [],
    });
    expect(
      await a.client.call("agents.inbox.answer", {
        messageId: note.message.messageId,
        answer: "Dry it first",
      }),
    ).toMatchObject({ item: { status: "answered" } });
  });
});
