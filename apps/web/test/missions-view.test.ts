import type { Connections, NodeConnection } from "@jhin/client-api";
import {
  DEFAULT_MISSION_PROCESS,
  MISSIONS_STREAM,
  MissionEvents,
  type Mission,
  type Slice,
} from "@jhin/missions-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  assigneeLabel,
  formatSteps,
  parseSteps,
  placeOf,
  reviewCheckFailed,
  reviewCheckLines,
  routeOf,
  runLabel,
  sameSteps,
  threadTarget,
  waitsFor,
  type OrchestratorRun,
  type MissionPlace,
} from "../src/plugins/missions/route.ts";
import {
  intentChanges,
  missionChanges,
  newMissionProcess,
  sliceChanges,
  sliceStatusOptions,
} from "../src/plugins/missions/changes.ts";
import { createMissionsStore, type MissionsView } from "../src/plugins/missions/store.ts";

const mission = (fields: Partial<Mission> = {}): Mission => ({
  id: "m1",
  projectId: "p1",
  title: "Missions in the client",
  outcome: "The owner reads every mission.",
  status: "active",
  process: DEFAULT_MISSION_PROCESS,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  ...fields,
});

const slice = (fields: Partial<Slice> = {}): Slice => ({
  id: "s1",
  missionId: "m1",
  projectId: "p1",
  title: "The mission view",
  spec: "A mission shows its waves.",
  wave: 1,
  dependsOn: [],
  status: "planned",
  threads: [],
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  ...fields,
});

describe("the mission view's route (D653)", () => {
  const base = { node: "ws://a/rpc", mode: "civilization" };

  it("round-trips a mission, a slice and a slice's thread, here and on a member", () => {
    const places: MissionPlace[] = [
      { kind: "mission", missionId: "m1" },
      { kind: "slice", sliceId: "s1" },
      { kind: "slice", sliceId: "s1", thread: { threadId: "t1" } },
      { kind: "slice", sliceId: "s1", thread: { threadId: "t1", nodeId: "n2" } },
    ];
    for (const place of places) expect(placeOf(routeOf(base, place))).toEqual(place);
    expect(routeOf({ ...base, panel: "agent", thread: "x" }, places[0]!)).toEqual({
      ...base,
      panel: "mission",
      section: "m1",
    });
  });

  it("leaves other panels and empty sections to others", () => {
    expect(placeOf({ ...base, panel: "agent", section: "builder" })).toBeUndefined();
    expect(placeOf({ ...base, panel: "mission" })).toBeUndefined();
    expect(placeOf({ ...base, panel: "slice", section: "/t1" })).toBeUndefined();
    expect(placeOf({ ...base, panel: "slice", section: "s1/" })).toEqual({
      kind: "slice",
      sliceId: "s1",
    });
  });

  it("reads a slice's thread on the route's node, or through its mesh (D647)", () => {
    const target = { node: "ws://a/rpc" };
    expect(threadTarget(target, { threadId: "t1" }, "n1")).toBe(target);
    expect(threadTarget(target, { threadId: "t1", nodeId: "n1" }, "n1")).toBe(target);
    expect(threadTarget(target, { threadId: "t1", nodeId: "n2" }, "n1")).toEqual({
      node: "ws://a/rpc",
      remote: "n2",
    });
  });

  it("names assignees as people read them (D645)", () => {
    expect(assigneeLabel(undefined)).toBe("Unassigned");
    expect(assigneeLabel("jhin://n1/agents/builder")).toBe("builder");
    expect(assigneeLabel("jhin://n1/owner")).toBe("Owner");
  });

  it("D1082: an assignee shows by its agent's title when its node lists it", () => {
    const titles = new Map([["jhin://n1/agents/builder", "Builder"]]);
    expect(assigneeLabel("jhin://n1/agents/builder", titles)).toBe("Builder");
    expect(assigneeLabel("jhin://n2/agents/builder", titles)).toBe("builder");
  });

  it("D1084: a process is edited as one line of step ids, keeping descriptions", () => {
    const previous = [{ id: "build", description: "Make it work" }, { id: "test" }];
    expect(formatSteps(previous)).toBe("build → test");
    expect(parseSteps("spec → build, test", previous)).toEqual([
      { id: "spec" },
      { id: "build", description: "Make it work" },
      { id: "test" },
    ]);
    expect(parseSteps("spec->build  test")).toEqual([
      { id: "spec" },
      { id: "build" },
      { id: "test" },
    ]);
    expect(parseSteps("  ")).toEqual([]);
    expect(sameSteps(parseSteps("build test", previous), previous)).toBe(true);
    expect(sameSteps(parseSteps("test build"), previous)).toBe(false);
  });
});

