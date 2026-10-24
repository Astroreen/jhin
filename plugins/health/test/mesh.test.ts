// Health of a team across nodes (docs/plans/agents.md, M1: D1525, D1526).
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { MESSAGES_STREAM, MessageEvents, ThreadEvents, ThreadHooks } from "@jhin/agent-api";
import {
  COMMITS_COUNTED_EVENT,
  HEALTH_STREAM,
  HealthEvents,
  type GroupStatus,
  type Warning,
} from "@jhin/health-api";
import { MESH_STREAMS_CAPABILITY, type MeshStreams } from "@jhin/mesh-api";
import type { Mission, Slice } from "@jhin/missions-api";
import { SOURCE_CONTROL_STREAM, SourceControlEvents } from "@jhin/source-control-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import type { EventLog, Json, StoredEvent } from "@jhin/storage-api";
import {
  createMemoryNetwork,
  nextEvent,
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

const BUILDER_B = "jhin://b/agents/builder";
const REVIEWER_B = "jhin://b/agents/reviewer";

/** The next event of `type` appended to `stream`: wait for facts, never for time. */
function nextAppended(log: EventLog, stream: string, type: string): Promise<StoredEvent> {
  return new Promise((resolve) => {
    const subscription = log.subscribe(stream, (event) => {
      if (event.type !== type) return;
      subscription.dispose();
      resolve(event);
    });
  });
}

/**
 * A node with missions and health, and a stand-in for jhin.agents: it guards
 * and shares `agents/messages` (D628, D1521), answers `host.identity` and asks.
 */
async function meshNode(network: ReturnType<typeof createMemoryNetwork>, id: string) {
  let probe: PluginContext | undefined;
  const node = await startMeshNode(network, id, {
    config: { project: { "jhin.health": { ceremony: { ratio: 3, minCeremony: 3 } } } },
    plugins: [
      { manifest: manifest("missions"), definition: missions },
      {
        manifest: testManifest("test.agents", {
          side: "server",
          requires: { [LIVE_STREAMS_CAPABILITY]: "^1.1", [MESH_STREAMS_CAPABILITY]: "^1" },
        }),
        definition: definePlugin({
          activate(context) {
            probe = context;
            context.subscriptions.add(
              context.services
                .get<LiveStreams>(LIVE_STREAMS_CAPABILITY)
                .guard(MESSAGES_STREAM, ["agents.read"]),
            );
            const shared = context.services.get<MeshStreams>(MESH_STREAMS_CAPABILITY);
            context.subscriptions.add(shared.share(MESSAGES_STREAM));
            // As jhin.source-control shares its stream (D501).
            context.subscriptions.add(shared.share(SOURCE_CONTROL_STREAM));
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
  stops.push(() => node.stop());
  return { node, probe: () => probe! };
}

/** A message delivered on `node`, as jhin.agents records it (D627). */
let delivered = 0;
function deliver(node: MemoryMeshNode, from: string, to: string, threadId: string) {
  delivered += 1;
  return node.log.append(MESSAGES_STREAM, [
    {
      type: MessageEvents.delivered,
      payload: {
        message: {
          messageId: `m${delivered}`,
          kind: "message",
          from,
          to,
          body: `message ${delivered}`,
          traceId: `trace-${delivered}`,
          sentAt: new Date().toISOString(),
        },
        delivery: { nodeId: node.id, threadId, queued: false },
      } as unknown as Json,
    },
  ]);
}

describe("health across the mesh (M1)", () => {
  it("counts a mission's work on another node on the mission's node, and that node's commits (D1525, D1526)", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a");
    const b = await meshNode(network, "b");
    await b.node.join(a.node);
    const { client } = a.node.connect();
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-health-mesh-"));
    const project = await client.call<{ id: string }>("projects.create", { path: data }).catch(
      // No threads plugin: missions take any project id.
      () => ({ id: "p1" }),
    );
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog sleeps dry.",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Floor",
      spec: "The floor holds the dog.",
      assignee: BUILDER_B,
    });

    // b's health followed a's missions when they met (D1525), through b's relay
    // of them. A follower attached after it on the same relay path is told a's
    // next event after it: a's log tells its subscribers in the order they came,
    // and a link delivers in order. So once ours has the link, b's health has.
    let linkSeen!: () => void;
    const linked = new Promise<void>((resolve) => (linkSeen = resolve));
    const streams = b.probe().services.get<MeshStreams>(MESH_STREAMS_CAPABILITY);
    const watching = streams.follow!("a", "missions", 0, (event) => {
      if ((event.payload as { slice?: Slice }).slice?.threads.length === 1) linkSeen();
    });
    await watching.ready;
    await client.call("slices.link", { sliceId: slice.id, threadId: "tb", nodeId: "b" });
    await linked;
    watching.dispose();

    // The builder and the reviewer talk on b about the slice's thread there:
    // a's mission counts it, a's node does not (D1526).
    const raised = nextEvent(a.node.kernel, HealthEvents.warningRaised);
    await deliver(b.node, REVIEWER_B, BUILDER_B, "tb");
    await deliver(b.node, BUILDER_B, REVIEWER_B, "tb");
    await deliver(b.node, REVIEWER_B, BUILDER_B, "tb");
    const { warning } = (await raised) as { warning: Warning };
    expect(warning).toMatchObject({
      detector: "ceremony",
      group: { kind: "mission", missionId: mission.id },
      measures: { ceremony: 3, progress: 0 },
    });
    expect(warning.evidence.map((ref) => ref.stream)).toEqual([
      "relay/b/agents/messages",
      "relay/b/agents/messages",
      "relay/b/agents/messages",
    ]);
    const status = await client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(status.groups.find((group) => group.group.kind === "node")).toBeUndefined();
    expect(status.groups.find((group) => group.group.kind === "mission")).toMatchObject({
      ceremony: 3,
      byKind: { message: 3 },
    });
    // The drill-down reads b's records through the relay, with what they take here.
    const detail = await client.call<{
      events: { payload: { message: { body: string } } | null; withheld?: string }[];
    }>("health.warnings.get", { warningId: warning.warningId });
    expect(detail.events.map((event) => event.payload?.message.body)).toEqual([
      "message 1",
      "message 2",
      "message 3",
    ]);
    const agentView = (await a.node.kernel.commands.execute(
      "health.warnings.get",
      { warningId: warning.warningId },
      { caller: { id: "agent", permissions: ["health.read"] } },
    )) as { events: { payload: unknown; withheld?: string }[] };
    expect(agentView.events.map((event) => event.withheld)).toEqual([
      "agents.read",
      "agents.read",
      "agents.read",
    ]);

    // Two turns on b in the slice's thread commit: b records them, since a's
    // slice links the thread (D1525), and a counts them as the mission's
    // progress, which clears the warning (D1383).
    const repo = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-health-mesh-git-"));
    const git = (...args: string[]) =>
      ChildProcess.execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "start");
    const cleared = nextAppended(a.node.log, HEALTH_STREAM, HealthEvents.warningCleared);
    for (const turnId of ["turn-1", "turn-2"]) {
      const turn = { threadId: "tb", projectId: "pb", turnId, agentId: "builder", cwd: repo };
      await b.probe().hooks.run(ThreadHooks.turnStart, turn, (input) => input);
      git("commit", "-q", "--allow-empty", "-m", turnId);
      const counted = nextEvent(b.node.kernel, COMMITS_COUNTED_EVENT);
      await b
        .probe()
        .hooks.run(ThreadHooks.turnEnd, { ...turn, status: "completed" }, (input) => input);
      expect(await counted).toEqual({ turnId, count: 1 });
    }
    expect((await cleared).payload).toMatchObject({ warningId: warning.warningId });
    const after = await client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(after.groups.find((group) => group.group.kind === "mission")).toMatchObject({
      ceremony: 3,
      progress: 2,
      byKind: { message: 3, commit: 2 },
    });
    // b raises nothing about a's mission: it counts no group of another node's.
    const onB = await b.node.connect().client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(onB.groups.map((group) => group.group.kind)).toEqual(["node"]);
  });

  it("counts queue activity and merges of a linked thread on another node, cuts a dismissal there, and follows it again after the member was away (D1526)", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a");
    const b = await meshNode(network, "b");
    await b.node.join(a.node);
    const { client } = a.node.connect();
    const mission = await client.call<Mission>("missions.create", {
      projectId: "p1",
      title: "Doghouse",
      outcome: "The dog sleeps dry.",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Floor",
      spec: "The floor holds the dog.",
      assignee: BUILDER_B,
    });
    await client.call("slices.link", { sliceId: slice.id, threadId: "tb", nodeId: "b" });
    const queue = () =>
      b.node.log.append("thread/tb", [{ type: ThreadEvents.queueUpdated, payload: {} as Json }]);
    const merged = (number: number) =>
      b.node.log.append(SOURCE_CONTROL_STREAM, [
        {
          type: SourceControlEvents.pullRequestUpdated,
          payload: {
            threadId: "tb",
            pullRequest: { key: `gh:o/r#${number}`, number, snapshot: { state: "merged" } },
          } as unknown as Json,
        },
      ]);

    // Queue activity of the slice's thread on b is the mission's ceremony on a.
    let raised = nextEvent(a.node.kernel, HealthEvents.warningRaised);
    for (let index = 0; index < 3; index += 1) await queue();
    const first = ((await raised) as { warning: Warning }).warning;
    expect(first.group).toMatchObject({ kind: "mission", missionId: mission.id });
    expect(first.evidence.map((ref) => [ref.stream, ref.sequence])).toEqual([
      ["relay/b/thread/tb", 1],
      ["relay/b/thread/tb", 2],
      ["relay/b/thread/tb", 3],
    ]);

    // Two pull requests of that thread merge on b, one of them told twice:
    // two pieces of progress, which clear the warning (D1383).
    const cleared = nextAppended(a.node.log, HEALTH_STREAM, HealthEvents.warningCleared);
    await merged(7);
    await merged(7);
    await merged(8);
    expect((await cleared).payload).toMatchObject({ warningId: first.warningId });
    const status = await client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(status.groups.find((group) => group.group.kind === "mission")?.byKind).toEqual({
      queue: 3,
      merge: 2,
    });

    // A dismissal cuts b's stream at the last event that reached a.
    raised = nextEvent(a.node.kernel, HealthEvents.warningRaised);
    for (let index = 0; index < 3; index += 1) await queue();
    const second = ((await raised) as { warning: Warning }).warning;
    const dismissed = nextAppended(a.node.log, HEALTH_STREAM, HealthEvents.warningDismissed);
    await client.call("health.warnings.dismiss", { warningId: second.warningId });
    expect(
      ((await dismissed).payload as { dismissedAfter: Record<string, number> }).dismissedAfter,
    ).toMatchObject({ "relay/b/thread/tb": 6 });

    // b goes away and comes back: its thread is followed again, from where a was.
    await new Promise<void>((resolve) => {
      const away = () =>
        a.node.mesh.members().some((member) => member.record.nodeId === "b" && !member.reachable);
      const watching = a.node.mesh.onChange(() => {
        if (!away()) return;
        watching.dispose();
        resolve();
      });
      network.down(b.node.address);
    });
    await new Promise<void>((resolve) => {
      const back = () =>
        a.node.mesh.members().some((member) => member.record.nodeId === "b" && member.reachable);
      const watching = a.node.mesh.onChange(() => {
        if (!back()) return;
        watching.dispose();
        resolve();
      });
      network.up(b.node.address);
    });
    raised = nextEvent(a.node.kernel, HealthEvents.warningRaised);
    for (let index = 0; index < 3; index += 1) await queue();
    const third = ((await raised) as { warning: Warning }).warning;
    expect(third.evidence.map((ref) => ref.sequence)).toEqual([7, 8, 9]);
  });
});
