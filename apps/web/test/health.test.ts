import { HEALTH_STREAM, HealthEvents, type Warning } from "@jhin/health-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { detectorLabel, groupLabel } from "../src/plugins/health/route.ts";
import { createHealthStore, openWarnings } from "../src/plugins/health/store.ts";

const warning = (warningId: string, raisedAt: string): Warning => ({
  warningId,
  detector: "ceremony",
  subject: "mission:m1",
  group: { kind: "mission", projectId: "p1", missionId: "m1", title: "Doghouse" },
  summary: "3 ceremony against 0 progress in 24h (warns at 3)",
  measures: { ceremony: 3, progress: 0, threshold: 3 },
  evidence: [],
  raisedAt,
  status: "open",
});

type Listener = (event: { type: string; payload: unknown }) => void;

/** One open node: its `health.catalog` answer, and its streams to push events into. */
function fakeNode(catalog: () => Promise<unknown>) {
  const streams = new Map<string, { after: number; listener: Listener }>();
  const connection = {
    id: "a",
    url: "ws://a",
    label: "a",
    state: "open",
    client: {
      call: (method: string) =>
        method === "health.catalog" ? catalog() : Promise.reject(new Error(method)),
      subscribe: (stream: string, options: { after: number }, listener: Listener) => {
        streams.set(stream, { after: options.after, listener });
        return toDisposable(() => streams.delete(stream));
      },
    },
  } as unknown as NodeConnection;
  const connections = {
    list: () => [connection],
    get: () => connection,
    subscribe: () => toDisposable(() => {}),
  } as unknown as Connections;
  return { connections, streams };
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const quiet = { warn() {} };

describe("health in Civilization mode (D731)", () => {
  it("reads the catalog, follows the stream after its head and tells only warnings raised since", async () => {
    const node = fakeNode(() =>
      Promise.resolve({ head: 7, warnings: [warning("w1", "2026-10-21T10:00:00Z")], ideas: [] }),
    );
    const told: string[] = [];
    const store = createHealthStore(node.connections, quiet, (_connection, raised) =>
      told.push(raised.warningId),
    );
    await drain();
    expect(node.streams.get(HEALTH_STREAM)?.after).toBe(7);
    expect(told).toEqual([]);

    const push = node.streams.get(HEALTH_STREAM)!.listener;
    push({
      type: HealthEvents.warningRaised,
      payload: { warning: warning("w2", "2026-10-21T11:00:00Z") },
    });
    expect(told).toEqual(["w2"]);
    expect(openWarnings(store.snapshot()).map((entry) => entry.warning.warningId)).toEqual([
      "w2",
      "w1",
    ]);

    push({ type: HealthEvents.warningDismissed, payload: { warningId: "w2", dismissedAt: "x" } });
    expect(openWarnings(store.snapshot()).map((entry) => entry.warning.warningId)).toEqual(["w1"]);
    store.dispose();
  });

  it("takes a node without health as one without it", async () => {
    const node = fakeNode(() =>
      Promise.reject(Object.assign(new Error("no"), { code: "COMMAND_NOT_FOUND" })),
    );
    const store = createHealthStore(node.connections, quiet, () => {});
    await drain();
    expect(store.snapshot().get("a")).toMatchObject({ status: "unsupported" });
    store.dispose();
  });

  it("names groups and detectors", () => {
    expect(groupLabel(warning("w", "t").group)).toBe("Mission Doghouse");
    expect(groupLabel({ kind: "node" })).toBe("The node");
    expect(detectorLabel({ detector: "proof-loop" })).toBe("Recursive proof loop");
  });
});