describe("what an edit dialog sends (D1083, D1085)", () => {
  const form = (target: Slice) => ({
    title: target.title,
    spec: target.spec,
    assignee: target.assignee,
    wave: target.wave,
    dependsOn: target.dependsOn,
    status: target.status,
    step: target.step,
  });

  it("an untouched slice sends nothing; null clears an assignee or a step", () => {
    const current = slice({
      assignee: "jhin://n1/agents/builder",
      step: "build",
      dependsOn: ["s0"],
    });
    expect(sliceChanges(current, form(current))).toEqual({});
    expect(
      sliceChanges(current, { ...form(current), assignee: undefined, step: undefined }),
    ).toEqual({ assignee: null, step: null });
    expect(sliceChanges(current, { ...form(current), dependsOn: ["s0"] })).toEqual({});
    expect(sliceChanges(current, { ...form(current), dependsOn: [], wave: 2 })).toEqual({
      dependsOn: [],
      wave: 2,
    });
  });

  it("a new mission keeps the default steps' review (L3, D1264)", () => {
    expect(
      newMissionProcess({ sliceProcess: "spec → build → test", missionProcess: "merge" }),
    ).toEqual({
      slice: [{ id: "spec" }, { id: "build" }, { id: "test" }],
      mission: [{ id: "merge", review: true }],
    });
    // A step of the owner's own has no review unless the process says so.
    expect(
      newMissionProcess({ sliceProcess: "build", missionProcess: "demo merge" }).mission,
    ).toEqual([{ id: "demo" }, { id: "merge", review: true }]);
  });

  it("a mission sends its process only when its steps changed", () => {
    const current = mission();
    const same = {
      title: current.title,
      outcome: current.outcome,
      status: current.status,
      sliceProcess: "spec → build → test",
      missionProcess: "merge",
    };
    expect(missionChanges(current, same)).toEqual({});
    expect(missionChanges(current, { ...same, missionProcess: "merge release" })).toEqual({
      process: {
        slice: DEFAULT_MISSION_PROCESS.slice,
        // The step kept keeps what it had: merge needs a review (D1241).
        mission: [{ id: "merge", review: true }, { id: "release" }],
      },
    });
  });

  it("an intent sends what changed, and everything when there is none yet", () => {
    const previous = { projectId: "p1", intent: "A harbor.", process: [], updatedAt: "" };
    expect(intentChanges(previous, { intent: "A harbor.", process: "" })).toEqual({});
    expect(intentChanges(previous, { intent: "A quay.", process: "" })).toEqual({
      intent: "A quay.",
    });
    expect(intentChanges(undefined, { intent: "A quay.", process: "plan" })).toEqual({
      intent: "A quay.",
      process: [{ id: "plan" }],
    });
  });

  it("offers Done only to a done slice, and Dropped only to an existing one", () => {
    expect(sliceStatusOptions(undefined)).toEqual(["planned", "active", "blocked"]);
    expect(sliceStatusOptions(slice({ status: "active" }))).toEqual([
      "planned",
      "active",
      "blocked",
      "dropped",
    ]);
    expect(sliceStatusOptions(slice({ status: "done" }))).toContain("done");
  });
});

