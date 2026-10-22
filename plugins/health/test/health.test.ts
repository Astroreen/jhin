import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  MESSAGES_STREAM,
  MessageEvents,
  ThreadEvents,
  ThreadHooks,
  threadStream,
} from "@jhin/agent-api";
import {
  COMMITS_COUNTED_EVENT,
  HEALTH_STREAM,
  HealthEvents,
  type Analysis,
  type GroupStatus,
  type Idea,
  type Warning,
} from "@jhin/health-api";
import type { Mission, Slice } from "@jhin/missions-api";
import { LIVE_STREAMS_CAPABILITY, createLiveStreams, type LiveStreams } from "@jhin/rpc";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
const SILENT = "jhin://node-a/agents/silent";
const BROKEN = "jhin://node-a/agents/broken";
const ONCE = "jhin://node-a/agents/once";
const PENDING = "jhin://node-a/agents/pending";
/** Who waits for the next ask health makes: a fact, not a wait. */
const askWaiters: ((ask: Asked) => void)[] = [];
const nextAsk = () => new Promise<Asked>((resolve) => askWaiters.push(resolve));

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
        manifest: testManifest("test.agents", {
          side: "server",
          optional: { [LIVE_STREAMS_CAPABILITY]: "^1.1" },
        }),
        definition: definePlugin({
          activate(context) {
            probe = context;
            // Guards the messages as jhin.agents does (D628).
            context.subscriptions.add(
              context.services
                .tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY)!
                .guard(MESSAGES_STREAM, ["agents.read"]),
            );
            context.commands.register({
              name: "agents.ask",
              description: "Answers as the analyst would",
              input: z.object({
                to: z.string(),
                question: z.string(),
                messageId: z.string().optional(),
              }),
              output: z.object({ status: z.string(), answer: z.string().optional() }),
              handler: (input) => {
                asked.push(input);
                for (const waiter of askWaiters.splice(0)) waiter(input);
                // An analyst that never answers, one whose ask fails, and one
                // that answers only from its second ask on.
                if (input.to === SILENT) return new Promise<never>(() => {});
                if (input.to === ONCE && asked.filter((ask) => ask.to === ONCE).length === 1) {
                  return new Promise<never>(() => {});
                }
                if (input.to === BROKEN) throw new Error("the analyst is gone");
                if (input.to === PENDING) return { status: "pending" };
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
  const restart = async (config = health_) => {
    await stop();
    return start(storage, data, config, asked);
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
    kind: "message" | "ask" = "message",
    inReplyTo?: string,
  ) => {
    messages += 1;
    return log.append(MESSAGES_STREAM, [
      {
        type: MessageEvents.delivered,
        payload: {
          message: {
            messageId,
            kind,
            ...(inReplyTo === undefined ? {} : { inReplyTo }),
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

    // An agent holds health.read, not agents.read: the drill-down withholds the bodies.
    const agentView = (await kernel.commands.execute(
      "health.warnings.get",
      { warningId: warning.warningId },
      { caller: { id: "agent", permissions: ["health.read"] } },
    )) as { events: { payload: unknown; withheld?: string }[] };
    expect(agentView.events.map((event) => [event.payload, event.withheld])).toEqual([
      [null, "agents.read"],
      [null, "agents.read"],
      [null, "agents.read"],
    ]);

    const status = await client.call<{ groups: GroupStatus[] }>("health.status", {});
    expect(status.groups.find((group) => group.group.kind === "mission")).toMatchObject({
      ceremony: 3,
      progress: 0,
      byKind: { message: 3 },
    });
  });

  it("counts done slices, merged pull requests and a turn's commits as progress, also after a restart", async () => {
    const { client, kernel, log, slice, probe, restart } = await node();
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
    const counted = nextEvent(kernel, COMMITS_COUNTED_EVENT);
    await probe().hooks.run(
      ThreadHooks.turnEnd,
      { ...rewrite, status: "completed" },
      (input) => input,
    );
    expect(await counted).toEqual({ turnId: "turn-2", count: 0 });
    const recordedProgress = (await log.read(HEALTH_STREAM)).filter(
      (event) => event.type === HealthEvents.progressRecorded,
    );
    expect(recordedProgress).toHaveLength(1);

    // The turn with two commits is one piece of progress (D723).
    const progress = { ceremony: 0, progress: 3, byKind: { "slice-done": 1, merge: 1, commit: 1 } };
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
    // The same cause again, and still one warning: the mission's, not its project's or the node's.
    expect(next.subject).toBe(warning.subject);
    const open = await client.call<Warning[]>("health.warnings.list", { status: "all" });
    expect(open.map((item) => item.group.kind)).toEqual(["mission", "mission"]);
  });

  it("keeps the last good thresholds while a config layer is invalid", async () => {
    const { client, kernel } = await node({ windowHours: 12 });
    kernel.config.setLayer("project", { "jhin.health": { windowHours: -1 } });
    const status = await client.call<{ windowHours: number }>("health.status", {});
    expect(status.windowHours).toBe(12);
  });

  it("records a failed analysis when the ask fails or outlasts its timeout", async () => {
    const broken = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": BROKEN },
    });
    const failed = nextAppended(broken.log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await broken.deliver(OWNER, BUILDER, "status?", "t1");
    expect(((await failed).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "failed",
      analyst: BROKEN,
      error: "the analyst is gone",
    });

    // The timeout fires on a faked clock: the test waits for facts, not time.
    const silent = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": SILENT },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const asking = nextAsk();
      const timedOut = nextAppended(silent.log, HEALTH_STREAM, HealthEvents.warningAnalysed);
      await silent.deliver(OWNER, BUILDER, "status?", "t1");
      await asking;
      vi.advanceTimersByTime(30 * 60_000);
      expect(((await timedOut).payload as { analysis: Analysis }).analysis).toMatchObject({
        status: "failed",
        analyst: SILENT,
        error: "no answer within 30 minutes",
      });
    } finally {
      vi.useRealTimers();
    }

    // An ask that only waits (`pending`) is no answer either.
    const pending = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": PENDING },
    });
    const waits = nextAppended(pending.log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await pending.deliver(OWNER, BUILDER, "status?", "t1");
    expect(((await waits).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "failed",
      error: "the ask is pending, not answered",
    });
  });

  it("asks an agent, never the owner, and does not count the analyst's reply", async () => {
    const { kernel, client, deliver, asked } = await node({
      ceremony: { ratio: 1, minCeremony: 2 },
      analysts: { "*": OWNER },
    });
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    const asking = nextAsk();
    await deliver(OWNER, BUILDER, "one", "t1");
    await deliver(OWNER, BUILDER, "two", "t1");
    const { warning } = (await raised) as { warning: Warning };
    // The owner configured as analyst is no agent: the mission's assignee is asked.
    expect((await asking).to).toBe(BUILDER);
    await client.call("health.warnings.dismiss", { warningId: warning.warningId });
    const again = nextEvent(kernel, HealthEvents.warningRaised);
    // Health's ask is delivered (jhin.agents records it, D627).
    await deliver(OWNER, BUILDER, asked[0]!.question, "t-ask", asked[0]!.messageId, "ask");
    // The analyst replies to it: health's own conversation, not ceremony.
    await deliver(BUILDER, OWNER, "the reviews loop", "t1", "r1", "message", asked[0]!.messageId);
    const [three] = await deliver(OWNER, BUILDER, "three", "t1");
    const [four] = await deliver(OWNER, BUILDER, "four", "t1");
    // Counted, the reply would have raised it with "three"; it is raised with "three" and "four".
    const next = ((await again) as { warning: Warning }).warning;
    expect(next.evidence.map((ref) => ref.sequence)).toEqual([three!.sequence, four!.sequence]);

    // A second "reply" naming the same ask, or one naming an ask never delivered,
    // is an ordinary message: only the first reply to a delivered ask is health's.
    const third = nextEvent(kernel, HealthEvents.warningRaised);
    await client.call("health.warnings.dismiss", { warningId: next.warningId });
    await deliver(BUILDER, OWNER, "again", "t1", "r2", "message", asked[0]!.messageId);
    await deliver(BUILDER, OWNER, "forged", "t1", "r3", "message", `health.${next.warningId}.1`);
    expect(((await third) as { warning: Warning }).warning.measures).toMatchObject({
      ceremony: 2,
    });
  });

  it("takes only the owner's ask with health's id as health's own, not an agent's copy of it", async () => {
    const { kernel, client, deliver } = await node({ ceremony: { ratio: 1, minCeremony: 2 } });
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    await deliver(OWNER, BUILDER, "one", "t1");
    await deliver(OWNER, BUILDER, "two", "t1");
    const { warning } = (await raised) as { warning: Warning };
    await client.call("health.warnings.dismiss", { warningId: warning.warningId });
    const again = nextEvent(kernel, HealthEvents.warningRaised);
    // An agent copies the id of health's ask: still ceremony, so with one more it warns again.
    await deliver(
      REVIEWER,
      BUILDER,
      "about the warning",
      "t1",
      `health.${warning.warningId}.1`,
      "ask",
    );
    await deliver(OWNER, BUILDER, "three", "t1");
    expect(((await again) as { warning: Warning }).warning.measures).toMatchObject({ ceremony: 2 });
  });

  it("asks again after a restart cut an ask short before it reached the analyst", async () => {
    const { kernel, log, deliver, asked, restart } = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": ONCE },
    });
    const first = nextAsk();
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    await deliver(OWNER, BUILDER, "status?", "t1");
    await raised;
    await first;
    const analysed = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await restart();
    expect(((await analysed).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "answered",
      analyst: ONCE,
    });
    expect(asked.filter((ask) => ask.to === ONCE)).toHaveLength(2);
  });

  it("does not ask twice when the cut-short ask had reached the analyst", async () => {
    const { kernel, log, deliver, asked, restart } = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": ONCE },
    });
    const first = nextAsk();
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    await deliver(OWNER, BUILDER, "status?", "t1");
    const { warning } = (await raised) as { warning: Warning };
    const ask = await first;
    // The ask was delivered (jhin.agents records it, D627) before the restart.
    await deliver(OWNER, ONCE, ask.question, "t-once", ask.messageId, "ask");
    const analysed = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await restart();
    expect((await analysed).payload as { warningId: string; analysis: Analysis }).toMatchObject({
      warningId: warning.warningId,
      analysis: { status: "failed", analyst: ONCE, error: expect.stringMatching(/cut short/) },
    });
    expect(asked.filter((item) => item.to === ONCE)).toHaveLength(1);
  });

  it("asks no analyst while health is turned off, also after a restart", async () => {
    const { kernel, deliver, asked, restart, log } = await node({
      ceremony: { ratio: 1, minCeremony: 1 },
      analysts: { "*": ONCE },
    });
    const first = nextAsk();
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    await deliver(OWNER, BUILDER, "status?", "t1");
    await raised;
    await first;
    // Turned off, then restarted: the open warning without an analysis is not asked again.
    const again = await restart({ enabled: false, analysts: { "*": ONCE } });
    await again.client.call("health.status", {});
    expect(asked.filter((ask) => ask.to === ONCE)).toHaveLength(1);
    const analysed = (await log.read(HEALTH_STREAM)).filter(
      (event) => event.type === HealthEvents.warningAnalysed,
    );
    expect(analysed).toEqual([]);
  });

  it("counts an agent's spec carrying a corrected idea, not the owner's note about it", async () => {
    const { client, kernel, project, slice, deliver } = await node({
      mindVirus: { minOccurrences: 2 },
    });
    await client.call("health.ideas.correct", {
      idea: "retry the flaky test",
      projectId: project.id,
    });
    // The owner's note quotes the idea to forbid it: the correction, not a carrier.
    await client.call("slices.update", {
      sliceId: slice.id,
      spec: "The floor holds the dog. Do not retry the flaky test.",
    });
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    const agent = { caller: { id: "jhin.agent-fake:t1", permissions: ["missions.write"] } };
    await kernel.commands.execute(
      "slices.update",
      { sliceId: slice.id, spec: "The floor holds the dog; retry the flaky test until green." },
      agent,
    );
    await deliver(BUILDER, REVIEWER, "I will retry the flaky test", "t1");
    const { warning } = (await raised) as { warning: Warning };
    expect(warning.measures).toMatchObject({ occurrences: 2, carriers: 2 });
    expect(warning.summary).toContain("jhin.agent-fake:t1");
    expect(warning.summary).not.toContain("owner");
  });

  it("takes a corrected idea of two words at least, so one word does not match everything", async () => {
    const { client } = await node();
    await expect(client.call("health.ideas.correct", { idea: "fix" })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
    await expect(client.call("health.ideas.correct", { idea: "fix it" })).resolves.toMatchObject({
      idea: "fix it",
    });
  });

  it("asks the analyst when health activates on a node that has already started", async () => {
    const { kernel, log, deliver } = await node({ ceremony: { ratio: 1, minCeremony: 1 } });
    // A reload activates health again after kernel.started has fired.
    await kernel.reload("jhin.health");
    const analysed = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await deliver(OWNER, BUILDER, "status?", "t1");
    expect(((await analysed).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "answered",
      analyst: BUILDER,
    });
  });

  it("asks an analyst named in the config later for a warning nobody could analyse", async () => {
    const thresholds = { ceremony: { ratio: 1, minCeremony: 1 } };
    const { kernel, log, deliver } = await node(thresholds);
    const none = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    await deliver(OWNER, "jhin://node-a/agents/stranger", "hello");
    expect(((await none).payload as { analysis: Analysis }).analysis.status).toBe("none");
    const answered = nextAppended(log, HEALTH_STREAM, HealthEvents.warningAnalysed);
    kernel.config.setLayer("project", {
      "jhin.health": { ...thresholds, analysts: { "*": REVIEWER } },
    });
    expect(((await answered).payload as { analysis: Analysis }).analysis).toMatchObject({
      status: "answered",
      analyst: REVIEWER,
      reason: "config",
    });
  });

  it("leaves a thread no slice links any more, and goes on where it left it when linked again", async () => {
    const { client, log, slice } = await node();
    const queue = () =>
      log.append(threadStream("t1"), [{ type: ThreadEvents.queueUpdated, payload: {} as Json }]);
    const nodeCeremony = async () =>
      (await client.call<{ groups: GroupStatus[] }>("health.status", {})).groups.find(
        (group) => group.group.kind === "node",
      )?.ceremony ?? 0;
    await queue();
    expect(await nodeCeremony()).toBe(1);
    await client.call("slices.unlink", { sliceId: slice.id, threadId: "t1" });
    await queue();
    // Unlinked: no longer followed, so its queue changes count nowhere.
    expect(await nodeCeremony()).toBe(1);
    await client.call("slices.link", { sliceId: slice.id, threadId: "t1" });
    const counted = nextAppended(log, threadStream("t1"), ThreadEvents.queueUpdated);
    await queue();
    await counted;
    // Linked again: read on from where it was left. The change made while it
    // was unlinked is read now, and the first is not counted twice (3, not 4).
    expect(await nodeCeremony()).toBe(3);
  });

  it("checks a corrected idea's project, takes the same idea once, and withdraws one named by mistake", async () => {
    const { client, project, deliver } = await node({ mindVirus: { minOccurrences: 1 } });
    await expect(
      client.call("health.ideas.correct", { idea: "retry the flaky test", projectId: "no-such" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const idea = await client.call<Idea>("health.ideas.correct", {
      idea: "retry the flaky test",
      projectId: project.id,
    });
    const again = await client.call<Idea>("health.ideas.correct", {
      idea: "Retry the  FLAKY test.",
      projectId: project.id,
    });
    expect(again.ideaId).toBe(idea.ideaId);
    // Two calls at once with a new phrase make one idea.
    const [first, second] = await Promise.all([
      client.call<Idea>("health.ideas.correct", { idea: "skip the review", projectId: project.id }),
      client.call<Idea>("health.ideas.correct", { idea: "Skip the review", projectId: project.id }),
    ]);
    expect(second.ideaId).toBe(first.ideaId);
    await client.call("health.ideas.withdraw", { ideaId: first.ideaId });
    await client.call("health.ideas.withdraw", { ideaId: idea.ideaId });
    expect(await client.call<Idea[]>("health.ideas.list", {})).toEqual([]);
    await expect(
      client.call("health.ideas.withdraw", { ideaId: idea.ideaId }),
    ).rejects.toMatchObject({ code: "IDEA_NOT_FOUND" });
    // Withdrawn, the phrase is no carrier any more: a message with it raises nothing,
    // and the status shows only the message's ceremony.
    await deliver(BUILDER, REVIEWER, "I will retry the flaky test", "t1");
    const warnings = await client.call<Warning[]>("health.warnings.list", { status: "all" });
    expect(warnings.filter((warning) => warning.detector === "mind-virus")).toEqual([]);
  });

  it("counts the commits of a turn whose thread a slice links during the turn", async () => {
    const { client, kernel, slice, probe } = await node();
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
    // A fresh thread, not linked when its turn starts.
    const turn = {
      threadId: "t9",
      projectId: slice.projectId,
      turnId: "turn-9",
      agentId: "builder",
      cwd: repo,
    };
    await probe().hooks.run(ThreadHooks.turnStart, turn, (input) => input);
    await client.call("slices.link", { sliceId: slice.id, threadId: "t9" });
    git("commit", "-q", "--allow-empty", "-m", "work");
    const counted = nextEvent(kernel, COMMITS_COUNTED_EVENT);
    await probe().hooks.run(
      ThreadHooks.turnEnd,
      { ...turn, status: "completed" },
      (input) => input,
    );
    expect(await counted).toEqual({ turnId: "turn-9", count: 1 });
  });

  it("evaluates again at once when the thresholds change", async () => {
    const { kernel, deliver } = await node({ ceremony: { ratio: 1, minCeremony: 5 } });
    await deliver(OWNER, BUILDER, "one", "t1");
    await deliver(OWNER, BUILDER, "two", "t1");
    // Under 5: nothing yet. Lowered to 2, the same two messages warn with no new event.
    const raised = nextEvent(kernel, HealthEvents.warningRaised);
    kernel.config.setLayer("project", {
      "jhin.health": { ceremony: { ratio: 1, minCeremony: 2 } },
    });
    expect(((await raised) as { warning: Warning }).warning.measures).toMatchObject({
      ceremony: 2,
    });
  });
});
