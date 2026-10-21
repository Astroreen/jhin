import { OrchestrationEvents } from "@jhin/agent-api";
import type { Connections, ThreadsCatalog } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { taskStatusLabel } from "../src/plugins/orchestration/lineage.tsx";
import { workflowAgentsLabel } from "../src/plugins/orchestration/rows.tsx";
import {
  applyOrchestrationEvent,
  createDelegationStore,
  type DelegationView,
  type TaskRecord,
} from "../src/plugins/orchestration/store.ts";

const EMPTY: DelegationView = { status: "ready", tasks: new Map(), workflows: new Map() };

const task = (
  status: TaskRecord["status"],
  updatedAt: string,
  parentThreadId = "p",
): TaskRecord => ({
  taskId: "t",
  parentThreadId,
  childThreadId: "c",
  title: "look",
  agentId: "jhin.agent-fake",
  status,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt,
});

const updated = (record: TaskRecord) => ({
  type: OrchestrationEvents.taskUpdated,
  payload: record,
});

describe("a thread's delegated work (D864)", () => {
  it("keeps the thread's own records, never an older one over a newer", () => {
    const running = applyOrchestrationEvent(
      EMPTY,
      "p",
      updated(task("running", "2026-10-21T10:00:01.000Z")),
    );
    expect(running.tasks.get("t")?.status).toBe("running");
    const done = applyOrchestrationEvent(
      running,
      "p",
      updated(task("completed", "2026-10-21T10:00:02.000Z")),
    );
    expect(done.tasks.get("t")?.status).toBe("completed");
    // A snapshot older than what the stream brought changes nothing.
    expect(
      applyOrchestrationEvent(done, "p", updated(task("running", "2026-10-21T10:00:01.000Z"))),
    ).toBe(done);
    // Another thread's task is not this thread's.
    expect(
      applyOrchestrationEvent(
        EMPTY,
        "p",
        updated(task("running", "2026-10-21T10:00:01.000Z", "q")),
      ),
    ).toBe(EMPTY);
  });

  it("counts a workflow's agents as T3's headline does", () => {
    expect(workflowAgentsLabel([])).toBeNull();
    expect(
      workflowAgentsLabel([
        { index: 0, status: "running" },
        { index: 1, status: "completed" },
        { index: 2, status: "completed" },
        { index: 3, status: "cancelled" },
      ]),
    ).toBe("4 agents · 1 working · 2 done · 1 stopped");
  });
});

describe("the delegation store", () => {
  it("starts over after a failed read, backing off, and follows the stream from the head", async () => {
    const answers: (() => Promise<unknown>)[] = [
      () => Promise.reject(new Error("node busy")),
      () =>
        Promise.resolve({
          tasks: [task("running", "2026-10-21T10:00:01.000Z")],
          workflows: [],
          head: 7,
        }),
    ];
    let onEvent: ((event: { type: string; payload: unknown }) => void) | undefined;
    let after: number | undefined;
    const client = {
      call: () => answers.shift()!(),
      subscribe: (_stream: string, options: { after?: number }, listener: typeof onEvent) => {
        after = options.after;
        onEvent = listener;
        return { dispose() {} };
      },
    };
    const connections = {
      get: () => ({ state: "open", client }),
      subscribe: () => ({ dispose() {} }),
    } as unknown as Connections;
    const retries: { run: () => void; ms: number }[] = [];
    const store = createDelegationStore(
      connections,
      { call: () => Promise.reject(), subscribe: () => ({ dispose() {} }) },
      { warn() {} },
      (run, ms) => {
        retries.push({ run, ms });
        return () => {};
      },
    );
    const target = { node: "n" };
    await new Promise<void>((resolve) => {
      store.watch(
        target,
        "p",
      )(() => {
        if (store.view(target, "p").status === "error") resolve();
      });
    });
    expect(retries.map((retry) => retry.ms)).toEqual([1000]);

    const ready = new Promise<void>((resolve) => {
      store.watch(
        target,
        "p",
      )(() => {
        if (store.view(target, "p").status === "ready") resolve();
      });
    });
    retries[0]!.run();
    await ready;
    expect(store.view(target, "p").tasks.get("t")?.status).toBe("running");
    expect(after).toBe(7);
    onEvent!(updated(task("completed", "2026-10-21T10:00:02.000Z")));
    expect(store.view(target, "p").tasks.get("t")?.status).toBe("completed");
    store.dispose();
  });

  it("reads a mesh member's records again whenever its threads change", async () => {
    const snapshots = [
      { tasks: [task("running", "2026-10-21T10:00:01.000Z")], workflows: [], head: 3 },
      { tasks: [task("completed", "2026-10-21T10:00:02.000Z")], workflows: [], head: 4 },
    ];
    let changed: (() => void) | undefined;
    const threads = {
      call: () => Promise.resolve(snapshots.shift()),
      subscribe: (_target: unknown, listener: () => void) => {
        changed = listener;
        return { dispose() {} };
      },
    } as unknown as Pick<ThreadsCatalog, "call" | "subscribe">;
    const connections = {
      get: () => ({ state: "open", client: {} }),
      subscribe: () => ({ dispose() {} }),
    } as unknown as Connections;
    const store = createDelegationStore(connections, threads, { warn() {} });
    const target = { node: "n", remote: "m" };
    const status = (wanted: string) =>
      new Promise<void>((resolve) => {
        store.watch(
          target,
          "p",
        )(() => {
          if (store.view(target, "p").tasks.get("t")?.status === wanted) resolve();
        });
      });
    await status("running");
    const completed = status("completed");
    changed!();
    await completed;
    store.dispose();
  });
});

describe("a Lineage row's status (D867)", () => {
  it("is T3's label for a task", () => {
    expect(
      (
        [
          "starting",
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ] as const
      ).map(taskStatusLabel),
    ).toEqual(["Running", "Running", "Waiting", "Done", "Failed", "Stopped", "Stopped"]);
  });
});