describe("the orchestrator beside a mission (D1088)", () => {
  const run = (fields: Partial<OrchestratorRun>): OrchestratorRun => ({
    workflowId: "w1",
    parentThreadId: "lead",
    status: "running",
    logs: [],
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...fields,
  });
  const titles = new Map([
    ["s1", "Walls"],
    ["s2", "Door"],
  ]);
  const titleOf = (id: string) => titles.get(id) ?? id;
  const idle = { ready: [], working: [] };

  it("reads a stopped run as paused and a finished one as waiting for the lead", () => {
    expect(runLabel(null)).toBe("Not running");
    expect(runLabel(run({}))).toBe("Running");
    expect(runLabel(run({ status: "stopped" }))).toBe("Paused");
    expect(runLabel(run({ status: "completed" }))).toBe("Waiting for the lead");
  });

  it("says what the run waits for: proofs while it runs, the lead after it ends", () => {
    expect(waitsFor(null, idle, titleOf)).toBe("Nothing runs this mission.");
    expect(waitsFor(run({}), { ready: [], working: ["s1"] }, titleOf)).toBe("The proof of Walls.");
    expect(
      waitsFor(
        run({
          status: "completed",
          result: { outcome: "decide", decisions: [{ sliceId: "s2", reason: "unassigned" }] },
        }),
        idle,
        titleOf,
      ),
    ).toBe("The lead's decision on Door (no assignee).");
    expect(
      waitsFor(
        run({
          status: "completed",
          result: { outcome: "wave-done", wave: 1, steps: [{ id: "merge" }] },
        }),
        idle,
        titleOf,
      ),
    ).toBe("The lead: run merge after wave 1, then orchestrate again.");
    expect(waitsFor(run({ status: "failed", error: "node stopped" }), idle, titleOf)).toBe(
      "The owner: the run failed: node stopped",
    );
  });
});

const quiet = { warn: () => undefined };

