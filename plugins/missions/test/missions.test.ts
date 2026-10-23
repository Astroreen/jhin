import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  EMPTY_MISSIONS,
  MISSIONS_STREAM,
  MISSION_DELETE_HOOK,
  applyMissionEvent,
  type Mission,
  type Slice,
} from "@jhin/missions-api";
import { LIVE_STREAMS_CAPABILITY, createLiveStreams } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  testManifest,
} from "@jhin/testing";
import { definePlugin, z } from "@jhin/sdk";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AGENT_PERMISSIONS } from "../../agent-claude/src/index.ts";
import threads from "../../threads/src/index.ts";
import missions from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function node(
  storage = memoryStoragePlugin(),
  /** Plugins beside the missions plugin, e.g. one answering a hook. */
  extra: NonNullable<Parameters<typeof createTestKernel>[0]>["plugins"] = [],
) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-missions-"));
  const streams = createLiveStreams();
  const kernel = await createTestKernel({
    plugins: [
      mockCapability(LIVE_STREAMS_CAPABILITY, streams, "1.1.0"),
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
      ...extra,
    ],
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  const stop = async () => {
    client.close();
    await kernel.stop();
  };
  stops.push(stop);
  const project = await client.call<{ id: string }>("projects.create", { path: data });
  return { client, kernel, project, storage, streams, stop };
}

const BUILDER = "jhin://node-a/agents/builder";

describe("jhin.missions", () => {
  it("plans a mission in waves and reads the intent chain up from a slice or its thread", async () => {
    const { client, project } = await node();
    await client.call("missions.intent.set", {
      projectId: project.id,
      intent: "A doghouse for a dog that needs shelter.",
    });
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog sleeps dry.",
    });
    expect(mission.process.slice.map((step) => step.id)).toEqual(["spec", "build", "test"]);
    const floor = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Floor",
      spec: "A floor that stays dry.",
      assignee: BUILDER,
    });
    const roof = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Roof",
      spec: "Rain stays out.",
      dependsOn: [floor.id],
    });
    expect([floor.wave, roof.wave]).toEqual([1, 2]);

    await client.call("slices.link", { sliceId: roof.id, threadId: "t-1" });
    await client.call("slices.link", { sliceId: roof.id, threadId: "t-1" });
    const chain = {
      slice: { id: roof.id, title: "Roof", spec: "Rain stays out.", status: "planned" },
      mission: { id: mission.id, title: "Doghouse", outcome: "The dog sleeps dry." },
      project: { id: project.id, intent: "A doghouse for a dog that needs shelter." },
    };
    expect(await client.call("missions.chain", { sliceId: roof.id })).toEqual(chain);
    expect(await client.call("missions.chain", { threadId: "t-1" })).toEqual(chain);
    expect((await client.call<Slice>("slices.get", { sliceId: roof.id })).threads).toEqual([
      { threadId: "t-1" },
    ]);
    expect(
      (await client.call<Slice[]>("slices.list", { assignee: BUILDER })).map((slice) => slice.id),
    ).toEqual([floor.id]);
  });

  it("keeps the order a set of waves, and a slice done only with a proof", async () => {
    const { client, project } = await node();
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "M",
      outcome: "O",
    });
    const other = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "N",
      outcome: "O",
    });
    const a = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "A",
      spec: "",
    });
    const b = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "B",
      spec: "",
      dependsOn: [a.id],
    });
    const elsewhere = await client.call<Slice>("slices.create", {
      missionId: other.id,
      title: "X",
      spec: "",
    });

    // Same wave as its dependency, a dependant pushed behind, another mission's slice.
    // A dropped dependant holds nothing back.
    const dropped = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Gone",
      spec: "",
      wave: 3,
      dependsOn: [b.id],
    });
    await client.call("slices.update", { sliceId: dropped.id, status: "dropped" });
    await client.call("slices.update", { sliceId: b.id, wave: 3 });
    await client.call("slices.update", { sliceId: b.id, wave: 2 });

    for (const call of [
      client.call("slices.create", {
        missionId: mission.id,
        title: "C",
        spec: "",
        wave: 1,
        dependsOn: [a.id],
      }),
      client.call("slices.update", { sliceId: a.id, wave: 2 }),
      client.call("slices.update", { sliceId: b.id, dependsOn: [elsewhere.id] }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "SLICE_ORDER_INVALID" });
    }
    await expect(
      client.call("slices.update", { sliceId: a.id, step: "deploy" }),
    ).rejects.toMatchObject({
      code: "SLICE_STEP_INVALID",
    });
    await expect(
      client.call("slices.update", { sliceId: a.id, status: "done" }),
    ).rejects.toMatchObject({
      code: "PROOF_REQUIRED",
    });
    await expect(
      client.call("slices.create", {
        missionId: mission.id,
        title: "D",
        spec: "",
        assignee: "builder",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    await expect(
      client.call("missions.intent.set", {
        projectId: project.id,
        process: [{ id: "plan" }, { id: "plan" }],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    await expect(
      client.call("slices.create", {
        missionId: mission.id,
        title: "D",
        spec: "",
        status: "dropped",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    for (const call of [
      client.call("missions.create", { projectId: "nope", title: "M", outcome: "O" }),
      client.call("missions.intent.get", { projectId: "nope" }),
      client.call("missions.markdown", { projectId: "nope" }),
      client.call("missions.list", { projectId: "nope" }),
      client.call("slices.list", { projectId: "nope" }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }

    const proved = await client.call<Slice>("slices.prove", {
      sliceId: a.id,
      items: [{ kind: "command", command: "vp test run a.test.ts", output: "1 passed" }],
    });
    expect(proved).toMatchObject({ status: "done", proof: { items: [{ kind: "command" }] } });
    const step = await client.call<Slice>("slices.update", {
      sliceId: b.id,
      step: "build",
      assignee: BUILDER,
    });
    expect(step).toMatchObject({ step: "build", assignee: BUILDER });
    expect(
      await client.call<Slice>("slices.update", { sliceId: b.id, step: null, assignee: null }),
    ).not.toHaveProperty("assignee");
  });

  it("stores every change as an event of the missions stream that folds into what the commands return", async () => {
    const storage = memoryStoragePlugin();
    const { client, project, stop } = await node(storage);
    await client.call("missions.intent.set", { projectId: project.id, intent: "I" });
    // Setting the same intent again appends nothing.
    await client.call("missions.intent.set", { projectId: project.id, intent: "I" });
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "M",
      outcome: "O",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "S",
      spec: "Works",
    });
    await client.call("slices.prove", {
      sliceId: slice.id,
      items: [{ kind: "link", url: "https://x/pr/1" }],
    });

    const events: StoredEvent[] = await storage.storage.log.read(MISSIONS_STREAM);
    expect(events.map((event) => event.type)).toEqual([
      "missions.intent.set",
      "missions.mission.created",
      "missions.slice.created",
      "missions.slice.proved",
    ]);
    const catalog = await client.call<{ head: number; slices: Slice[] }>("missions.catalog");
    expect(catalog.head).toBe(4);
    expect(events.reduce(applyMissionEvent, EMPTY_MISSIONS).slices[slice.id]).toEqual(
      catalog.slices[0],
    );

    // A node started again on the same storage reads the same state.
    await stop();
    const again = await node(storage);
    expect(await again.client.call<Slice>("slices.get", { sliceId: slice.id })).toEqual(
      catalog.slices[0],
    );
  });

  it("renders a project's intent and missions as Markdown", async () => {
    const { client, project } = await node();
    await client.call("missions.intent.set", {
      projectId: project.id,
      intent: "Shelter for the dog.",
      process: [{ id: "plan" }, { id: "release" }],
    });
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog sleeps dry.",
    });
    const floor = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Floor",
      spec: "Stays dry.",
      assignee: BUILDER,
    });
    await client.call("slices.create", {
      missionId: mission.id,
      title: "Roof",
      spec: "Rain stays out.",
      dependsOn: [floor.id],
    });
    await client.call("slices.prove", {
      sliceId: floor.id,
      items: [{ kind: "command", command: "test floor", output: "dry" }],
    });

    const { markdown } = await client.call<{ markdown: string }>("missions.markdown", {
      projectId: project.id,
    });
    const shown = markdown
      .replaceAll(mission.id, "<mission>")
      .replaceAll(floor.id, "<floor>")
      .replace(/`[0-9a-f-]{36}`/g, "`<slice>`")
      .replace(/\(\d{4}-[^)]*\)/g, "(<at>)");
    expect(shown).toBe(
      [
        `# ${Path.basename((await client.call<{ path: string }[]>("projects.list"))[1]!.path)}`,
        "",
        "**Intent**",
        "",
        "Shelter for the dog.",
        "",
        "**Process**: plan → release",
        "",
        "## Mission: Doghouse",
        "",
        "Mission `<mission>` · planned",
        "",
        "**Outcome**",
        "",
        "The dog sleeps dry.",
        "",
        "**Process**: slice spec → build → test; mission merge",
        "",
        "### Wave 1",
        "",
        "#### Floor",
        "",
        "Slice `<floor>`",
        "",
        "- Status: done",
        `- Assignee: ${BUILDER}`,
        "",
        "**Spec**",
        "",
        "Stays dry.",
        "",
        "**Proof** (<at>):",
        "",
        "```",
        "$ test floor",
        "dry",
        "```",
        "",
        "### Wave 2",
        "",
        "#### Roof",
        "",
        "Slice `<slice>`",
        "",
        "- Status: planned",
        "- Assignee: unassigned",
        "- Depends on: Floor",
        "",
        "**Spec**",
        "",
        "Rain stays out.",
        "",
      ].join("\n"),
    );
  });

  it("keeps steps, dropped slices and thread lookups consistent", async () => {
    const { client, project } = await node();
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "M",
      outcome: "O",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "S",
      spec: "",
    });
    await client.call("slices.update", { sliceId: slice.id, step: "build" });

    // A slice process without the step a slice is at is refused (D648).
    await expect(
      client.call("missions.update", {
        missionId: mission.id,
        process: { slice: [{ id: "spec" }], mission: [] },
      }),
    ).rejects.toMatchObject({ code: "SLICE_STEP_INVALID", details: { sliceId: slice.id } });
    await client.call("slices.update", { sliceId: slice.id, step: null });
    await client.call("missions.update", {
      missionId: mission.id,
      process: { slice: [{ id: "spec" }], mission: [] },
    });

    // A thread linked with its node is found with or without the node, never with another.
    await client.call("slices.link", { sliceId: slice.id, threadId: "t-1", nodeId: "node-b" });
    expect(await client.call("missions.chain", { threadId: "t-1" })).toMatchObject({
      slice: { id: slice.id },
    });
    await expect(
      client.call("missions.chain", { threadId: "t-1", nodeId: "node-c" }),
    ).rejects.toMatchObject({ code: "SLICE_NOT_FOUND" });
    expect(await client.call("slices.list", { threadId: "t-1", nodeId: "node-c" })).toEqual([]);
    expect(await client.call<Slice[]>("slices.list", { threadId: "t-1" })).toHaveLength(1);

    // Unlinking a thread that is not linked, or an update to the same values, changes nothing.
    const head = (await client.call<{ head: number }>("missions.catalog")).head;
    await client.call("slices.unlink", { sliceId: slice.id, threadId: "t-9" });
    await client.call("slices.update", { sliceId: slice.id, title: "S" });
    await client.call("missions.update", { missionId: mission.id, title: "M" });
    await client.call("missions.update", { missionId: mission.id });
    expect((await client.call<{ head: number }>("missions.catalog")).head).toBe(head);

    // A dropped slice stays dropped (D651).
    await client.call("slices.update", { sliceId: slice.id, status: "dropped" });
    // Nothing new may depend on it, while what already did keeps its order.
    await expect(
      client.call("slices.create", {
        missionId: mission.id,
        title: "After",
        spec: "",
        dependsOn: [slice.id],
      }),
    ).rejects.toMatchObject({ code: "SLICE_ORDER_INVALID" });
    await expect(
      client.call("slices.prove", {
        sliceId: slice.id,
        items: [{ kind: "link", url: "https://x/pr/1" }],
      }),
    ).rejects.toMatchObject({ code: "SLICE_DROPPED" });
    await expect(
      client.call("slices.update", { sliceId: slice.id, status: "planned" }),
    ).rejects.toMatchObject({ code: "SLICE_DROPPED" });
    await expect(
      client.call("slices.link", { sliceId: slice.id, threadId: "t-2" }),
    ).rejects.toMatchObject({ code: "SLICE_DROPPED" });
    await expect(
      client.call("slices.update", { sliceId: slice.id, spec: "Another" }),
    ).rejects.toMatchObject({ code: "SLICE_DROPPED" });
    // Its threads can still be unlinked, without the node as slices.list finds them.
    await client.call("slices.unlink", { sliceId: slice.id, threadId: "t-1" });
    expect((await client.call<Slice>("slices.get", { sliceId: slice.id })).threads).toEqual([]);

    // A slice reopened after done loses its proof: done again is a new proof (D646).
    const other = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "T",
      spec: "",
    });
    await client.call("slices.prove", {
      sliceId: other.id,
      items: [{ kind: "link", url: "https://x/pr/2" }],
    });
    expect(
      await client.call<Slice>("slices.update", { sliceId: other.id, status: "active" }),
    ).not.toHaveProperty("proof");
    await expect(
      client.call("slices.update", { sliceId: other.id, status: "done" }),
    ).rejects.toMatchObject({ code: "PROOF_REQUIRED" });

    // A done or dropped mission takes no new slices.
    await client.call("missions.update", { missionId: mission.id, status: "done" });
    await expect(
      client.call("slices.create", { missionId: mission.id, title: "Late", spec: "" }),
    ).rejects.toMatchObject({ code: "MISSION_CLOSED" });
  });

  it("deletes a slice or a mission as a tombstone: the record leaves the state, the log stays (D1395)", async () => {
    const storage = memoryStoragePlugin();
    const { client, project, stop } = await node(storage);
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "M",
      outcome: "O",
    });
    const other = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Other",
      outcome: "O",
    });
    const first = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "First",
      spec: "",
    });
    const second = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Second",
      spec: "",
      dependsOn: [first.id],
    });
    const review = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Review",
      spec: "",
      reviews: [second.id],
    });
    const kept = await client.call<Slice>("slices.create", {
      missionId: other.id,
      title: "Kept",
      spec: "",
    });

    // What another live slice depends on or reviews stays until that one is gone.
    await expect(client.call("slices.delete", { sliceId: first.id })).rejects.toMatchObject({
      code: "SLICE_IN_USE",
    });
    await expect(client.call("slices.delete", { sliceId: second.id })).rejects.toMatchObject({
      code: "SLICE_IN_USE",
    });
    await expect(client.call("slices.delete", { sliceId: "nope" })).rejects.toMatchObject({
      code: "SLICE_NOT_FOUND",
    });
    expect(await client.call<Slice>("slices.delete", { sliceId: review.id })).toMatchObject({
      id: review.id,
    });
    await client.call("slices.delete", { sliceId: second.id });
    await client.call("slices.delete", { sliceId: first.id });
    expect(
      (await client.call<Slice[]>("slices.list", { missionId: mission.id })).map((s) => s.id),
    ).toEqual([]);
    await expect(client.call("slices.get", { sliceId: first.id })).rejects.toMatchObject({
      code: "SLICE_NOT_FOUND",
    });

    // A mission goes with its slices, in one event; another mission's stay.
    const doomed = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "Doomed",
      spec: "",
    });
    expect(await client.call<Mission>("missions.delete", { missionId: mission.id })).toMatchObject({
      id: mission.id,
    });
    await expect(client.call("missions.get", { missionId: mission.id })).rejects.toMatchObject({
      code: "MISSION_NOT_FOUND",
    });
    await expect(client.call("slices.get", { sliceId: doomed.id })).rejects.toMatchObject({
      code: "SLICE_NOT_FOUND",
    });
    const catalog = await client.call<{ missions: Mission[]; slices: Slice[] }>("missions.catalog");
    expect(catalog.missions.map((item) => item.id)).toEqual([other.id]);
    expect(catalog.slices.map((item) => item.id)).toEqual([kept.id]);

    // The log is append-only, and a reader folding it gets the same state; so does a restart.
    const events: StoredEvent[] = await storage.storage.log.read(MISSIONS_STREAM);
    expect(events.map((event) => event.type).filter((type) => type.endsWith(".deleted"))).toEqual([
      "missions.slice.deleted",
      "missions.slice.deleted",
      "missions.slice.deleted",
      "missions.mission.deleted",
    ]);
    const folded = events.reduce(applyMissionEvent, EMPTY_MISSIONS);
    expect(Object.keys(folded.missions)).toEqual([other.id]);
    expect(Object.keys(folded.slices)).toEqual([kept.id]);
    await stop();
    const again = await node(storage);
    expect(
      (await again.client.call<{ slices: Slice[] }>("missions.catalog")).slices.map((s) => s.id),
    ).toEqual([kept.id]);
  });

  it("asks the deleting hook first, and a refusal deletes nothing (D1395)", async () => {
    const seen: { mission: string; sliceId?: string }[] = [];
    let refuse = true;
    const { client, project } = await node(memoryStoragePlugin(), [
      {
        manifest: testManifest("test.guard", { side: "server" }),
        definition: definePlugin({
          activate(context) {
            context.hooks.before<{ mission: Mission; sliceId?: string }>(
              MISSION_DELETE_HOOK,
              (input) => {
                seen.push({
                  mission: input.mission.id,
                  ...(input.sliceId === undefined ? {} : { sliceId: input.sliceId }),
                });
                if (refuse) throw new Error("A run is active");
                return input;
              },
            );
          },
        }),
      },
    ]);
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "M",
      outcome: "O",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "S",
      spec: "",
    });
    await expect(client.call("slices.delete", { sliceId: slice.id })).rejects.toThrow(
      "A run is active",
    );
    await expect(client.call("missions.delete", { missionId: mission.id })).rejects.toThrow(
      "A run is active",
    );
    expect(await client.call<Slice>("slices.get", { sliceId: slice.id })).toMatchObject({
      id: slice.id,
    });
    refuse = false;
    await client.call("missions.delete", { missionId: mission.id });
    expect(seen).toEqual([
      { mission: mission.id, sliceId: slice.id },
      { mission: mission.id },
      { mission: mission.id },
    ]);
  });

  it("appends after another writer of the same storage instead of over it", async () => {
    const storage = memoryStoragePlugin();
    const { client, project } = await node(storage);
    const log = storage.storage.log;
    const append = log.append.bind(log);
    // Another process appends between this node's catch-up and its append, once.
    let other = true;
    log.append = async (stream, events, options) => {
      if (other) {
        other = false;
        const intent = { projectId: project.id, intent: "Theirs", process: [], updatedAt: "x" };
        await append(MISSIONS_STREAM, [
          { type: "missions.intent.set", payload: { intent } as never },
        ]);
      }
      return append(stream, events, options);
    };

    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Ours",
      outcome: "O",
    });
    const events: StoredEvent[] = await log.read(MISSIONS_STREAM);
    expect(events.map((event) => event.type)).toEqual([
      "missions.intent.set",
      "missions.mission.created",
    ]);
    expect(await client.call("missions.intent.get", { projectId: project.id })).toMatchObject({
      intent: "Theirs",
    });
    expect(await client.call<{ head: number }>("missions.catalog")).toMatchObject({ head: 2 });
    expect((await client.call<Mission[]>("missions.list")).map((m) => m.id)).toEqual([mission.id]);
  });

  it("renders user text so it cannot break the document", async () => {
    const { client, project } = await node();
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Two\nlines",
      outcome: "# Not a section\n\n---\n\n- a\n-",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "S_*x*",
      spec: "Text\n---\n```\nunclosed",
    });
    await client.call("slices.create", {
      missionId: mission.id,
      title: "Next",
      // Fences closed by a longer run, of either character, are closed.
      spec: "```\ncode\n````\n~~~\nx\n~~~~~",
      dependsOn: [slice.id],
    });
    await expect(
      client.call("slices.prove", {
        sliceId: slice.id,
        items: [{ kind: "link", url: "javascript:alert(1)" }],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    await client.call("slices.prove", {
      sliceId: slice.id,
      items: [
        { kind: "command", command: "echo `x`", output: "```\nx" },
        { kind: "command", command: "gap", output: "a\n\n\nb" },
        { kind: "link", url: "https://x/a_(b) c", title: "a [b]" },
      ],
    });
    const { markdown } = await client.call<{ markdown: string }>("missions.markdown", {
      missionId: mission.id,
    });
    expect(markdown).toContain("## Mission: Two lines\n");
    expect(markdown).toContain("#### S\\_\\*x\\*\n");
    // A rule after a blank line stays a rule, a bare list item stays one.
    expect(markdown).toContain("\n\\# Not a section\n\n---\n\n- a\n\\-\n");
    expect(markdown).toContain("\nText\n\\---\n```\nunclosed\n```\n");
    expect(markdown).toContain("\n````\n$ echo `x`\n```\nx\n````\n");
    expect(markdown).toContain("- [a \\[b\\]](https://x/a_%28b%29%20c)");
    expect(markdown).toContain("- Depends on: S\\_\\*x\\*\n");
    expect(markdown).toContain("\n```\ncode\n````\n~~~\nx\n~~~~~\n");
    expect(markdown).not.toContain("~~~~~\n```");
    expect(markdown).toContain("\n```\n$ gap\na\n\n\nb\n```\n");
    expect(markdown.match(/^#{1,4} /gm)).toEqual(["# ", "## ", "### ", "#### ", "### ", "#### "]);
  });

  it("keeps the missions of a deleted project, marked, readable and deletable (D1399)", async () => {
    const { client, project } = await node();
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "Doghouse",
      outcome: "The dog sleeps dry.",
    });
    await client.call<Slice>("slices.create", { missionId: mission.id, title: "Floor", spec: "" });
    expect((await client.call<Mission[]>("missions.list", {}))[0]!.projectDeleted).toBeUndefined();
    await client.call("projects.delete", { projectId: project.id });

    // Nothing of it is deleted with the project; it is told apart, not stored.
    expect(await client.call<Mission[]>("missions.list", {})).toMatchObject([
      { id: mission.id, projectDeleted: true },
    ]);
    expect(await client.call("missions.get", { missionId: mission.id })).toMatchObject({
      mission: { id: mission.id, projectDeleted: true },
      slices: [{ title: "Floor" }],
    });
    const catalog = await client.call<{ missions: Mission[] }>("missions.catalog", {});
    expect(catalog.missions).toMatchObject([{ id: mission.id, projectDeleted: true }]);
    // Asking by the gone project, or planning in it, stays refused.
    await expect(client.call("missions.list", { projectId: project.id })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    await expect(
      client.call("missions.create", { projectId: project.id, title: "N", outcome: "O" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // The owner deletes it with the command that deletes any mission.
    await client.call("missions.delete", { missionId: mission.id });
    expect(await client.call<Mission[]>("missions.list", {})).toEqual([]);
  });

  it("takes any project id on a node without projects.list (D643)", async () => {
    const storage = memoryStoragePlugin();
    const kernel = await createTestKernel({
      plugins: [storage, { manifest: manifest("missions"), definition: missions }],
    });
    const { client } = connectInMemory(kernel, { log: storage.storage.log });
    stops.push(async () => {
      client.close();
      await kernel.stop();
    });
    const mission = await client.call<Mission>("missions.create", {
      projectId: "anywhere",
      title: "M",
      outcome: "O",
    });
    expect(mission.projectId).toBe("anywhere");
    const { markdown } = await client.call<{ markdown: string }>("missions.markdown", {
      projectId: "anywhere",
    });
    expect(markdown.startsWith("# anywhere\n")).toBe(true);
  });

  it("lets a thread's agent read its intent chain and prove its slice (D652)", async () => {
    const { client, kernel, project, storage, streams } = await node();
    const mission = await client.call<Mission>("missions.create", {
      projectId: project.id,
      title: "M",
      outcome: "O",
    });
    const slice = await client.call<Slice>("slices.create", {
      missionId: mission.id,
      title: "S",
      spec: "Works",
    });
    await client.call("slices.link", { sliceId: slice.id, threadId: "t-1" });
    const as = (permissions: readonly string[]) => {
      const connection = connectInMemory(kernel, {
        log: storage.storage.log,
        streams,
        caller: { id: "jhin.agent-claude:t-1", permissions: [...permissions] },
      });
      stops.push(async () => connection.client.close());
      return connection.client;
    };

    const agent = as(AGENT_PERMISSIONS);
    expect(await agent.call("missions.chain", { threadId: "t-1" })).toMatchObject({
      slice: { id: slice.id },
    });
    expect(
      await agent.call<Slice>("slices.prove", {
        sliceId: slice.id,
        items: [{ kind: "link", url: "https://x/pr/1" }],
      }),
    ).toMatchObject({ status: "done", proof: { by: "jhin.agent-claude:t-1" } });
    // Without them the same calls are refused.
    await expect(
      as(["threads.read"]).call("missions.chain", { threadId: "t-1" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    // Following the stream takes missions.read too, not events.read (security.md D415).
    const follow = (permissions: readonly string[]) =>
      new Promise<string>((resolve) => {
        as(permissions).subscribe(
          MISSIONS_STREAM,
          { onError: (error) => resolve(error.code), onReady: () => resolve("ready") },
          () => undefined,
        );
      });
    expect(await follow(["events.read"])).toBe("PERMISSION_DENIED");
    expect(await follow(AGENT_PERMISSIONS)).toBe("ready");
  });

  it("fails project-keyed commands with the error of a failing projects.list (D643)", async () => {
    const storage = memoryStoragePlugin();
    const failing = {
      manifest: testManifest("test.projects"),
      definition: definePlugin({
        activate(context) {
          context.commands.register({
            name: "projects.list",
            description: "Projects that cannot be read",
            input: z.object({}),
            output: z.array(z.unknown()),
            handler: () => {
              throw Object.assign(new Error("projects are unreadable"), { code: "UNAVAILABLE" });
            },
          });
        },
      }),
    };
    const kernel = await createTestKernel({
      plugins: [storage, failing, { manifest: manifest("missions"), definition: missions }],
    });
    const { client } = connectInMemory(kernel, { log: storage.storage.log });
    stops.push(async () => {
      client.close();
      await kernel.stop();
    });
    await expect(
      client.call("missions.create", { projectId: "p", title: "M", outcome: "O" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("projects are unreadable") });
    expect(await storage.storage.log.read(MISSIONS_STREAM)).toEqual([]);
  });
});
