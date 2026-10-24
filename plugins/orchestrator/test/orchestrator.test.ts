import * as Fs from "node:fs";

import {
  INBOX_STREAM,
  MESSAGES_STREAM,
  MessageEvents,
  ThreadEvents,
  threadAddress,
  threadStream,
} from "@jhin/agent-api";
import {
  MISSIONS_STREAM,
  missionProgress,
  reviewCheck,
  type Mission,
  type Slice,
} from "@jhin/missions-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, z } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { node as agentsNode, watch } from "../../agents/test/support.ts";
import missions from "../../missions/src/index.ts";
import orchestration from "../../orchestration/src/index.ts";
import orchestrator from "../src/index.ts";
import { REVIEW_BRIEF_LENGTH, owningPlans, reviewBriefText } from "../src/review.ts";

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

/**
 * `git.tree` as jhin.source-control answers it, over files the test changes:
 * `files.tree` is the tree of every path now.
 */
function fakeGit() {
  const files = { tree: "tree-1" };
  /** The `exclude` of every call, so a test sees what the review leaves out (D1261). */
  const excluded: (string[] | undefined)[] = [];
  return {
    files,
    excluded,
    plugin: {
      manifest: {
        id: "test.git",
        version: "1.0.0",
        apiVersion: 1,
        side: "server",
        entry: "index.js",
      },
      definition: definePlugin({
        activate(context) {
          context.commands.register({
            name: "git.tree",
            description: "The fake files' tree",
            input: z.object({
              projectId: z.string().optional(),
              threadId: z.string().optional(),
              exclude: z.array(z.string()).optional(),
            }),
            output: z.object({ projectId: z.string(), path: z.string(), tree: z.string() }),
            handler: ({ projectId, threadId, exclude }) => {
              excluded.push(exclude);
              return {
                projectId: projectId ?? "p",
                path: threadId === undefined ? "/project" : `/worktrees/${threadId}`,
                tree: files.tree,
              };
            },
          });
        },
      }),
    },
  };
}

/** The context library, lore and diffs a reviewer's brief is built from (D1244). */
function fakeLibrary() {
  const read: string[] = [];
  return {
    read,
    plugin: {
      manifest: {
        id: "test.library",
        version: "1.0.0",
        apiVersion: 1,
        side: "server",
        entry: "index.js",
      },
      definition: definePlugin({
        activate(context) {
          const any = z.object({}).loose();
          const register = (name: string, handler: (input: any) => unknown) =>
            context.commands.register({
              name,
              description: name,
              input: any,
              output: z.unknown(),
              handler,
            });
          register("context.map", () => ({
            map: "docs/map.md",
            trailhead: "AGENTS.md",
            content:
              "| `jhin.kennel` | the kennel | `kennel.*` | `plans/doghouse.md#walls` |\n| `jhin.other` | | | `plans/other.md` |",
          }));
          register("context.read", ({ path }) => {
            read.push(path);
            return {
              content:
                path === "AGENTS.md"
                  ? "8. **Ids are public API.** Never renamed without a deprecation."
                  : `${path}: D7. Walls are wood.`,
            };
          });
          register("lore.brief", () => ({ markdown: "- moonbase: walk back up to the intent" }));
          register("git.diff", ({ scope }) => ({
            scope,
            baseRef: "main",
            patch: "+++ b/plugins/kennel/src/walls.ts\n+export const walls = 4;\n",
            files: [{ path: "plugins/kennel/src/walls.ts", insertions: 1, deletions: 0 }],
          }));
        },
      }),
    },
  };
}

