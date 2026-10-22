import { HEALTH_STREAM, HealthEvents, type Warning } from "@jhin/health-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import type { NodeFeeds } from "../src/lib/node-feeds.ts";
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
  const listeners = new Set<() => void>();
  let state: NodeConnection["state"] = "open";
  const connection = {
    id: "a",
    url: "ws://a",
    label: "a",
    get state() {
      return state;
    },
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
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as Connections;
  return {
    connections,
    streams,
    close() {
      state = "closed" as NodeConnection["state"];
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** Resolves once node `id` has answered (ready, unsupported or failed): a fact, not a wait. */
function settled(store: NodeFeeds<unknown>, id = "a"): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      const status = store.snapshot().get(id)?.status;
      if (status === undefined || status === "loading") return false;
      resolve();
      return true;
    };
    if (done()) return;
    const subscription = store.subscribe(() => {
      if (done()) subscription.dispose();
    });
  });
}
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
    await settled(store);
    expect(node.streams.get(HEALTH_STREAM)?.after).toBe(7);
    expect(told).toEqual([]);

    const push = node.streams.get(HEALTH_STREAM)!.listener;
    push({
      type: HealthEvents.warningRaised,
      payload: { warning: warning("w2", "2026-10-21T11:00:00Z") },
    });
    // The same raise again (a replayed event), and one of a warning the catalog had: no news.
    push({
      type: HealthEvents.warningRaised,
      payload: { warning: warning("w2", "2026-10-21T11:00:00Z") },
    });
    push({
      type: HealthEvents.warningRaised,
      payload: { warning: warning("w1", "2026-10-21T10:00:00Z") },
    });
    expect(told).toEqual(["w2"]);
    expect(openWarnings(store.snapshot()).map((entry) => entry.warning.warningId)).toEqual([
      "w2",
      "w1",
    ]);

    push({ type: HealthEvents.warningDismissed, payload: { warningId: "w2", dismissedAt: "x" } });
    expect(openWarnings(store.snapshot()).map((entry) => entry.warning.warningId)).toEqual(["w1"]);

    // A closed connection's warnings are not live any more, nor is its stream.
    node.close();
    expect(store.snapshot().has("a")).toBe(false);
    expect(node.streams.size).toBe(0);
    store.dispose();
  });

  it("takes a node without health as one without it", async () => {
    const node = fakeNode(() =>
      Promise.reject(Object.assign(new Error("no"), { code: "COMMAND_NOT_FOUND" })),
    );
    const store = createHealthStore(node.connections, quiet, () => {});
    await settled(store);
    expect(store.snapshot().get("a")).toMatchObject({ status: "unsupported" });
    store.dispose();
  });

  it("names groups and detectors", () => {
    expect(groupLabel(warning("w", "t").group)).toBe("Mission Doghouse");
    expect(groupLabel({ kind: "node" })).toBe("The node");
    expect(detectorLabel({ detector: "proof-loop" })).toBe("Recursive proof loop");
  });
});