function fakeNode(catalog: () => Promise<unknown>) {
  const subscriptions: {
    after: number | undefined;
    onEvent: (event: StoredEvent) => void;
    onError: ((error: unknown) => void) | undefined;
  }[] = [];
  const client = {
    call: (method: string) => {
      if (method !== "missions.catalog") throw new Error(`unexpected ${method}`);
      return catalog();
    },
    subscribe(
      stream: string,
      options: { after?: number; onError?: (error: unknown) => void },
      onEvent: (event: StoredEvent) => void,
    ) {
      if (stream !== MISSIONS_STREAM) throw new Error(`unexpected stream ${stream}`);
      subscriptions.push({ after: options.after, onEvent, onError: options.onError });
      return { lastSequence: 0, dispose: () => undefined };
    },
  } as unknown as RpcClient;
  let connection: NodeConnection = {
    id: "ws://a/rpc",
    url: "ws://a/rpc",
    label: "a",
    client,
    state: "open",
  };
  const listeners = new Set<() => void>();
  const connections: Connections = {
    list: () => [connection],
    get: (id) => (id === connection.id ? connection : undefined),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
  const setState = (state: NodeConnection["state"]) => {
    connection = { ...connection, state };
    for (const listener of listeners) listener();
  };
  return { connections, subscriptions, setState };
}

function follow(store: ReturnType<typeof createMissionsStore>) {
  const waiting: ((view: MissionsView) => void)[] = [];
  store.subscribe("ws://a/rpc", () => waiting.shift()?.(store.view("ws://a/rpc")));
  return { next: () => new Promise<MissionsView>((resolve) => waiting.push(resolve)) };
}

const event = (sequence: number, type: string, payload: unknown): StoredEvent =>
  ({ sequence, type, payload, at: "2026-10-21T10:00:00.000Z" }) as unknown as StoredEvent;

describe("the missions store (D641)", () => {
  it("loads the catalog, folds the stream after its head, and shows nothing stale after a reconnect", async () => {
    let missions = [mission()];
    const node = fakeNode(async () => ({
      head: 4,
      intents: [{ projectId: "p1", intent: "Ship Jhin.", process: [], updatedAt: "" }],
      missions,
      slices: [slice()],
    }));
    const store = createMissionsStore(node.connections, quiet);
    const feed = follow(store);
    const ready = await feed.next();
    expect(ready.status).toBe("ready");
    expect(ready.state.intents.p1?.intent).toBe("Ship Jhin.");
    expect(Object.keys(ready.state.slices)).toEqual(["s1"]);
    expect(node.subscriptions.map((s) => s.after)).toEqual([4]);

    const proved = feed.next();
    node.subscriptions[0]!.onEvent(
      event(5, MissionEvents.sliceProved, {
        slice: slice({
          status: "done",
          proof: {
            items: [{ kind: "command", command: "vp test", output: "ok" }],
            recordedAt: "now",
          },
        }),
      }),
    );
    expect((await proved).state.slices.s1?.status).toBe("done");

    const dropped = feed.next();
    node.setState("closed");
    expect((await dropped).status).toBe("loading");

    missions = [mission({ id: "m9" })];
    const reloaded = feed.next();
    node.setState("open");
    expect(Object.keys((await reloaded).state.missions)).toEqual(["m9"]);
    store.dispose();
  });

  it("tells a node without missions, or without the right to read them", async () => {
    const node = fakeNode(() =>
      Promise.reject(Object.assign(new Error("no"), { code: "PERMISSION_DENIED" })),
    );
    const store = createMissionsStore(node.connections, quiet);
    expect((await follow(store).next()).status).toBe("unavailable");
    store.dispose();
  });

  it("starts over when the stream breaks", async () => {
    let calls = 0;
    const node = fakeNode(async () => {
      calls += 1;
      return { head: calls, intents: [], missions: [mission()], slices: [] };
    });
    const store = createMissionsStore(node.connections, quiet);
    const feed = follow(store);
    await feed.next();
    const failed = feed.next();
    node.subscriptions[0]!.onError?.(new Error("stream closed"));
    expect((await failed).status).toBe("error");
    // The first restart is immediate; the catalog is read afresh.
    const again = await feed.next();
    expect(again.status).toBe("ready");
    expect(node.subscriptions.map((s) => s.after)).toEqual([1, 2]);
    store.dispose();
  });
});

describe("D1278: the mission view shows reviews and the review check", () => {
  const titleOf = (id: string) => ({ s1: "The view" })[id] ?? id;

  it("words the check's three answers and its waiting states", () => {
    expect(reviewCheckLines({ status: "ready", clear: true, unreviewed: [] }, titleOf)).toEqual({
      headline: "Clear: every done slice was reviewed after its last change.",
      unreviewed: [],
    });
    const waiting = reviewCheckLines(
      {
        status: "ready",
        clear: false,
        unreviewed: [
          { sliceId: "s1", reason: "changed-after-review" },
          { sliceId: "s2", reason: "unreviewed" },
        ],
      },
      titleOf,
    );
    expect(waiting.unreviewed).toEqual([
      "The view: changed after its last review",
      "s2: never reviewed",
    ]);
    expect(reviewCheckLines({ status: "unavailable" }, titleOf).headline).toMatch(/^Not known:/);
    expect(reviewCheckLines({ status: "error", error: "boom" }, titleOf).headline).toBe(
      "Couldn't check reviews: boom",
    );
  });

  it("takes a missing command or a refusal as unavailable, any other failure as an error", () => {
    expect(reviewCheckFailed(Object.assign(new Error("x"), { code: "COMMAND_NOT_FOUND" }))).toEqual(
      { status: "unavailable" },
    );
    expect(reviewCheckFailed(Object.assign(new Error("x"), { code: "PERMISSION_DENIED" }))).toEqual(
      { status: "unavailable" },
    );
    expect(reviewCheckFailed(new Error("boom"))).toEqual({ status: "error", error: "boom" });
  });
});
