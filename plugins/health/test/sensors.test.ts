import { ThreadEvents } from "@jhin/agent-api";
import { HealthConfig, EMPTY_HEALTH } from "@jhin/health-api";
import { MissionEvents, type Slice } from "@jhin/missions-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { Sensors } from "../src/sensors.ts";

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
});
