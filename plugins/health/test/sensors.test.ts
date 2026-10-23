import { ThreadEvents } from "@jhin/agent-api";
import {
  EMPTY_HEALTH,
  HealthConfig,
  groupKey,
  type Warning,
  carriesIdea,
  normalizeIdea,
} from "@jhin/health-api";
import { MissionEvents, type Slice } from "@jhin/missions-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { Sensors, broaderThanNarrower } from "../src/sensors.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const event = (
  stream: string,
  sequence: number,
  type: string,
  at: string,
  payload: unknown,
): StoredEvent => ({ stream, sequence, type, at, payload }) as StoredEvent;

describe("health's sensors (D722)", () => {
  it("leaves out what is older than the window, whatever order it was counted in", () => {
    const sensors = new Sensors();
    const slice = {
      id: "s1",
      missionId: "m1",
      projectId: "p1",
      title: "Floor",
      spec: "",
      wave: 1,
      dependsOn: [],
      status: "active",
      threads: [{ threadId: "t1" }],
      createdAt: hoursAgo(1),
      updatedAt: hoursAgo(1),
    } satisfies Slice;
    sensors.ingestMission(event("missions", 1, MissionEvents.sliceCreated, hoursAgo(1), { slice }));
    // A thread followed late replays its events after newer ones were counted:
    // a recent queue change first, then an approval of two days ago.
    sensors.ingestThread("t1", event("thread/t1", 9, ThreadEvents.queueUpdated, hoursAgo(1), {}));
    sensors.ingestThread(
      "t1",
      event("thread/t1", 2, ThreadEvents.requestOpened, hoursAgo(48), {
        request: { kind: "approval" },
      }),
    );
    const config = HealthConfig.parse({ windowHours: 24 });
    const mission = sensors.status(config, NOW).find((entry) => entry.group.kind === "mission");
    expect(mission).toMatchObject({ ceremony: 1, byKind: { queue: 1 } });
    expect(sensors.evaluate(config, EMPTY_HEALTH, NOW)).toEqual([]);
  });

  it("takes a deleted slice or mission out of the fold and counts nothing (D1295)", () => {
    const sensors = new Sensors();
    const slice = {
      id: "s1",
      missionId: "m1",
      projectId: "p1",
      title: "Floor",
      spec: "",
      wave: 1,
      dependsOn: [],
      status: "done",
      threads: [{ threadId: "t1" }],
      createdAt: hoursAgo(1),
      updatedAt: hoursAgo(1),
    } satisfies Slice;
    sensors.ingestMission(event("missions", 1, MissionEvents.sliceCreated, hoursAgo(1), { slice }));
    expect(sensors.linkedThreads()).toEqual(new Set(["t1"]));
    const config = HealthConfig.parse({ windowHours: 24 });
    const counted = sensors.status(config, NOW);

    expect(
      sensors.ingestMission(
        event("missions", 2, MissionEvents.sliceDeleted, hoursAgo(1), { slice }),
      ),
    ).toBe(false);
    expect(sensors.missions.slices["s1"]).toBeUndefined();
    expect(sensors.linkedThreads()).toEqual(new Set());
    expect(sensors.slicesOfThread("t1")).toEqual([]);
    // Deleting is no slice done, and the counted signals stay what they were.
    expect(sensors.status(config, NOW)).toEqual(counted);

    sensors.ingestMission(event("missions", 3, MissionEvents.sliceCreated, hoursAgo(1), { slice }));
    const mission = { id: "m1", projectId: "p1", title: "M", outcome: "", status: "active" };
    sensors.ingestMission(
      event("missions", 4, MissionEvents.missionDeleted, hoursAgo(1), { mission }),
    );
    expect(sensors.missions.slices).toEqual({});
    expect(sensors.evaluate(config, EMPTY_HEALTH, NOW)).toEqual([]);
  });

  it("counts a thread followed after a dismissal from the dismissal's time, not from its start", () => {
    const sensors = new Sensors();
    const slice = {
      id: "s1",
      missionId: "m1",
      projectId: "p1",
      title: "Floor",
      spec: "",
      wave: 1,
      dependsOn: [],
      status: "active",
      threads: [{ threadId: "t1" }],
      createdAt: hoursAgo(5),
      updatedAt: hoursAgo(5),
    } satisfies Slice;
    sensors.ingestMission(event("missions", 1, MissionEvents.sliceCreated, hoursAgo(5), { slice }));
    const queue = (sequence: number, at: string) =>
      sensors.ingestThread("t1", event("thread/t1", sequence, ThreadEvents.queueUpdated, at, {}));
    // Two queue changes before the dismissal, of a thread the dismissal had not followed yet.
    queue(1, hoursAgo(4));
    queue(2, hoursAgo(3));
    const health = {
      ...EMPTY_HEALTH,
      warnings: {
        w1: {
          warningId: "w1",
          detector: "ceremony" as const,
          subject: "mission:m1",
          group: { kind: "mission" as const, projectId: "p1", missionId: "m1" },
          summary: "",
          measures: {},
          evidence: [],
          raisedAt: hoursAgo(2.5),
          status: "dismissed" as const,
          dismissedAt: hoursAgo(2),
          dismissedAfter: { missions: 1 },
        },
      },
    };
    const config = HealthConfig.parse({ ceremony: { ratio: 1, minCeremony: 2 } });
    // Only one change since the dismissal: under the threshold.
    queue(3, hoursAgo(1));
    expect(sensors.evaluate(config, health, NOW).filter((f) => f.subject === "mission:m1")).toEqual(
      [],
    );
    queue(4, hoursAgo(0.5));
    expect(
      sensors.evaluate(config, health, NOW).find((f) => f.subject === "mission:m1")?.measures,
    ).toMatchObject({ ceremony: 2 });
  });

  it("clears an open warning once its measure is under the threshold, and counts from the clear after (D1283)", () => {
    const sensors = new Sensors();
    const slice = {
      id: "s1",
      missionId: "m1",
      projectId: "p1",
      title: "Floor",
      spec: "",
      wave: 1,
      dependsOn: [],
      status: "active",
      threads: [{ threadId: "t1" }],
      createdAt: hoursAgo(30),
      updatedAt: hoursAgo(30),
    } satisfies Slice;
    sensors.ingestMission(
      event("missions", 1, MissionEvents.sliceCreated, hoursAgo(30), { slice }),
    );
    const queue = (sequence: number, at: string) =>
      sensors.ingestThread("t1", event("thread/t1", sequence, ThreadEvents.queueUpdated, at, {}));
    queue(1, hoursAgo(25));
    queue(2, hoursAgo(23));
    queue(3, hoursAgo(22));
    const warning = {
      warningId: "w1",
      detector: "ceremony" as const,
      subject: "mission:m1",
      group: { kind: "mission" as const, projectId: "p1", missionId: "m1" },
      summary: "",
      measures: {},
      evidence: [],
      raisedAt: hoursAgo(22),
      status: "open" as const,
    };
    const health = { ...EMPTY_HEALTH, warnings: { w1: warning } };
    const config = HealthConfig.parse({ windowHours: 24, ceremony: { ratio: 1, minCeremony: 3 } });
    // Three in the window against the threshold of three: still over.
    expect(sensors.clearable(config, health, NOW - 3_600_000)).toEqual([]);
    // An hour later the oldest left the window: two, under it.
    expect(sensors.clearable(config, health, NOW).map((w) => w.warningId)).toEqual(["w1"]);
    // Cleared, the warning is history; the next crossing counts from the clear.
    const cleared = {
      ...EMPTY_HEALTH,
      warnings: {
        w1: { ...warning, status: "cleared" as const, clearedAt: hoursAgo(0.5) },
      },
    };
    expect(sensors.clearable(config, cleared, NOW)).toEqual([]);
    queue(4, hoursAgo(0.2));
    queue(5, hoursAgo(0.1));
    expect(
      sensors.evaluate(config, cleared, NOW).filter((f) => f.subject === "mission:m1"),
    ).toEqual([]);
    queue(6, hoursAgo(0.05));
    expect(
      sensors.evaluate(config, cleared, NOW).find((f) => f.subject === "mission:m1")?.measures,
    ).toMatchObject({ ceremony: 3 });
  });

  it("names the open ceremony warnings a narrower group's warning speaks for (D1284)", () => {
    const make = (warningId: string, group: Warning["group"], status: Warning["status"] = "open") =>
      ({
        warningId,
        detector: "ceremony" as const,
        subject: groupKey(group),
        group,
        summary: "",
        measures: {},
        evidence: [],
        raisedAt: hoursAgo(1),
        status,
      }) satisfies Warning;
    const warnings = [
      make("node", { kind: "node" }),
      make("p1", { kind: "project", projectId: "p1" }),
      make("p2", { kind: "project", projectId: "p2" }),
      make("m1", { kind: "mission", projectId: "p1", missionId: "m1" }),
      make("m3", { kind: "mission", projectId: "p3", missionId: "m3" }, "dismissed"),
    ];
    const health = {
      ...EMPTY_HEALTH,
      warnings: Object.fromEntries(warnings.map((warning) => [warning.warningId, warning])),
    };
    // m1 speaks for p1 and the node; p2 is covered by no mission, a dismissed one covers nothing.
    expect(
      broaderThanNarrower(health).map(({ warning, narrower }) => [
        warning.warningId,
        narrower.warningId,
      ]),
    ).toEqual([
      ["node", "p1"],
      ["p1", "m1"],
    ]);
  });

  it("finds an idea as whole words only", () => {
    const idea = normalizeIdea("Retry the flaky test!");
    expect(carriesIdea(normalizeIdea("ok, retry the FLAKY test, then"), idea)).toBe(true);
    expect(carriesIdea(normalizeIdea("we retry the flaky tests"), idea)).toBe(false);
    expect(carriesIdea(normalizeIdea("prefix: retry the flaky test"), idea)).toBe(true);
  });

  it("keeps a project quiet while one of its missions crosses, dismissed or not (D724)", () => {
    const sensors = new Sensors();
    const sliceOf = (id: string, missionId: string, threadId: string) =>
      ({
        id,
        missionId,
        projectId: "p1",
        title: id,
        spec: "",
        wave: 1,
        dependsOn: [],
        status: "active",
        threads: [{ threadId }],
        createdAt: hoursAgo(5),
        updatedAt: hoursAgo(5),
      }) satisfies Slice;
    sensors.ingestMission(
      event("missions", 1, MissionEvents.sliceCreated, hoursAgo(5), {
        slice: sliceOf("s1", "m1", "t1"),
      }),
    );
    sensors.ingestMission(
      event("missions", 2, MissionEvents.sliceCreated, hoursAgo(5), {
        slice: sliceOf("s2", "m2", "t2"),
      }),
    );
    const queue = (threadId: string, sequence: number, at: string) =>
      sensors.ingestThread(
        threadId,
        event(`thread/${threadId}`, sequence, ThreadEvents.queueUpdated, at, {}),
      );
    // Mission m1 crosses (3 of 3); its warning is dismissed afterwards.
    queue("t1", 1, hoursAgo(4));
    queue("t1", 2, hoursAgo(4));
    queue("t1", 3, hoursAgo(4));
    const health = {
      ...EMPTY_HEALTH,
      warnings: {
        w1: {
          warningId: "w1",
          detector: "ceremony" as const,
          subject: "mission:m1",
          group: { kind: "mission" as const, projectId: "p1", missionId: "m1" },
          summary: "",
          measures: {},
          evidence: [],
          raisedAt: hoursAgo(3.5),
          status: "dismissed" as const,
          dismissedAt: hoursAgo(3),
          dismissedAfter: { "thread/t1": 3, missions: 2 },
        },
      },
    };
    // Mission m2 adds 2, under its own threshold; the project holds 5.
    queue("t2", 1, hoursAgo(1));
    queue("t2", 2, hoursAgo(1));
    const config = HealthConfig.parse({ ceremony: { ratio: 1, minCeremony: 3 } });
    // One cause, one warning: m1 still crosses over the window, so p1 and the node stay quiet.
    expect(sensors.evaluate(config, health, NOW)).toEqual([]);
    // Once m2 crosses on its own, it warns, and the project still does not.
    queue("t2", 3, hoursAgo(0.5));
    expect(sensors.evaluate(config, health, NOW).map((finding) => finding.subject)).toEqual([
      "mission:m2",
    ]);
  });

  it("counts a merge at the time it merged, so one told late from before the window counts nothing", () => {
    const sensors = new Sensors();
    const slice = {
      id: "s1",
      missionId: "m1",
      projectId: "p1",
      title: "Floor",
      spec: "",
      wave: 1,
      dependsOn: [],
      status: "active",
      threads: [{ threadId: "t1" }],
      createdAt: hoursAgo(50),
      updatedAt: hoursAgo(50),
    } satisfies Slice;
    sensors.ingestMission(
      event("missions", 1, MissionEvents.sliceCreated, hoursAgo(50), { slice }),
    );
    const merged = (sequence: number, key: string, mergedAt: string) =>
      sensors.ingestSourceControl(
        event("source-control", sequence, "git.pr.updated", hoursAgo(1), {
          threadId: "t1",
          pullRequest: { key, snapshot: { state: "merged", mergedAt } },
        }),
      );
    // Published an hour ago: one merged two days ago, one merged within the window.
    merged(1, "gh:o/r#1", hoursAgo(48));
    merged(2, "gh:o/r#2", hoursAgo(2));
    const config = HealthConfig.parse({ windowHours: 24 });
    const mission = sensors.status(config, NOW).find((entry) => entry.group.kind === "mission");
    expect(mission).toMatchObject({ progress: 1, byKind: { merge: 1 } });
  });
});