async function node(config: Record<string, unknown> = {}, more: { plugins?: any[] } = {}) {
  const started = await agentsNode({
    agents: { builder: { title: "Builder", role: "Builds slices", runtime: "jhin.agent-fake" } },
    project: { "jhin.orchestrator": { refocusEveryTurns: 0, ...config } },
    plugins: [
      ...(more.plugins ?? []),
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
    // An assignee of another node is ready too: the mesh delivers it (D1541). This
    // node has no mesh, so the send fails and the slice stays planned.
    const far = await slice({ title: "Bowl", assignee: "jhin://node-b/agents/x" });
    expect(missionProgress([far]).ready).toEqual([far.id]);
    await expect(client.call("slices.handoff", { sliceId: far.id })).rejects.toThrow("mesh.call");
    expect(await client.call("slices.get", { sliceId: far.id })).toMatchObject({
      status: "planned",
    });
  });
});

describe("review after the last change (D1241–D1243)", () => {
  const at = (n: number) => `2026-10-21T00:00:0${n}.000Z`;
  const record = (id: string, fields: Partial<Slice>): Slice => ({
    id,
    missionId: "m",
    projectId: "p",
    title: id,
    spec: "",
    wave: 1,
    dependsOn: [],
    status: "done",
    threads: [],
    proof: { items: [{ kind: "link", url: "https://example.com" }], recordedAt: at(1) },
    createdAt: at(Number(id.slice(1))),
    updatedAt: at(0),
    ...fields,
  });
  const work = (tree: string) => ({ projectId: "p", path: "/w", tree });

  it("checks each done slice against the latest review of the files it lives in", () => {
    const trees = new Map([["/w", "t2"]]);
    expect(
      reviewCheck(
        [
          record("s1", {}),
          record("s2", { review: { verdict: "approved", recordedAt: at(2), work: work("t1") } }),
          // A later review of the same files covers s2 too: nothing changed since.
          record("s3", { review: { verdict: "approved", recordedAt: at(3), work: work("t2") } }),
          record("s4", { review: { verdict: "changes-requested", recordedAt: at(3) } }),
          // Proved again after its review.
          record("s5", {
            proof: { items: [{ kind: "link", url: "https://example.com" }], recordedAt: at(5) },
            review: { verdict: "approved", recordedAt: at(4) },
          }),
          // A review slice needs no review; an open slice none yet.
          record("s6", { wave: 2, reviews: ["s3"] }),
          record("s7", { status: "active", proof: undefined }),
        ],
        trees,
      ),
    ).toEqual({
      clear: false,
      unreviewed: [
        { sliceId: "s1", reason: "unreviewed" },
        { sliceId: "s4", reason: "changes-requested" },
        { sliceId: "s5", reason: "changed-after-review" },
      ],
    });
    // The files changed after the latest review, by anyone: both slices living there.
    const reviewed = [
      record("s2", { review: { verdict: "approved", recordedAt: at(2), work: work("t1") } }),
      record("s3", { review: { verdict: "approved", recordedAt: at(3), work: work("t2") } }),
    ];
    expect(reviewCheck(reviewed, trees)).toEqual({ clear: true, unreviewed: [] });
    expect(reviewCheck(reviewed, new Map([["/w", "t3"]])).unreviewed).toEqual([
      { sliceId: "s2", reason: "changed-after-review", path: "/w" },
      { sliceId: "s3", reason: "changed-after-review", path: "/w" },
    ]);
    expect(reviewCheck(reviewed, new Map()).unreviewed[0]).toMatchObject({
      reason: "work-unknown",
    });
  });

  it("refuses a step that needs a review until the slices were reviewed after the last change", async () => {
    const git = fakeGit();
    const { client, kernel, mission, slice } = await node({}, { plugins: [git.plugin] });
    const walls = await slice({ title: "Walls", assignee: BUILDER });
    const review = await slice({ title: "Review walls", wave: 2, reviews: [walls.id] });
    expect(review).toMatchObject({ wave: 2, reviews: [walls.id] });
    await prove(client, walls.id);
    const merge = () =>
      client.call<Mission>("missions.update", { missionId: mission.id, step: "merge" });

    // merge needs a review by default; walls has none.
    await expect(merge()).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
      details: { step: "merge", unreviewed: [{ sliceId: walls.id, reason: "unreviewed" }] },
    });
    // The reviewer asks for changes, then approves; the review slice itself needs none.
    const reviewer = { caller: AGENT };
    await kernel.commands.execute(
      "slices.review",
      { sliceId: walls.id, verdict: "changes-requested", notes: "Checked AGENTS.md rule 8" },
      reviewer,
    );
    await expect(merge()).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const approved = (await kernel.commands.execute(
      "slices.review",
      { sliceId: walls.id, verdict: "approved" },
      reviewer,
    )) as Slice;
    expect(approved.review).toMatchObject({
      verdict: "approved",
      by: AGENT.id,
      work: { path: "/project", tree: "tree-1" },
    });
    await prove(client, review.id);
    expect(await merge()).toMatchObject({ step: "merge" });
    // The review and the check leave the agents' knowledge out of the tree (D1261).
    expect(git.excluded.length).toBeGreaterThan(1);
    expect(git.excluded.every((exclude) => exclude?.join() === ".jhin/agents")).toBe(true);

    // The lead changes the files after the review: taking the step again is refused.
    git.files.tree = "tree-2";
    expect(
      await client.call("missions.review.check", { missionId: mission.id, step: "merge" }),
    ).toEqual({
      needed: true,
      clear: false,
      unreviewed: [{ sliceId: walls.id, reason: "changed-after-review", path: "/project" }],
    });
    await expect(merge()).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await client.call("slices.review", { sliceId: walls.id, verdict: "approved" });
    expect(await merge()).toMatchObject({ step: "merge" });

    // A step of no process is invalid; one that needs no review is taken as it is.
    await expect(
      client.call("missions.update", { missionId: mission.id, step: "deploy" }),
    ).rejects.toMatchObject({ code: "MISSION_STEP_INVALID" });
    git.files.tree = "tree-3";
    const process = { slice: mission.process.slice, mission: [{ id: "demo" }, { id: "merge" }] };
    expect(
      await client.call("missions.update", { missionId: mission.id, process, step: "demo" }),
    ).toMatchObject({ step: "demo" });
  });

  it("takes the steps that need a review from the config and the process", async () => {
    const { client, mission, slice } = await node({ reviewSteps: ["ship"] });
    const walls = await slice({ title: "Walls", assignee: BUILDER });
    // A slice reviews only slices of earlier waves.
    await expect(slice({ title: "Review", wave: 1, reviews: [walls.id] })).rejects.toMatchObject({
      code: "SLICE_ORDER_INVALID",
    });
    await prove(client, walls.id);
    await client.call("missions.update", {
      missionId: mission.id,
      process: {
        slice: mission.process.slice,
        mission: [{ id: "merge" }, { id: "ship" }, { id: "deploy", review: true }],
      },
    });
    const step = (id: string) =>
      client.call("missions.update", { missionId: mission.id, step: id });
    expect(await step("merge")).toMatchObject({ step: "merge" });
    await expect(step("ship")).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await expect(step("deploy")).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    // Without git.tree a review is checked by its time alone.
    await client.call("slices.review", { sliceId: walls.id, verdict: "approved" });
    expect(await step("deploy")).toMatchObject({ step: "deploy" });
  });
});

