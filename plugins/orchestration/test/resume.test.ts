import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { node, orchestrationFeed, parentThread, scriptedRuntime } from "./support.ts";

interface Agent {
  index: number;
  label?: string;
  phase?: string;
  status: string;
  cached?: boolean;
  taskId?: string;
}

const run = (meta: string, body: string) =>
  `export const meta = { name: '${meta}', description: '${meta}' }\n${body}`;

describe("resuming a workflow (D872)", () => {
  it("reuses the unchanged prefix of agent() calls and runs the rest live", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const first = await client.call<{ workflowId: string }>("workflows.run", {
      script: run(
        "r",
        "const a = await agent('one', { label: 'a' })\nreturn [a, await agent('two', { label: 'b' })]",
      ),
      parentThreadId: parent.id,
    });
    const done = await feed.workflow(first.workflowId, (record) => record.status === "completed");
    expect(done.result).toEqual(["Echo: one", "Echo: two"]);
    const [cachedTask] = (done.agents as Agent[]).map((agent) => agent.taskId);

    const second = await client.call<{ workflowId: string }>("workflows.run", {
      script: run(
        "r",
        "const a = await agent('one', { label: 'a' })\nreturn [a, await agent('three', { label: 'b' })]",
      ),
      parentThreadId: parent.id,
      resumeFromRunId: first.workflowId,
    });
    const resumed = await feed.workflow(
      second.workflowId,
      (record) => record.status === "completed",
    );
    expect(resumed.result).toEqual(["Echo: one", "Echo: three"]);
    expect(resumed.resumedFrom).toBe(first.workflowId);
    const agents = (resumed.agents as Agent[]).toSorted((a, b) => a.index - b.index);
    expect(agents[0]).toMatchObject({
      label: "a",
      status: "completed",
      cached: true,
      taskId: cachedTask,
    });
    expect(agents[1]).toMatchObject({ label: "b", status: "completed" });
    expect(agents[1]!.cached).toBeUndefined();

    // A run still going cannot be resumed.
    const held = await client.call<{ workflowId: string }>("workflows.run", {
      script: run("h", "return agent('/hold')"),
      parentThreadId: parent.id,
    });
    await expect(
      client.call("workflows.run", {
        script: run("h", "return 1"),
        parentThreadId: parent.id,
        resumeFromRunId: held.workflowId,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUNNING" });
    await client.call("workflows.stop", { workflowId: held.workflowId, parentThreadId: parent.id });
  });
});

describe("a workflow's budget (D873)", () => {
  it("counts its agents' output tokens and refuses agents once it is spent", async () => {
    const { client } = await node({
      plugins: [scriptedRuntime("costly", () => "done", { outputTokens: 100 })],
    });
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const body = `await agent('x', { agentId: 'costly' })
const remaining = budget.remaining()
let refused = null
try { await agent('y', { agentId: 'costly' }) } catch (error) { refused = error.message }
return { total: budget.total, spent: budget.spent(), remaining, refused }`;
    const capped = await client.call<{ workflowId: string }>("workflows.run", {
      script: run("b", body),
      parentThreadId: parent.id,
      budget: 100,
    });
    const record = await feed.workflow(capped.workflowId, (item) => item.status === "completed");
    expect(record.result).toEqual({
      total: 100,
      spent: 100,
      remaining: 0,
      refused: "The workflow's budget of 100 tokens is spent",
    });
    expect(record).toMatchObject({ budget: 100, spent: 100 });

    const open = await client.call<{ workflowId: string }>("workflows.run", {
      script: run("o", "return [budget.total, budget.remaining() === Infinity]"),
      parentThreadId: parent.id,
    });
    expect(
      (await feed.workflow(open.workflowId, (item) => item.status === "completed")).result,
    ).toEqual([null, true]);
  });
});

describe("nested and saved workflows (D874, D875)", () => {
  it("runs a saved workflow by name, inline or from a file, one level deep", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-workflows-"));
    Fs.mkdirSync(Path.join(dir, ".jhin", "workflows"), { recursive: true });
    Fs.writeFileSync(
      Path.join(dir, ".jhin", "workflows", "child.js"),
      run("child", "return await agent('child ' + args.x, { label: 'c' })"),
    );
    Fs.writeFileSync(
      Path.join(dir, "deep.js"),
      run("deep", "return await workflow('child', { x: 2 })"),
    );
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const parent = await parentThread(client, { projectId: project.id });
    const result = async (input: Record<string, unknown>) => {
      const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
        parentThreadId: parent.id,
        ...input,
      });
      return feed.workflow(workflowId, (item) => item.status !== "running");
    };

    const nested = await result({ script: run("p", "return await workflow('child', { x: 1 })") });
    expect(nested.result).toBe("Echo: child 1");
    expect((nested.agents as Agent[])[0]).toMatchObject({ label: "c", phase: "▸ child" });

    expect((await result({ name: "child", args: { x: 3 } })).result).toBe("Echo: child 3");
    // A child cannot nest another one.
    expect(
      await result({ script: run("p", "return await workflow({ scriptPath: 'deep.js' })") }),
    ).toMatchObject({ status: "failed", error: "workflow() nests one level only" });
    await expect(
      client.call("workflows.run", { name: "missing", parentThreadId: parent.id }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    await expect(
      client.call("workflows.run", { name: "child", script: "x", parentThreadId: parent.id }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
