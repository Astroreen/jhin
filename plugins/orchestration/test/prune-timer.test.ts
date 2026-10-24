import { describe, expect, it, vi } from "vite-plus/test";

import { node, orchestrationFeed, parentThread, watch } from "./support.ts";

// A file of its own: its fake clock must not reach other tests' nodes.
describe("pruning old records (D1503)", () => {
  it("prunes again once a day while the node runs", async () => {
    // Only the clock and the daily timer are fake: everything else runs as it does.
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { client } = await node({ config: { "jhin.orchestration": { retentionDays: 1 } } });
      const feed = orchestrationFeed(client);
      const records = watch(client, "stream:orchestration");
      const parent = await parentThread(client);
      // The parent works on, so a finished async task's result waits to be delivered.
      await client.call("threads.send", { threadId: parent.id, text: "/hold" });
      const task = await client.call<{ taskId: string }>("tasks.delegate", {
        task: "quick",
        mode: "wait",
        parentThreadId: parent.id,
      });
      await feed.task(task.taskId, (record) => record.endedAt !== undefined);
      const waiting = await client.call<{ taskId: string }>("tasks.delegate", {
        task: "later",
        parentThreadId: parent.id,
      });
      await feed.task(waiting.taskId, (record) => record.delivery === "pending");

      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);

      await records.untilMatch(
        (event) =>
          event.type === "orchestration.task.removed" &&
          (event.payload as { taskId: string }).taskId === task.taskId,
      );
      await expect(
        client.call("tasks.status", { taskId: task.taskId, parentThreadId: parent.id }),
      ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      // A result still waiting for its delivery stays, however old.
      expect(
        records.events.some(
          (event) =>
            event.type === "orchestration.task.removed" &&
            (event.payload as { taskId: string }).taskId === waiting.taskId,
        ),
      ).toBe(false);
      expect(
        await client.call("tasks.status", { taskId: waiting.taskId, parentThreadId: parent.id }),
      ).toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
