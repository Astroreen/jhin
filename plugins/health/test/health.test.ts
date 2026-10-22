import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { MESSAGES_STREAM, MessageEvents, ThreadHooks } from "@jhin/agent-api";
import {
  HEALTH_STREAM,
  HealthEvents,
  type Analysis,
  type GroupStatus,
  type Idea,
  type Warning,
} from "@jhin/health-api";
import type { Mission, Slice } from "@jhin/missions-api";
import { LIVE_STREAMS_CAPABILITY, createLiveStreams } from "@jhin/rpc";
import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import { SOURCE_CONTROL_STREAM, SourceControlEvents } from "@jhin/source-control-api";
import type { EventLog, Json, StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  nextEvent,
  testManifest,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import missions from "@jhin/plugin-missions";
import threads from "@jhin/plugin-threads";
import health from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const BUILDER = "jhin://node-a/agents/builder";
const REVIEWER = "jhin://node-a/agents/reviewer";
const OWNER = "jhin://node-a/owner";

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

type Asked = { to: string; question: string; messageId?: string | undefined };

/** A node on `storage`: starting another on the same storage is a restart. */
async function start(
  storage: ReturnType<typeof memoryStoragePlugin>,
  data: string,
  health_: Record<string, unknown>,
  asked: Asked[],
) {
  let probe: PluginContext | undefined;
  const kernel = await createTestKernel({
    config: { project: { "jhin.health": health_ } },
    plugins: [
      mockCapability(LIVE_STREAMS_CAPABILITY, createLiveStreams(), "1.1.0"),
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      storage,
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("missions"), definition: missions },
      // `agents.ask` as jhin.agents answers it: the analyst's last message (A2, D624).
      {
        manifest: testManifest("test.agents", { side: "server" }),
        definition: definePlugin({
          activate(context) {
            probe = context;
            context.commands.register({
              name: "agents.ask",
              description: "Answers as the analyst would",
              input: z.object({
                to: z.string(),
                question: z.string(),
                messageId: z.string().optional(),
              }),
              output: z.object({ status: z.string(), answer: z.string() }),
              handler: (input) => {
                asked.push(input);
                return { status: "answered", answer: `${input.to} says: stop re-proving` };
              },
            });
          },
        }),
      },
      { manifest: manifest("health"), definition: health },
    ],
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  const stop = async () => {
    client.close();
    await kernel.stop();
  };
  stops.push(stop);
  return { kernel, client, stop, probe: () => probe! };
}

async function node(health_: Record<string, unknown> = {}) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-health-"));
  const storage = memoryStoragePlugin();
  const asked: Asked[] = [];
  const { kernel, client, stop, probe } = await start(storage, data, health_, asked);
  const log = storage.storage.log;
  /** Stops this node and starts it again on the same storage. */
  const restart = async () => {
    await stop();
    return start(storage, data, health_, asked);
  };
  const project = await client.call<{ id: string }>("projects.create", { path: data });
  const mission = await client.call<Mission>("missions.create", {
    projectId: project.id,
    title: "Doghouse",
    outcome: "The dog sleeps dry.",
  });
  const slice = await client.call<Slice>("slices.create", {
    missionId: mission.id,
    title: "Floor",
    spec: "The floor holds the dog.",
    assignee: BUILDER,
  });
  await client.call("slices.link", { sliceId: slice.id, threadId: "t1" });
  /** A message delivered on this node, as jhin.agents records it (D627). */
  let messages = 0;
  const deliver = (
    from: string,
    to: string,
    body: string,
    threadId?: string,
    messageId = `m${messages + 1}`,
  ) => {
    messages += 1;
    return log.append(MESSAGES_STREAM, [
      {
        type: MessageEvents.delivered,
        payload: {
          message: {
            messageId,
            kind: "message",
            from,
            to,
            body,
            traceId: `trace-${messages}`,
            sentAt: new Date().toISOString(),
          },
          ...(threadId === undefined
            ? {}
            : { delivery: { nodeId: "node-a", threadId, queued: false } }),
        } as unknown as Json,
      },
    ]);
  };
  return { client, kernel, log, project, mission, slice, asked, deliver, probe, restart };
}

describe("jhin.health", () => {
  it("warns the narrowest group whose ceremony outgrows progress, and asks the assignee to analyse it", async () => {
    const { client, kernel, log, mission, asked, deliver } = await node({
      ceremony: { ratio: 2, minCeremony: 3 },
    });
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    const analysed = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await deliver(REVIEWER, BUILDER, "Is the floor done?", "t1");
    await deliver(BUILDER, REVIEWER, "Yes, see the proof.");
    await deliver(REVIEWER, BUILDER, "Please add more proof.", "t1");

    const { warning } = (await raised) as { warning: Warning };
    expect(warning).toMatchObject({
      detector: "ceremony",
      group: { kind: "mission", missionId: mission.id, title: "Doghouse" },
      measures: { ceremony: 3, progress: 0, threshold: 3 },
      status: "open",
    });
    expect(warning.evidence.map((ref) => ref.kind)).toEqual(["message", "message", "message"]);

    // The agent with the context: the one assigned the mission's slices, never a random one.
    const { analysis } = (await analysed).payload as { analysis: Analysis };
    expect(analysis).toMatchObject({ status: "answered", analyst: BUILDER, reason: "assignee" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.messageId).toMatch(new RegExp(`^health\\.${warning.warningId}\\.\\d+$`));
    expect(asked[0]!.question).toContain(warning.summary);

    // Its project and the node stay quiet while the mission's warning is open.
    const open = await client.call<Warning[]>("health.warnings.list", {});
    expect(open.map((item) => item.group.kind)).toEqual(["mission"]);

    // The drill-down reads the events behind it back from the log.
    const detail = await client.call<{
      events: { stream: string; payload: { message: { body: string } } }[];
    }>("health.warnings.get", { warningId: warning.warningId });
    expect(detail.events.map((event) => event.payload.message.body)).toEqual([
      "Is the floor done?",
      "Yes, see the proof.",
      "Please add more proof.",
    ]);

    const status = await client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(status.groups.find((group) => group.group.kind === "mission")).toMatchObject({
      ceremony: 3,
      progress: 0,
      byKind: { message: 3 },
    });
  });

  it("counts done slices, merged pull requests and a turn's commits as progress, also after a restart", async () => {
    const { client, log, slice, probe, restart } = await node();
    await client.call("slices.prove", {
      sliceId: slice.id,
      items: [{ kind: "command", command: "vp test run", output: "1 passed" }],
    });
    const merged = log.append(SOURCE_CONTROL_STREAM, [
      {
        type: SourceControlEvents.pullRequestUpdated,
        payload: {
          threadId: "t1",
          pullRequest: { key: "gh:o/r#7", number: 7, snapshot: { state: "merged" } },
        },
      },
    ]);
    await merged;

    // A turn of the slice's thread that commits: its commits are recorded on `health`.
    const repo = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-health-git-"));
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
    const turn = {
      threadId: "t1",
      projectId: slice.projectId,
      turnId: "turn-1",
      agentId: "builder",
      cwd: repo,
    };
    await probe().hooks.run(ThreadHooks.turnStart, turn, (input) => input);
    git("commit", "-q", "--allow-empty", "-m", "one");
    git("commit", "-q", "--allow-empty", "-m", "two");
    const recorded = nextAppended(log, HEALTH_STREAM, HealthEvents.progressRecorded);
    await probe().hooks.run(
      ThreadHooks.turnEnd,
      { ...turn, status: "completed" },
      (input) => input,
    );
    expect(((await recorded).payload as { progress: unknown }).progress).toMatchObject({
      kind: "commit",
      count: 2,
      threadId: "t1",
    });

    // A turn that rewrites history (a reset) and commits on top is no progress of its own.
    const rewrite = { ...turn, turnId: "turn-2" };
    await probe().hooks.run(ThreadHooks.turnStart, rewrite, (input) => input);
    git("reset", "-q", "--hard", "HEAD~2");
    git("commit", "-q", "--allow-empty", "-m", "elsewhere");
    await probe().hooks.run(
      ThreadHooks.turnEnd,
      { ...rewrite, status: "completed" },
      (input) => input,
    );
    const recordedProgress = (await log.read(HEALTH_STREAM)).filter(
      (event) => event.type === HealthEvents.progressRecorded,
    );
    expect(recordedProgress).toHaveLength(1);

    const progress = { ceremony: 0, progress: 4, byKind: { "slice-done": 1, merge: 1, commit: 2 } };
    const status = await client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(status.groups.find((group) => group.group.kind === "mission")).toMatchObject(progress);

    // A restart replays the streams in time order: the commits still count for the mission.
    const again = await restart();
    const replayed = await again.client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(replayed.groups.find((group) => group.group.kind === "mission")).toMatchObject(progress);
  });

  it("warns about a recursive proof loop, and after a dismissal counts the edits since", async () => {
    const { client, kernel, slice } = await node({ proofLoop: { maxEdits: 2 } });
    const prove = (output: string) =>
      client.call("slices.prove", {
        sliceId: slice.id,
        items: [{ kind: "command", command: "vp test run", output }],
      });
    await prove("1 passed");
    await prove("1 passed, again");
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    await prove("1 passed, once more");
    const { warning } = (await raised) as { warning: Warning };
    expect(warning).toMatchObject({
      detector: "proof-loop",
      subject: `slice:${slice.id}`,
      measures: { edits: 2 },
    });
    expect(warning.evidence.map((ref) => ref.kind)).toEqual(["proof-edit", "proof-edit"]);

    await client.call("health.warnings.dismiss", { warningId: warning.warningId });
    // The edits since the dismissal are counted, not the ones before it.
    await prove("1 passed, polished");
    const again = nextEvent(kernel, HealthEvents.warningRaised);
    await prove("1 passed, polished again");
    const { warning: next } = (await again) as { warning: Warning };
    expect(next).toMatchObject({ detector: "proof-loop", measures: { edits: 2 } });
    expect(next.warningId).not.toBe(warning.warningId);
    const all = await client.call<Warning[]>("health.warnings.list", { status: "all" });
    expect(all.map((item) => item.status)).toEqual(["open", "dismissed"]);
  });

  it("detects a corrected idea coming back as a mind virus, naming its carriers", async () => {
    const { client, kernel, log, project, deliver } = await node({
      mindVirus: { minOccurrences: 2 },
    });
    const idea = await client.call<Idea>("health.ideas.correct", {
      idea: "Retry   the flaky test",
      correction: "Fix the race instead.",
      projectId: project.id,
    });
    // The owner repeating the correction is no carrier.
    await deliver(OWNER, BUILDER, "Do not retry the flaky test.", "t1");
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    const analysed = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await deliver(BUILDER, REVIEWER, "I will retry the FLAKY test.", "t1");
    await deliver(REVIEWER, BUILDER, "ok, retry the flaky test then", "t1");
    const { warning } = (await raised) as { warning: Warning };
    expect(warning).toMatchObject({
      detector: "mind-virus",
      subject: `idea:${idea.ideaId}`,
      group: { kind: "project", projectId: project.id },
      measures: { occurrences: 2, carriers: 2 },
    });
    expect(warning.summary).toContain(BUILDER);
    expect(warning.summary).toContain(REVIEWER);
    expect(((await analysed).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "answered",
      analyst: BUILDER,
      reason: "assignee",
    });
  });

  it("asks the configured analyst, and records that none has the context when nobody does", async () => {
    const configured = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": REVIEWER },
    });
    const analysed = nextAppended(configured.log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await configured.deliver(OWNER, BUILDER, "status?", "t1");
    expect(((await analysed).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "answered",
      analyst: REVIEWER,
      reason: "config",
    });

    // Ceremony no mission explains warns the node, and no agent has its context.
    const bare = await node({ ceremony: { ratio: 1, minCeremony: 1 } });
    const none = nextAppended(bare.log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await bare.deliver(OWNER, "jhin://node-a/agents/stranger", "hello");
    expect(((await none).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "none",
    });
    expect(bare.asked).toEqual([]);
  });

  it("counts ceremony after a dismissal from the dismissal on, and takes no message id for health's own", async () => {
    const { client, kernel, deliver } = await node({ ceremony: { ratio: 1, minCeremony: 2 } });
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    await deliver(OWNER, BUILDER, "one", "t1");
    await deliver(OWNER, BUILDER, "two", "t1");
    const { warning } = (await raised) as { warning: Warning };
    expect(warning.measures).toMatchObject({ ceremony: 2 });
    await client.call("health.warnings.dismiss", { warningId: warning.warningId });

    // An id shaped like health's own ask, naming no warning health raised, is ceremony.
    await deliver(OWNER, BUILDER, "three", "t1", `health.${crypto.randomUUID()}.1`);
    const again = nextEvent(kernel, HealthEvents.warningRaised);
    await deliver(OWNER, BUILDER, "four", "t1");
    const { warning: next } = (await again) as { warning: Warning };
    // Only what came after the dismissal: three and four, not one and two.
    expect(next.measures).toMatchObject({ ceremony: 2 });
    expect(next.warningId).not.toBe(warning.warningId);
  });

  it("keeps the last good thresholds while a config layer is invalid", async () => {
    const { client, kernel } = await node({ windowHours: 12 });
    kernel.config.setLayer("project", { "jhin.health": { windowHours: -1 } });
    const status = await client.call<{ windowHours: number }>("health.status", {});
    expect(status.windowHours).toBe(12);
  });
});
