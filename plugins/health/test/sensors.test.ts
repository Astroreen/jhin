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
});
