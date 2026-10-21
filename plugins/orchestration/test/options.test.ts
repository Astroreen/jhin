import { describe, expect, it } from "vite-plus/test";

import { node, orchestrationFeed, parentThread, type TaskView } from "./support.ts";

describe("model options of a child (D870)", () => {
  it("takes target.options as a list or a record, and inherits the parent's with its model", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client, { modelOptions: [{ id: "effort", value: "low" }] });
    const summary = async (request: Record<string, unknown>) => {
      const task = await client.call<TaskView>("tasks.delegate", {
        task: "/options",
        parentThreadId: parent.id,
        ...request,
      });
      return (await feed.task(task.taskId, (record) => record.status === "completed")).summary;
    };
    expect(await summary({})).toBe("Options: effort=low");
    expect(await summary({ target: { options: { effort: "high", fastMode: true } } })).toBe(
      "Options: effort=high fastMode=true",
    );
    expect(await summary({ target: { options: [{ id: "effort", value: "medium" }] } })).toBe(
      "Options: effort=medium",
    );
    // Another model of the agent: the parent's options stay with the parent's model.
    expect(await summary({ target: { model: "plain" } })).toBe("Options: none");
  });

  it("gives a workflow agent's effort to its model, and lists each model's options", async () => {
    const { client } = await node();
    const feed = orchestrationFeed(client);
    const parent = await parentThread(client);
    const { workflowId } = await client.call<{ workflowId: string }>("workflows.run", {
      script:
        "export const meta = { name: 'e', description: 'Effort' }\nreturn agent('/options', { effort: 'high' })",
      parentThreadId: parent.id,
    });
    expect(
      (await feed.workflow(workflowId, (record) => record.status === "completed")).result,
    ).toBe("Options: effort=high");

    const capabilities = await client.call<{
      agents: { agentId: string; models: { id: string; options?: { id: string }[] }[] }[];
    }>("orchestration.capabilities", { threadId: parent.id });
    const fake = capabilities.agents.find((agent) => agent.agentId === "jhin.agent-fake");
    expect(
      fake?.models.find((model) => model.id === "echo")?.options?.map((option) => option.id),
    ).toEqual(["effort", "fastMode"]);
  });
});
