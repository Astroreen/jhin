import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { applyWorkflowPatch } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { workflowPatch } from "../src/index.ts";
import { node, orchestrationFeed, parentThread, watch } from "./support.ts";

const run = (meta: string, body: string) =>
  `export const meta = { name: '${meta}', description: '${meta}' }\n${body}`;

const NAMESPACE = "jhin.orchestration";
const LONG_AGO = "2020-01-01T00:00:00.000Z";

describe("smaller workflow events (D1504)", () => {
  it("appends the whole record when a run starts and ends, and patches in between", async () => {
    const { client, storage } = await node();
    const feed = orchestrationFeed(client);
    const records = watch(client, "stream:orchestration");
    const parent = await parentThread(client);
    const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
      parentThreadId: parent.id,
      script: run(
        "w",
        "phase('Look')\nlog('one')\nconst a = await agent('a', { label: 'a' })\nlog('two')\nreturn [a, await agent('b', { label: 'b' })]",
      ),
    });
    const done = await feed.workflow(workflowId, (record) => record.status !== "running");
    expect(done).toMatchObject({ status: "completed", logs: ["one", "two"] });

    const own = records.events.filter(
      (event) => (event.payload as { workflowId?: string }).workflowId === workflowId,
    );
    const full = own.filter((event) => event.type === "orchestration.workflow.updated");
    const patches = own.filter((event) => event.type === "orchestration.workflow.patched");
    // The start and the end (and its delivery), each whole; every agent and log line a patch.
    expect(full.length).toBeLessThanOrEqual(3);
    expect(patches.length).toBeGreaterThan(full.length);
    for (const patch of patches) {
      expect(patch.payload).not.toHaveProperty("script");
      expect(patch.payload).toMatchObject({ workflowId, parentThreadId: parent.id });
    }
    // Folding every event gives the record the store keeps.
    let folded: Record<string, unknown> | undefined;
    for (const event of own) {
      folded =
        event.type === "orchestration.workflow.updated"
          ? (event.payload as Record<string, unknown>)
          : applyWorkflowPatch(folded!, event.payload as never);
    }
    expect(folded).toEqual(await storage.storage.kv.get(NAMESPACE, `workflow/${workflowId}`));
  });

  it("falls back to the whole record when a patch could not say it", () => {
    const base = {
      workflowId: "w",
      parentThreadId: "p",
      name: "n",
      description: "d",
      phases: [],
      status: "running" as const,
      agents: [{ index: 0, status: "running" as const, label: "a" }],
      logs: ["x"],
      wake: "always" as const,
      delivery: "none" as const,
      createdAt: "t0",
      updatedAt: "t0",
    };
    const changed = {
      ...base,
      currentPhase: "Look",
      agents: [
        { index: 0, status: "completed" as const, label: "a" },
        { index: 1, status: "starting" as const },
      ],
      logs: ["x", "y"],
      updatedAt: "t1",
    };
    const patch = workflowPatch(base, changed);
    expect(patch).toEqual({
      workflowId: "w",
      parentThreadId: "p",
      updatedAt: "t1",
      set: { currentPhase: "Look" },
      agents: changed.agents,
      logs: ["y"],
    });
    expect(applyWorkflowPatch(base, patch!)).toEqual(changed);
    // A cleared field is unset.
    expect(
      workflowPatch(changed, {
        ...base,
        updatedAt: "t2",
        agents: changed.agents,
        logs: changed.logs,
      }),
    ).toMatchObject({
      unset: ["currentPhase"],
    });
    // A status change, or fewer agents, goes whole.
    expect(workflowPatch(base, { ...base, status: "completed" })).toBeUndefined();
    expect(workflowPatch(changed, { ...changed, agents: [] })).toBeUndefined();
  });
});

