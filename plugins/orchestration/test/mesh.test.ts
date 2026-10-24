import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { OrchestrationThreadEvents } from "@jhin/agent-api";
import { createMemoryNetwork, mockCapability, startMeshNode } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import agent from "../../agent-fake/src/index.ts";
import threads from "../../threads/src/index.ts";
import { orchestrationFeed, orchestrationPlugin, watch, type TaskView } from "./support.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function meshNode(network: ReturnType<typeof createMemoryNetwork>, id: string) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-orchestration-${id}-`));
  const started = await startMeshNode(network, id, {
    config: { node: { "jhin.threads": { defaultAgent: "jhin.agent-fake" } } },
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (plugin: string) => {
          Fs.mkdirSync(Path.join(data, plugin), { recursive: true });
          return Path.join(data, plugin);
        },
      }),
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: agent },
      orchestrationPlugin,
    ],
  });
  stops.push(() => started.stop());
  return started;
}

async function twoNodes() {
  const network = createMemoryNetwork();
  const a = await meshNode(network, "a");
  const b = await meshNode(network, "b");
  await a.join(b);
  const client = a.connect().client;
  const parent = await client.call<{ id: string; projectId: string }>("threads.create", {
    title: "Parent",
  });
  return { a, b, client, parent };
}

describe("a child on another node (D1506, D1507)", () => {
  it("runs the child on the member, follows it from here and wakes the parent here", async () => {
    const { b, client, parent } = await twoNodes();
    const feed = orchestrationFeed(client);
    const parentEvents = watch(client, parent.id);

    const capabilities = await client.call<{ nodes: unknown[] }>("orchestration.capabilities", {
      threadId: parent.id,
    });
    expect(capabilities.nodes).toEqual([{ nodeId: "b", name: "b", reachable: true }]);
    const there = await client.call<{ agents: { agentId: string }[] }>(
      "orchestration.capabilities",
      { node: "b" },
    );
    expect(there.agents.map((item) => item.agentId)).toEqual(["jhin.agent-fake"]);

    const task = await client.call<TaskView & { node?: string }>("tasks.delegate", {
      task: "look around",
      parentThreadId: parent.id,
      target: { node: "b" },
    });
    expect(task).toMatchObject({ node: "b", parentThreadId: parent.id });
    // The child lives on b, in its scratch project, as the parent's subagent.
    const child = await b
      .connect()
      .client.call<{ thread: Record<string, unknown> }>("threads.get", {
        threadId: task.childThreadId,
      });
    expect(child.thread).toMatchObject({
      projectId: "scratch",
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
    });

    const delivered = await feed.task(task.taskId, (record) => record.delivery === "delivered");
    expect(delivered).toMatchObject({
      status: "completed",
      summary: "Echo: look around",
      node: "b",
    });
    const wake = await parentEvents.until("agent.turn.started");
    expect((wake.payload as { input: { text: string } }).input.text).toContain(task.taskId);
    // The mark in the parent names the node, so the chat opens the child there.
    const mark = (await watch(client, parent.id).until(OrchestrationThreadEvents.taskDelegated))
      .payload;
    expect(mark).toMatchObject({ taskId: task.taskId, node: "b" });
  });

  it("cancels a child on the member, and refuses nodes it does not know", async () => {
    const { b, client, parent } = await twoNodes();
    const feed = orchestrationFeed(client);
    const task = await client.call<TaskView>("tasks.delegate", {
      task: "/hold on",
      parentThreadId: parent.id,
      target: { node: "b" },
    });
    const childEvents = watch(b.connect().client, task.childThreadId);
    await childEvents.until("agent.turn.started");

    expect(
      await client.call("tasks.cancel", { taskId: task.taskId, parentThreadId: parent.id }),
    ).toEqual({ taskId: task.taskId, status: "cancel_requested" });
    await childEvents.until("agent.turn.interrupted");
    expect(await feed.task(task.taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "cancelled",
    });

    await expect(
      client.call("tasks.delegate", {
        task: "x",
        parentThreadId: parent.id,
        target: { node: "nowhere" },
      }),
    ).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        parentThreadId: parent.id,
        target: { node: "b", projectId: "scratch" },
        isolation: "worktree",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
    await expect(
      client.call("tasks.delegate", {
        task: "x",
        parentThreadId: parent.id,
        target: { projectId: "scratch" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // This node named as the target is a local delegation.
    const here = await client.call<TaskView & { node?: string }>("tasks.delegate", {
      task: "here",
      parentThreadId: parent.id,
      target: { node: "a" },
    });
    expect(here.node).toBeUndefined();
  });
});