describe("the reviewer's brief (D1244–D1246)", () => {
  it("finds the plans that own the changed files through the map", () => {
    const map = [
      "| `@jhin/missions-api` | missions | `plans/agents.md#a3-missions` |",
      "| `jhin.orchestrator` | runs missions | `plans/agents.md#a6-orchestration` |",
      "| `missions` | `jhin.missions-view` | `plans/agents.md#a3-missions` D653 |",
      "| `jhin.terminal` | terminals | `plans/terminal.md` |",
    ].join("\n");
    expect(
      owningPlans(map, "docs/map.md", [
        "packages/missions-api/src/index.ts",
        "plugins/orchestrator/src/index.ts",
        "apps/web/src/plugins/missions/edit.tsx",
        "docs/plans/source-control.md",
        "README.md",
      ]),
    ).toEqual([
      "docs/plans/source-control.md",
      "docs/plans/agents.md#a3-missions",
      "docs/plans/agents.md#a6-orchestration",
    ]);
  });

  it("puts the project first and the lead's notes after it, within one message", () => {
    const at = "2026-10-21T00:00:00.000Z";
    const slice = (id: string, spec: string): Slice => ({
      id,
      missionId: "m",
      projectId: "p",
      title: id,
      spec,
      wave: 1,
      dependsOn: [],
      status: "done",
      threads: [],
      createdAt: at,
      updatedAt: at,
    });
    const brief = reviewBriefText({
      slice: { ...slice("review", "Check that no dead import is left"), reviews: ["walls"] },
      rules: { address: "AGENTS.md", text: "Rule 8: ids are public API." },
      plans: [{ address: "docs/plans/doghouse.md", missing: "context.read failed: gone" }],
      lore: { address: "lore.brief", text: "- own homework" },
      work: [
        {
          slice: slice("walls", "Four walls"),
          diff: {
            scope: "branch",
            baseRef: "main",
            patch: `+${"x".repeat(100_000)}\n`,
            files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
          },
        },
      ],
    });
    const order = [
      "should this be done at all?",
      "## The project's rules",
      "Rule 8: ids are public API.",
      "(`docs/plans/doghouse.md`: context.read failed: gone)",
      "- own homework",
      "### walls",
      "- a.ts (+1 −0)",
      "## The lead's notes",
      "Check that no dead import is left",
      "## The diff",
      "[… cut here: read the rest at `git_diff for slice walls",
    ].map((text) => brief.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(brief.length).toBeLessThanOrEqual(REVIEW_BRIEF_LENGTH);
  });

  it("hands a review slice the project, the diff and then the lead's notes", async () => {
    const library = fakeLibrary();
    const { client, slice } = await node({}, { plugins: [library.plugin] });
    const walls = await slice({ title: "Walls", assignee: BUILDER });
    await prove(client, walls.id);
    const review = await slice({
      title: "Review walls",
      spec: "Check that no dead import is left",
      assignee: BUILDER,
      reviews: [walls.id],
    });
    const { markdown, sources } = await client.call<{
      markdown: string;
      sources: { address: string }[];
    }>("review.brief", { sliceId: review.id });
    expect(sources.map((source) => source.address)).toEqual([
      "AGENTS.md",
      "docs/plans/doghouse.md#walls",
      "lore.brief",
    ]);
    for (const text of [
      "Ids are public API",
      "docs/plans/doghouse.md#walls: D7. Walls are wood.",
      "moonbase",
      "plugins/kennel/src/walls.ts (+1 −0)",
      "+export const walls = 4;",
      // The reviewed slice names who built it (D1266).
      `Built by ${BUILDER}.`,
    ])
      expect(markdown).toContain(text);
    expect(markdown.indexOf("Ids are public API")).toBeLessThan(
      markdown.indexOf("Check that no dead import is left"),
    );
    await expect(client.call("review.brief", { sliceId: walls.id })).rejects.toMatchObject({
      code: "NOT_A_REVIEW",
    });

    const handed = await client.call<{ threadId: string }>("slices.handoff", {
      sliceId: review.id,
    });
    const turn = await watch(client, threadStream(handed.threadId)).until(ThreadEvents.turnStarted);
    const text = payloadOf(turn).input.text as string;
    expect(text).toContain("[Slice handed to you]");
    expect(text).toContain("[Review handed to you]");
    expect(text).toContain("Ids are public API");
    expect(text).toContain("+export const walls = 4;");
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
    // A mission being orchestrated is not deleted, nor its slices (D1395).
    await expect(client.call("missions.delete", { missionId: mission.id })).rejects.toMatchObject({
      code: "RUN_ACTIVE",
    });
    await expect(client.call("slices.delete", { sliceId: paint.id })).rejects.toMatchObject({
      code: "RUN_ACTIVE",
    });
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
    // Its run over, the mission can be deleted; the stopped run's record stays behind (D1395).
    await client.call("missions.delete", { missionId: mission.id });
    await expect(
      client.call("missions.orchestration", { missionId: mission.id }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
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

describe("the lead reports to the owner (L1: D1222, D1223)", () => {
  /** A lead's thread that has run the mission's orchestrator once. */
  async function led(fields: Record<string, unknown>[]) {
    const started = await node();
    const { client, slice, mission } = started;
    const lead = await client.call<{ id: string }>("threads.create", {
      title: "Lead",
      runtimeMode: "full-access",
    });
    const slices: Slice[] = [];
    for (const item of fields) slices.push(await slice(item));
    const workflows = watch(client, "orchestration");
    const inbox = watch(client, INBOX_STREAM);
    const orchestrate = () =>
      client.call<{ workflowId: string }>("missions.orchestrate", {
        missionId: mission.id,
        parentThreadId: lead.id,
      });
    const reportOf = (end: string) =>
      inbox
        .untilMatch(
          (event) =>
            event.type === MessageEvents.received &&
            String(payloadOf(event).message.messageId).startsWith(`report-${mission.id}-${end}`),
        )
        .then((event) => payloadOf(event).message as { from: string; to: string; body: string });
    return { ...started, lead, slices, workflows, inbox, orchestrate, reportOf };
  }

  it("sends the owner the lead's report when the lead closes the mission", async () => {
    const { client, mission, lead, slices, workflows, orchestrate, reportOf } = await led([
      { title: "Walls", assignee: BUILDER },
    ]);
    const missionsFeed = watch(client, MISSIONS_STREAM);
    const run = await orchestrate();
    await sliceBecomes(missionsFeed, slices[0]!.id, "active");
    await prove(client, slices[0]!.id);
    expect(await workflowEnds(workflows, run.workflowId)).toMatchObject({
      result: { outcome: "slices-done", note: expect.stringContaining("missions.close") },
    });
    await client.call("missions.close", {
      missionId: mission.id,
      status: "done",
      summary: "Committed as abc1234 on main.",
    });
    const report = await reportOf("done");
    // From the lead's thread to the owner's inbox, so the Lead view shows it too.
    expect(report).toMatchObject({ from: threadAddress("node-a", lead.id), to: OWNER });
    expect(report.body).toContain("Mission report: Doghouse, done");
    expect(report.body).toContain("Committed as abc1234 on main.");
    expect(report.body).toContain("#### Walls");
    expect(report.body).toContain("$ look\nit stands");
    await expect(
      client.call("missions.close", { missionId: mission.id, status: "dropped" }),
    ).rejects.toMatchObject({ code: "MISSION_CLOSED" });
  });

  it("reports a closed mission without the lead's word, and a run that was stopped", async () => {
    const { client, mission, lead, slices, workflows, orchestrate, reportOf } = await led([
      { title: "Walls", assignee: BUILDER },
    ]);
    const missionsFeed = watch(client, MISSIONS_STREAM);
    const run = await orchestrate();
    await sliceBecomes(missionsFeed, slices[0]!.id, "active");
    await client.call("workflows.stop", { workflowId: run.workflowId, parentThreadId: lead.id });
    expect(await workflowEnds(workflows, run.workflowId)).toMatchObject({ status: "stopped" });
    const stopped = await reportOf(`${run.workflowId}`);
    expect(stopped.body).toContain("Doghouse, its orchestrator was stopped");
    expect(stopped.body).toContain("The mission is still open");

    await client.call("missions.update", { missionId: mission.id, status: "dropped" });
    const dropped = await reportOf("dropped");
    expect(dropped.body).toContain("Doghouse, dropped");
    expect(dropped.body).toContain("The lead said nothing about it");
  });

  it("holds the mission while the lead's ask to the owner is open", async () => {
    const { client, kernel, mission, lead, slices, workflows, orchestrate } = await led([
      { title: "Door" },
    ]);
    const door = slices[0]!;
    // The first run finds the door unassigned: the thread it ran from is the lead.
    const first = await orchestrate();
    expect(await workflowEnds(workflows, first.workflowId)).toMatchObject({
      result: { outcome: "decide" },
    });
    // Another thread's open ask does not hold this mission.
    const other = await client.call<{ id: string }>("threads.create", { title: "Other" });
    await kernel.commands.execute(
      "agents.ask",
      { to: OWNER, question: "Unrelated?" },
      { caller: AGENT, threadId: other.id },
    );
    const asked = (await kernel.commands.execute(
      "agents.ask",
      { to: OWNER, question: "May the door face north?" },
      { caller: AGENT, threadId: lead.id },
    )) as { status: string; message: { messageId: string } };
    expect(asked.status).toBe("pending");
    await client.call("slices.update", { sliceId: door.id, assignee: BUILDER });
    expect(await client.call("missions.next", { missionId: mission.id })).toMatchObject({
      ready: [door.id],
      escalations: [asked.message.messageId],
    });
    await expect(client.call("slices.handoff", { sliceId: door.id })).rejects.toMatchObject({
      code: "ESCALATION_OPEN",
    });
    const second = await orchestrate();
    expect(await workflowEnds(workflows, second.workflowId)).toMatchObject({
      result: { outcome: "waiting", escalations: [asked.message.messageId], handed: [] },
    });

    // The owner answers: the team goes on.
    await client.call("agents.inbox.answer", {
      messageId: asked.message.messageId,
      answer: "North.",
    });
    expect(await client.call("missions.next", { missionId: mission.id })).toMatchObject({
      escalations: [],
    });
    await orchestrate();
    const missionsFeed = watch(client, MISSIONS_STREAM);
    await sliceBecomes(missionsFeed, door.id, "active");
  });

  it("holds only the blocked slices when the lead blocked what it asked about (D1263)", async () => {
    const { client, kernel, mission, lead, slices, workflows, orchestrate } = await led([
      { title: "Door" },
      { title: "Roof" },
    ]);
    const [door, roof] = [slices[0]!, slices[1]!];
    // The first run finds both unassigned: the thread it ran from is the lead.
    const first = await orchestrate();
    expect(await workflowEnds(workflows, first.workflowId)).toMatchObject({
      result: { outcome: "decide" },
    });
    for (const slice of [door, roof]) {
      await client.call("slices.update", { sliceId: slice.id, assignee: BUILDER });
    }
    const asked = (await kernel.commands.execute(
      "agents.ask",
      { to: OWNER, question: "May the roof be red?" },
      { caller: AGENT, threadId: lead.id },
    )) as { message: { messageId: string } };
    // An ask with nothing blocked holds the mission, as before (D1223).
    expect(await client.call("missions.next", { missionId: mission.id })).toMatchObject({
      escalations: [asked.message.messageId],
      held: true,
    });
    // The lead blocks the slice it asked about: the rest goes on.
    await client.call("slices.update", { sliceId: roof.id, status: "blocked" });
    expect(await client.call("missions.next", { missionId: mission.id })).toMatchObject({
      escalations: [asked.message.messageId],
      held: false,
      ready: [door.id],
      decisions: [{ sliceId: roof.id, reason: "blocked" }],
    });
    const missionsFeed = watch(client, MISSIONS_STREAM);
    const run = await orchestrate();
    await sliceBecomes(missionsFeed, door.id, "active");
    await client.call("workflows.stop", { workflowId: run.workflowId, parentThreadId: lead.id });
    await workflowEnds(workflows, run.workflowId);
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
