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
  const streams = new Map<
    string,
    { after: number; listener: Listener; onError?: ((error: unknown) => void) | undefined }
  >();
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
      subscribe: (
        stream: string,
        options: { after: number; onError?: (error: unknown) => void },
        listener: Listener,
      ) => {
        streams.set(stream, { after: options.after, listener, onError: options.onError });
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
const quiet = { warn() {}, info() {} };

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
    // The client holds no progress: a commit leaves the state as it was.
    const before = store.snapshot().get("a")!.value;
    push({
      type: HealthEvents.progressRecorded,
      payload: {
        progress: {
          kind: "commit",
          count: 1,
          threadId: "t1",
          projectId: "p1",
          ref: "abc",
          at: "x",
        },
      },
    });
    expect(store.snapshot().get("a")!.value).toBe(before);
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

  it("tells at most three warnings, newest first, that came while the stream was down", async () => {
    const catalogs = [
      { head: 1, warnings: [warning("w0", "2026-10-21T08:00:00Z")], ideas: [] },
      {
        head: 9,
        warnings: ["w0", "w1", "w2", "w3", "w4"].map((id, index) =>
          warning(id, `2026-10-21T${String(8 + index).padStart(2, "0")}:00:00Z`),
        ),
        ideas: [],
      },
    ];
    const node = fakeNode(async () => catalogs.shift());
    const told: string[] = [];
    const logged: unknown[] = [];
    const log = {
      warn() {},
      info: (message: string, fields?: unknown) => logged.push({ message, fields }),
    };
    const store = createHealthStore(node.connections, log, (_connection, raised) =>
      told.push(raised.warningId),
    );
    await settled(store);
    const reread = new Promise<void>((resolve) => {
      const subscription = store.subscribe(() => {
        if (Object.keys(store.snapshot().get("a")?.value.warnings ?? {}).length !== 5) return;
        subscription.dispose();
        resolve();
      });
    });
    node.streams.get(HEALTH_STREAM)!.onError!(new Error("dropped"));
    await reread;
    // Four came meanwhile; the three newest are told, the rest are in the sidebar.
    expect(told).toEqual(["w4", "w3", "w2"]);
    // The one left untold is counted in the log, so the cap is seen.
    expect(logged).toEqual([
      {
        message: "a re-read told only the newest",
        fields: { stream: HEALTH_STREAM, told: 3, untold: 1 },
      },
    ]);
    store.dispose();
  });
});
