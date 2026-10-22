import * as Fs from "node:fs";

import {
  MESSAGES_STREAM,
  MessageEvents,
  ThreadEvents,
  threadAddress,
  threadStream,
} from "@jhin/agent-api";
import { MISSIONS_STREAM, missionProgress, type Mission, type Slice } from "@jhin/missions-api";
import type { RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { node as agentsNode, watch } from "../../agents/test/support.ts";
import missions from "../../missions/src/index.ts";
import orchestration from "../../orchestration/src/index.ts";
import orchestrator from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const BUILDER = "jhin://node-a/agents/builder";
const OWNER = "jhin://node-a/owner";
/** What a thread's agent holds over MCP (mcp-api's AGENT_PERMISSIONS, D341, D652). */
const AGENT = {
  id: "lead-agent",
  permissions: [
    "threads.read",
    "threads.write",
    "missions.read",
    "missions.write",
    "agents.message",
  ],
};

async function node(config: Record<string, unknown> = {}) {
  const started = await agentsNode({
    agents: { builder: { title: "Builder", role: "Builds slices", runtime: "jhin.agent-fake" } },
    project: { "jhin.orchestrator": { refocusEveryTurns: 0, ...config } },
    plugins: [
      { manifest: manifest("missions"), definition: missions },
      { manifest: manifest("orchestration"), definition: orchestration },
      { manifest: manifest("orchestrator"), definition: orchestrator },
    ],
  });
  const { client } = started;
  const project = await client.call<{ id: string }>("projects.create", { path: started.data });
  await client.call("missions.intent.set", {
    projectId: project.id,
    intent: "Keep the dog dry",
    process: [{ id: "release" }],
  });
  const mission = await client.call<Mission>("missions.create", {
    projectId: project.id,
    title: "Doghouse",
    outcome: "The dog has a shelter",
  });
  const slice = (fields: Record<string, unknown>) =>
    client.call<Slice>("slices.create", { missionId: mission.id, spec: "It stands", ...fields });
  return { ...started, project, mission, slice };
}

const payloadOf = (event: StoredEvent) => event.payload as Record<string, any>;
const prove = (client: RpcClient, sliceId: string) =>
  client.call("slices.prove", {
    sliceId,
    items: [{ kind: "command", command: "look", output: "it stands" }],
  });
/** The first update of the `missions` stream that leaves `sliceId` in `status`. */
const sliceBecomes = (feed: ReturnType<typeof watch>, sliceId: string, status: string) =>
  feed.untilMatch(
    (event) =>
      event.type === "missions.slice.updated" &&
      payloadOf(event).slice.id === sliceId &&
      payloadOf(event).slice.status === status,
  );
const workflowEnds = (feed: ReturnType<typeof watch>, workflowId: string) =>
  feed
    .untilMatch(
      (event) =>
        event.type === "orchestration.workflow.updated" &&
        payloadOf(event).workflowId === workflowId &&
        payloadOf(event).status !== "running",
    )
    .then(payloadOf);

describe("missionProgress (D702)", () => {
  const at = (n: number) => `2026-10-21T00:00:0${n}.000Z`;
  const slice = (id: string, fields: Partial<Slice>): Slice => ({
    id,
    missionId: "m",
    projectId: "p",
    title: id,
    spec: "",
    wave: 1,
    dependsOn: [],
    status: "planned",
    threads: [],
    createdAt: at(Number(id.slice(1))),
    updatedAt: at(0),
    ...fields,
  });

  it("moves only the earliest open wave and names what waits for a decision", () => {
    const progress = missionProgress(
      [
        slice("s1", { assignee: BUILDER }),
        slice("s2", { assignee: OWNER, status: "active" }),
        slice("s3", {}),
        slice("s4", { assignee: BUILDER, status: "blocked" }),
        slice("s5", { assignee: "jhin://node-b/agents/x" }),
        slice("s6", { wave: 2, assignee: BUILDER }),
        slice("s7", { status: "dropped" }),
        slice("s8", { wave: 3, assignee: BUILDER, dependsOn: ["s7"] }),
      ],
      { nodeId: "node-a" },
    );
    expect(progress).toEqual({
      wave: 1,
      ready: ["s1"],
      working: ["s2"],
      decisions: [
        { sliceId: "s3", reason: "unassigned" },
        { sliceId: "s4", reason: "blocked" },
        { sliceId: "s5", reason: "elsewhere" },
        { sliceId: "s8", reason: "orphaned", dropped: ["s7"] },
      ],
      total: 8,
      slicesDone: false,
    });
  });

  it("is done once no slice is open, and moves on past a finished wave", () => {
    expect(missionProgress([slice("s1", { status: "dropped" })])).toMatchObject({
      wave: null,
      slicesDone: true,
    });
    expect(
      missionProgress([
        slice("s1", { status: "done" }),
        slice("s2", { wave: 2, assignee: BUILDER, dependsOn: ["s1"] }),
      ]),
    ).toMatchObject({ wave: 2, ready: ["s2"], slicesDone: false });
  });
});

describe("slices.handoff (D703)", () => {
  it("hands a slice to its agent's current generation, once", async () => {
    const { client, mission, slice } = await node();
    const walls = await slice({ title: "Walls", spec: "Four walls stand", assignee: BUILDER });
    const handed = await client.call<{ slice: Slice; threadId: string; handed: boolean }>(
      "slices.handoff",
      { sliceId: walls.id },
    );
    expect(handed).toMatchObject({
      delivered: "agent",
      handed: true,
      slice: { status: "active", step: "spec", threads: [{ threadId: handed.threadId }] },
    });
    // The agent had no generation: its first one takes the slice.
    const generations = await client.call<{ threadId: string; current: boolean }[]>(
      "agents.generations",
      { agentId: "builder" },
    );
    expect(generations).toMatchObject([{ threadId: handed.threadId, current: true }]);
    const turn = await watch(client, threadStream(handed.threadId)).until(ThreadEvents.turnStarted);
    const text = payloadOf(turn).input.text as string;
    expect(text).toContain("[Slice handed to you]");
    expect(text).toContain(`Slice \`${walls.id}\`, wave 1.`);
    expect(text).toContain("Four walls stand");
    expect(text).toContain("Mission outcome: The dog has a shelter");
    expect(text).toContain("Project intent: Keep the dog dry");
    expect(text).toContain("spec → build → test; it is at spec");
    expect(text).toContain("slices_prove");

    const again = await client.call("slices.handoff", { sliceId: walls.id });
    expect(again).toMatchObject({ handed: false, threadId: handed.threadId });
    expect(await client.call("missions.next", { missionId: mission.id })).toMatchObject({
      wave: 1,
      ready: [],
      working: [walls.id],
    });
  });

  it("marks the owner's slice active, and refuses what is not ready here", async () => {
    const { client, slice } = await node();
    const roof = await slice({ title: "Roof", assignee: OWNER });
    expect(await client.call("slices.handoff", { sliceId: roof.id })).toMatchObject({
      delivered: "owner",
      handed: true,
      slice: { status: "active", step: "spec", threads: [] },
    });
    const later = await slice({ title: "Paint", wave: 2, assignee: BUILDER });
    await expect(client.call("slices.handoff", { sliceId: later.id })).rejects.toMatchObject({
      code: "SLICE_NOT_READY",
    });
    const nobody = await slice({ title: "Door" });
    await expect(client.call("slices.handoff", { sliceId: nobody.id })).rejects.toMatchObject({
      code: "SLICE_NOT_READY",
      details: { reason: "unassigned" },
    });
    const far = await slice({ title: "Bowl", assignee: "jhin://node-b/agents/x" });
    await expect(client.call("slices.handoff", { sliceId: far.id })).rejects.toMatchObject({
      code: "AGENT_ELSEWHERE",
    });
  });
});

describe("missions.orchestrate (D706, D707)", () => {
  it("walks the waves, waits for proofs and hands the lead each wave's steps", async () => {
    const { client, mission, slice } = await node();
    const lead = await client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    const walls = await slice({ title: "Walls", assignee: BUILDER });
    const roof = await slice({ title: "Roof", assignee: OWNER });
    const paint = await slice({ title: "Paint", assignee: BUILDER, dependsOn: [walls.id] });
    const missionsFeed = watch(client, MISSIONS_STREAM);
    const workflows = watch(client, "orchestration");
    const messages = watch(client, MESSAGES_STREAM);

    const first = await client.call<{ workflowId: string; existing: boolean }>(
      "missions.orchestrate",
      { missionId: mission.id, parentThreadId: lead.id },
    );
    expect(first).toMatchObject({ name: "mission", status: "running", existing: false });
    // The owner's token names the lead's thread: the handoff comes from it (D1106).
    const handoff = await messages.untilMatch(
      (event) => event.type === MessageEvents.delivered && payloadOf(event).message.to === BUILDER,
    );
    expect(payloadOf(handoff).message.from).toBe(threadAddress("node-a", lead.id));
    await sliceBecomes(missionsFeed, walls.id, "active");
    await sliceBecomes(missionsFeed, roof.id, "active");
    expect(
      await client.call("missions.orchestrate", { missionId: mission.id, parentThreadId: lead.id }),
    ).toMatchObject({ workflowId: first.workflowId, existing: true });
    // Wave 2 waits for wave 1.
    expect(
      missionsFeed.events.some(
        (event) =>
          payloadOf(event).slice?.id === paint.id && payloadOf(event).slice.status === "active",
      ),
    ).toBe(false);
    await prove(client, walls.id);
    await prove(client, roof.id);
    expect(await workflowEnds(workflows, first.workflowId)).toMatchObject({
      status: "completed",
      currentPhase: "Wave 1",
      result: {
        outcome: "wave-done",
        wave: 1,
        steps: [{ id: "merge" }],
        handed: [walls.id, roof.id],
      },
    });

    // The lead ran the merge and goes on.
    const second = await client.call<{ workflowId: string }>("missions.orchestrate", {
      missionId: mission.id,
      parentThreadId: lead.id,
    });
    await sliceBecomes(missionsFeed, paint.id, "active");
    await prove(client, paint.id);
    expect(await workflowEnds(workflows, second.workflowId)).toMatchObject({
      status: "completed",
      result: {
        outcome: "slices-done",
        steps: [{ id: "merge" }],
        projectSteps: [{ id: "release" }],
        handed: [paint.id],
      },
    });
    // The lead decides when the mission is done (D651).
    expect(await client.call("missions.get", { missionId: mission.id })).toMatchObject({
      mission: { status: "planned" },
    });
  });

  it("lets the lead's agent start it, acting with its own grants, and returns decisions", async () => {
    const { kernel, client, mission, slice } = await node();
    const lead = await client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    const walls = await slice({ title: "Walls", assignee: BUILDER });
    const door = await slice({ title: "Door" });
    const workflows = watch(client, "orchestration");
    const missionsFeed = watch(client, MISSIONS_STREAM);
    const messages = watch(client, MESSAGES_STREAM);
    const started = (await kernel.commands.execute(
      "missions.orchestrate",
      { missionId: mission.id },
      { caller: AGENT, threadId: lead.id },
    )) as { workflowId: string };
    expect(await workflowEnds(workflows, started.workflowId)).toMatchObject({
      status: "completed",
      result: {
        outcome: "decide",
        wave: 1,
        decisions: [{ sliceId: door.id, reason: "unassigned" }],
        handed: [walls.id],
      },
    });
    // The handoff ran as the agent, not as the node.
    expect(payloadOf(await sliceBecomes(missionsFeed, walls.id, "active")).by).toBe(AGENT.id);
    // And its message comes from the lead's thread, not from the owner (D1106).
    const handoff = await messages.untilMatch(
      (event) => event.type === MessageEvents.delivered && payloadOf(event).message.to === BUILDER,
    );
    expect(payloadOf(handoff).message.from).toBe(threadAddress("node-a", lead.id));
  });

  it("acts from a named thread only for a caller that may act for anyone (D1106)", async () => {
    const { kernel, client, mission, slice } = await node();
    const lead = await client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    await slice({ title: "Walls", assignee: BUILDER });
    const messages = watch(client, MESSAGES_STREAM);
    await kernel.commands.execute(
      "missions.orchestrate",
      { missionId: mission.id, parentThreadId: lead.id },
      { caller: { id: "ops", permissions: [...AGENT.permissions] } },
    );
    const handoff = await messages.untilMatch(
      (event) => event.type === MessageEvents.delivered && payloadOf(event).message.to === BUILDER,
    );
    // Not the lead's thread: a scoped caller without a thread sends as the owner (D622).
    expect(payloadOf(handoff).message.from).toBe(OWNER);
  });

  it("needs a thread to run from and an open mission", async () => {
    const { client, kernel, mission } = await node();
    await expect(
      client.call("missions.orchestrate", { missionId: mission.id }),
    ).rejects.toMatchObject({ code: "THREAD_REQUIRED" });
    await client.call("missions.update", { missionId: mission.id, status: "dropped" });
    await expect(
      kernel.commands.execute(
        "missions.orchestrate",
        { missionId: mission.id },
        { caller: AGENT, threadId: "t" },
      ),
    ).rejects.toMatchObject({ code: "MISSION_CLOSED" });
  });
});

describe("missions.orchestration (D1086)", () => {
  it("names a mission's last run and the stream head to follow it from", async () => {
    const { client, mission, slice } = await node();
    expect(await client.call("missions.orchestration", { missionId: mission.id })).toMatchObject({
      run: null,
      head: expect.any(Number),
    });
    const lead = await client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    await slice({ title: "Door" });
    const workflows = watch(client, "orchestration");
    const started = await client.call<{ workflowId: string }>("missions.orchestrate", {
      missionId: mission.id,
      parentThreadId: lead.id,
    });
    await workflowEnds(workflows, started.workflowId);
    const answer = await client.call<{ head: number; run: unknown }>("missions.orchestration", {
      missionId: mission.id,
    });
    expect(answer.run).toMatchObject({
      workflowId: started.workflowId,
      parentThreadId: lead.id,
      status: "completed",
      result: { outcome: "decide" },
    });
    expect(answer.head).toBeGreaterThan(0);
    await expect(
      client.call("missions.orchestration", { missionId: "nope" }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  });
});

describe("refocus (D708–D711)", () => {
  it("briefs a slice's intent chain by slice and by thread", async () => {
    const { client, slice } = await node();
    const walls = await slice({ title: "Walls", spec: "Four walls stand", assignee: BUILDER });
    const { threadId } = await client.call<{ threadId: string }>("slices.handoff", {
      sliceId: walls.id,
    });
    const bySlice = await client.call<{ markdown: string; chain: unknown }>("refocus.brief", {
      sliceId: walls.id,
    });
    expect(bySlice.chain).toMatchObject({
      slice: { id: walls.id, spec: "Four walls stand", status: "active" },
      mission: { title: "Doghouse", outcome: "The dog has a shelter" },
      project: { intent: "Keep the dog dry" },
    });
    expect(bySlice.markdown).toContain("[Refocus]");
    expect(bySlice.markdown).toContain('("moonbase")');
    const byThread = await client.call<{ markdown: string }>("refocus.brief", {
      threadId,
      reason: "interval",
    });
    expect(byThread.markdown).toContain("[Refocus: a regular look back up]");
    await expect(client.call("refocus.brief", { threadId: "nowhere" })).rejects.toMatchObject({
      code: "SLICE_NOT_FOUND",
    });
  });

  it("steers the intent chain into a turn that compacted its context", async () => {
    const { client, slice } = await node();
    const walls = await slice({ title: "Walls", spec: "Four walls stand", assignee: BUILDER });
    const { threadId } = await client.call<{ threadId: string }>("slices.handoff", {
      sliceId: walls.id,
    });
    const events = watch(client, threadStream(threadId));
    await events.until(ThreadEvents.turnCompleted);
    await client.call("threads.send", { threadId, text: "/compact" });
    const compacted = await events.until(ThreadEvents.contextCompacted);
    expect(payloadOf(compacted)).toMatchObject({ trigger: "manual" });
    const steered = await events.until(ThreadEvents.turnSteered);
    const text = payloadOf(steered).input.text as string;
    expect(text).toContain("[Refocus: your context was compacted]");
    expect(text).toContain("Four walls stand");
    expect(text).toContain("Keep the dog dry");
    expect(payloadOf(steered).turnId).toBe(payloadOf(compacted).turnId);
  });

  it("refocuses every few turns, as configured, and on request", async () => {
    const { client, slice } = await node({ refocusEveryTurns: 2 });
    const walls = await slice({ title: "Walls", assignee: BUILDER });
    const { threadId } = await client.call<{ threadId: string }>("slices.handoff", {
      sliceId: walls.id,
    });
    const events = watch(client, threadStream(threadId));
    await events.until(ThreadEvents.turnCompleted);
    // The handoff's turn started before the thread was linked: two more make the interval.
    await client.call("threads.send", { threadId, text: "one" });
    await events.until(ThreadEvents.turnCompleted, 1);
    await client.call("threads.send", { threadId, text: "/hold" });
    const steered = await events.until(ThreadEvents.turnSteered);
    expect(payloadOf(steered).input.text).toContain("[Refocus: a regular look back up]");
    await events.until(ThreadEvents.turnCompleted, 2);

    // On request, on a free thread: its next message.
    const sent = await client.call<{ messageId: string; outcome: string }>("refocus.send", {
      threadId,
    });
    expect(sent.outcome).toBe("started");
    const turn = await events.untilMatch(
      (event) =>
        event.type === ThreadEvents.turnStarted && payloadOf(event).messageId === sent.messageId,
    );
    expect(payloadOf(turn).input.text).toContain("[Refocus]");
  });
});