describe("pruning old records (D1503)", () => {
  const task = (taskId: string, parentThreadId: string, fields: Record<string, unknown>) => ({
    taskId,
    parentThreadId,
    childThreadId: `child-${taskId}`,
    childTurnId: `turn-${taskId}`,
    title: taskId,
    agentId: "jhin.agent-fake",
    runtimeMode: "full-access",
    interactionMode: "default",
    status: "completed",
    summary: "done",
    hasPendingQuestion: false,
    wake: "always",
    delivery: "acknowledged",
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    endedAt: LONG_AGO,
    ...fields,
  });

  it("deletes what ended long ago and waits for no delivery, with its workflow's agents and journal", async () => {
    const first = await node();
    const parent = await parentThread(first.client);
    await first.stop();
    const kv = first.storage.storage.kv;
    const recent = new Date().toISOString();
    await kv.set(NAMESPACE, "task/old", task("old", parent.id, { clientRequestId: "r1" }));
    await kv.set(NAMESPACE, "task/pending", task("pending", parent.id, { delivery: "pending" }));
    await kv.set(NAMESPACE, "task/recent", task("recent", parent.id, { endedAt: recent }));
    await kv.set(NAMESPACE, "task/agent", task("agent", parent.id, { workflowId: "wf" }));
    await kv.set(NAMESPACE, "workflow/wf", {
      workflowId: "wf",
      parentThreadId: parent.id,
      name: "wf",
      description: "wf",
      phases: [],
      status: "completed",
      agents: [{ index: 0, taskId: "agent", status: "completed" }],
      logs: [],
      wake: "always",
      delivery: "acknowledged",
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
      endedAt: LONG_AGO,
    });
    await kv.set(NAMESPACE, "journal/wf/0", { index: 0 });

    const second = await node({ storage: first.storage, data: first.data });
    const records = watch(second.client, "stream:orchestration");
    await records.until("orchestration.workflow.removed");
    await records.untilMatch(
      (event) =>
        event.type === "orchestration.task.removed" &&
        (event.payload as { taskId: string }).taskId === "old",
    );

    const keys = (await kv.list(NAMESPACE)).map((entry) => entry.key);
    expect(keys.toSorted()).toEqual(["task/pending", "task/recent"]);
    expect(
      records.events
        .filter((event) => event.type.endsWith(".removed"))
        .map((event) => event.payload),
    ).toEqual(
      expect.arrayContaining([
        { taskId: "agent", parentThreadId: parent.id },
        { workflowId: "wf", parentThreadId: parent.id },
        { taskId: "old", parentThreadId: parent.id },
      ]),
    );
    expect(
      (await second.client.call<{ taskId: string }[]>("tasks.list", { parentThreadId: parent.id }))
        .map((item) => item.taskId)
        .toSorted(),
    ).toEqual(["pending", "recent"]);
  });

  it("keeps everything with retentionDays 0", async () => {
    const first = await node();
    const parent = await parentThread(first.client);
    await first.stop();
    await first.storage.storage.kv.set(NAMESPACE, "task/old", task("old", parent.id, {}));
    const second = await node({
      storage: first.storage,
      data: first.data,
      config: { "jhin.orchestration": { retentionDays: 0 } },
    });
    // A delegation after the start's work: the old record is still there.
    const records = watch(second.client, "stream:orchestration");
    await second.client.call("tasks.delegate", { task: "x", parentThreadId: parent.id });
    await records.until("orchestration.task.updated");
    expect(records.events.some((event) => event.type === "orchestration.task.removed")).toBe(false);
    expect(await first.storage.storage.kv.get(NAMESPACE, "task/old")).toBeDefined();
  });
});

describe("the node's saved workflows (D1505)", () => {
  it("finds a name in the node's folder after the project's, and lists both", async () => {
    const { client, data } = await node();
    const feed = orchestrationFeed(client);
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-workflows-"));
    Fs.mkdirSync(Path.join(dir, ".jhin", "workflows"), { recursive: true });
    Fs.mkdirSync(Path.join(data, "workflows"), { recursive: true });
    Fs.writeFileSync(
      Path.join(dir, ".jhin", "workflows", "shared.js"),
      run("shared", "return 'project'"),
    );
    Fs.writeFileSync(Path.join(data, "workflows", "shared.js"), run("shared", "return 'node'"));
    Fs.writeFileSync(
      Path.join(data, "workflows", "greet.js"),
      `export const meta = { name: 'greet', description: 'Greets', whenToUse: 'Say hi', phases: [{ title: 'Hi' }] }\nreturn 'hi ' + args.who`,
    );
    Fs.writeFileSync(Path.join(data, "workflows", "broken.js"), "return 1");
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const parent = await parentThread(client, { projectId: project.id });
    const result = async (name: string, args?: unknown) => {
      const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
        parentThreadId: parent.id,
        name,
        ...(args === undefined ? {} : { args }),
      });
      return (await feed.workflow(workflowId, (item) => item.status !== "running")).result;
    };

    expect(await result("greet", { who: "you" })).toBe("hi you");
    expect(await result("shared")).toBe("project");

    const { workflows } = await client.call<{ workflows: Record<string, unknown>[] }>(
      "workflows.saved",
      { threadId: parent.id },
    );
    expect(workflows).toEqual([
      {
        name: "broken",
        source: "node",
        file: Path.join(data, "workflows", "broken.js"),
        error: expect.any(String),
      },
      {
        name: "greet",
        source: "node",
        file: Path.join(data, "workflows", "greet.js"),
        description: "Greets",
        whenToUse: "Say hi",
        phases: [{ title: "Hi" }],
      },
      {
        name: "shared",
        source: "project",
        file: Path.join(dir, ".jhin", "workflows", "shared.js"),
        description: "shared",
        phases: [],
      },
    ]);
    // Without a thread, only the node's.
    const own = await client.call<{ workflows: { name: string; source: string }[] }>(
      "workflows.saved",
      {},
    );
    expect(own.workflows.map((item) => [item.name, item.source])).toEqual([
      ["broken", "node"],
      ["greet", "node"],
      ["shared", "node"],
    ]);
  });
});
