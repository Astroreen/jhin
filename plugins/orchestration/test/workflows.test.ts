import { describe, expect, it } from "vite-plus/test";

import { node, orchestrationFeed, parentThread, scriptedRuntime, watch } from "./support.ts";

const FAKE = { "jhin.threads": { defaultAgent: "jhin.agent-fake" } };

interface WorkflowView {
  workflowId: string;
  status: string;
  agents: { index: number; taskId?: string; label?: string; phase?: string; status: string }[];
  logs: string[];
  result?: unknown;
  error?: string;
  delivery: string;
}

/** Answers a schema prompt with JSON once it was told it got it wrong, everything else by echo. */
const jsonAgent = scriptedRuntime("json", (request) => {
  const text = request.input.text;
  const stubborn = JSON.stringify(request.history).includes("stubborn");
  if (text.startsWith("Your answer does not match")) {
    return stubborn ? "still not json" : '```json\n{"count": 3}\n```';
  }
  if (text.includes("JSON Schema"))
    return text.includes("stubborn") ? "not json" : '{"count": "three"}';
  return `json: ${text}`;
});

describe("workflows", () => {
  it("runs parallel and pipeline agents, phases, logs and schemas, then wakes the parent", async () => {
    const { client } = await node({ config: FAKE, plugins: [jsonAgent] });
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const parentEvents = watch(client, parent.id);
    const script = `export const meta = {
  name: 'demo',
  description: 'Exercise every hook',
  phases: [{ title: 'Fan out' }, { title: 'Check', detail: 'schema' }],
}
phase('Fan out')
log('targets: ' + args.targets.join(','))
const echoed = await parallel(args.targets.map((t) => () => agent('look at ' + t, { label: t })))
const failed = await parallel([() => agent('/fail now'), () => { throw new Error('thunk') }])
const piped = await pipeline(['a', 'b'], (item) => agent(item), (previous, item, index) => previous + '|' + item + index)
phase('Check')
const counted = await agent('count things', { agentId: 'json', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } })
const stubborn = await agent('stubborn', { agentId: 'json', schema: { type: 'object', properties: { count: { type: 'number' } } } })
return { echoed, failed, piped, counted, stubborn }`;
    const started = await client.call<{ workflowId: string; name: string; status: string }>(
      "workflows.run",
      { script, args: { targets: ["x", "y"] }, parentThreadId: parent.id },
    );
    expect(started).toMatchObject({ name: "demo", status: "running" });
    const done = await feed.workflow(
      started.workflowId,
      (record) => record.delivery === "delivered",
    );
    expect(done).toMatchObject({
      status: "completed",
      logs: ["targets: x,y"],
      result: {
        echoed: ["Echo: look at x", "Echo: look at y"],
        failed: [null, null],
        piped: ["Echo: a|a0", "Echo: b|b1"],
        counted: { count: 3 },
        stubborn: null,
      },
    });
    const agents = (done as unknown as WorkflowView).agents;
    expect(agents.find((agent) => agent.label === "x")).toMatchObject({
      phase: "Fan out",
      status: "completed",
    });
    expect(agents.at(-1)).toMatchObject({ phase: "Check", status: "completed" });
    const wake = await parentEvents.until("agent.turn.started");
    expect((wake.payload as { input: { text: string } }).input.text).toBe(
      `Workflow ${started.workflowId} reached a terminal state. Use workflows_status with workflowId ${started.workflowId} to read the result.`,
    );
    // Its own agents never wake the parent: one message for the whole run.
    expect(parentEvents.events.filter((event) => event.type === "agent.turn.started")).toHaveLength(
      1,
    );
    const status = await client.call<WorkflowView>("workflows.status", {
      workflowId: started.workflowId,
      parentThreadId: parent.id,
    });
    expect(status.delivery).toBe("acknowledged");
    const tasks = await client.call<{ workflowId?: string; delivery: string }[]>("tasks.list", {
      parentThreadId: parent.id,
    });
    expect(
      tasks.every((task) => task.workflowId === started.workflowId && task.delivery === "none"),
    ).toBe(true);
    expect(
      await client.call<WorkflowView[]>("workflows.list", { parentThreadId: parent.id }),
    ).toHaveLength(1);
  });

  it("stops a run with its agents", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
      script:
        "export const meta = { name: 'hold', description: 'Holds' }\nreturn agent('/hold forever')",
      parentThreadId: parent.id,
    });
    const holding = await feed.workflow(workflowId, (record) =>
      (record.agents as WorkflowView["agents"]).some((agent) => agent.status === "running"),
    );
    const taskId = (holding.agents as WorkflowView["agents"])[0]!.taskId!;
    expect(await client.call("workflows.stop", { workflowId, parentThreadId: parent.id })).toEqual({
      workflowId,
      status: "stopped",
    });
    expect(await feed.task(taskId, (record) => record.endedAt !== undefined)).toMatchObject({
      status: "cancelled",
    });
    expect((await client.call<WorkflowView>("workflows.status", { workflowId })).status).toBe(
      "stopped",
    );
  });

  it("refuses an invalid script and records a script's error", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    await expect(
      client.call("workflows.run", { script: "agent('x')", parentThreadId: parent.id }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
    await expect(
      client.call("workflows.run", {
        script: "export const meta = { name: 'x', description: 'y' }",
      }),
    ).rejects.toMatchObject({ code: "THREAD_REQUIRED" });
    const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
      script:
        "export const meta = { name: 'bad', description: 'Unknown agent' }\nreturn agent('x', { agentId: 'ghost' })",
      parentThreadId: parent.id,
    });
    expect(await feed.workflow(workflowId, (record) => record.status !== "running")).toMatchObject({
      status: "failed",
      error: "Agent ghost is not registered.",
    });
  });

  it("fails a run the node stopped in, on the next start", async () => {
    const first = await node();
    const parent = await parentThread(first.client);
    const feed = orchestrationFeed(first.client);
    const { workflowId } = await first.client.call<{ workflowId: string }>("workflows.run", {
      script: "export const meta = { name: 'hold', description: 'Holds' }\nreturn agent('/hold')",
      parentThreadId: parent.id,
    });
    await feed.workflow(workflowId, (record) =>
      (record.agents as WorkflowView["agents"]).some((agent) => agent.status === "running"),
    );
    await first.stop();
    const second = await node({ storage: first.storage, data: first.data });
    const after = await second.client.call<WorkflowView>("workflows.status", { workflowId });
    expect(after).toMatchObject({
      status: "failed",
      error: "The node stopped while the workflow ran.",
    });
  });
});
