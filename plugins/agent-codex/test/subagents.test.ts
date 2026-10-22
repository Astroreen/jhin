import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type Step } from "./support.ts";

afterEach(stopAll);

const parentItem = (method: "item/started" | "item/completed", item: Record<string, unknown>) =>
  ({ notify: method, params: { threadId: "$thread", turnId: "$turn", item } }) satisfies Step;
const childItem = (
  child: string,
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
) => ({ notify: method, params: { threadId: child, turnId: "child-turn", item } }) satisfies Step;

describe("jhin.agent-codex: subagents (D1145)", () => {
  it("shows a spawned subagent as a child thread with its own work, approvals and end", async () => {
    const fake = fakeCodex({
      turns: [
        [
          parentItem("item/completed", {
            type: "collabAgentToolCall",
            id: "spawn-1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "$thread",
            receiverThreadIds: ["child-a"],
            prompt: "Find the failing test\nand report it",
            model: "gpt-5.5",
            agentsStates: {},
          }),
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "child-a", turnId: "child-turn", itemId: "m1", delta: "Looking" },
          },
          childItem("child-a", "item/completed", {
            type: "agentMessage",
            id: "m1",
            text: "Found it",
          }),
          // The parent's own item with the same id stays the parent's.
          parentItem("item/completed", { type: "agentMessage", id: "m1", text: "Waiting" }),
          {
            request: "item/commandExecution/requestApproval",
            params: {
              threadId: "child-a",
              turnId: "child-turn",
              itemId: "c1",
              command: "npm test",
              cwd: "/work",
            },
          },
          childItem("child-a", "item/completed", {
            type: "commandExecution",
            id: "c1",
            command: "npm test",
            cwd: "/work",
            commandActions: [],
            status: "completed",
            aggregatedOutput: "1 failing\n",
            exitCode: 1,
          }),
          {
            notify: "turn/completed",
            params: {
              threadId: "child-a",
              turn: { id: "child-turn", status: "completed", items: [] },
            },
          },
          // A wait that names the ended subagent ends nothing twice.
          parentItem("item/completed", {
            type: "collabAgentToolCall",
            id: "wait-1",
            tool: "wait",
            status: "completed",
            senderThreadId: "$thread",
            receiverThreadIds: ["child-a"],
            agentsStates: { "child-a": { status: "completed", message: "done" } },
          }),
          parentItem("item/completed", { type: "agentMessage", id: "m2", text: "All done" }),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const opened = until(client, thread.id, "agent.request.opened");
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    const [request] = payloads(await opened, "agent.request.opened");
    expect(request).toMatchObject({
      request: { kind: "approval", tool: { kind: "command", detail: "npm test" } },
    });
    await client.call("threads.respond", {
      threadId: thread.id,
      requestId: request!["requestId"],
      response: { kind: "approval", decision: "accept" },
    });
    const events = await done;
    const [startedChild] = payloads(events, "threads.subagent.started");
    expect(startedChild).toMatchObject({
      subagentId: "child-a",
      title: "Find the failing test",
    });
    // The child's message never shows in the parent's turn; the parent's own does.
    expect(
      payloads(events, "agent.item.completed")
        .filter((item) => item["kind"] === "message")
        .map((item) => item["text"]),
    ).toEqual(["Waiting", "All done"]);
    // Codex got the decision for the subagent's command.
    expect(fake.answers()).toEqual([{ decision: "accept" }]);

    const childEvents = await until(
      client,
      String(startedChild!["childThreadId"]),
      "agent.turn.completed",
    );
    expect(payloads(childEvents, "agent.item.completed")).toEqual([
      expect.objectContaining({ kind: "message", text: "Found it" }),
      expect.objectContaining({ kind: "tool", status: "completed", output: "1 failing\n" }),
    ]);
  });

  it("starts one from Codex's subagent activity and ends it as interrupted", async () => {
    const fake = fakeCodex({
      turns: [
        [
          parentItem("item/started", {
            type: "subAgentActivity",
            id: "act-1",
            kind: "started",
            agentPath: "reviewer",
            agentThreadId: "child-b",
          }),
          parentItem("item/completed", {
            type: "subAgentActivity",
            id: "act-2",
            kind: "interrupted",
            agentPath: "reviewer",
            agentThreadId: "child-b",
          }),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    const [startedChild] = payloads(await done, "threads.subagent.started");
    expect(startedChild).toMatchObject({ subagentId: "child-b", title: "reviewer" });
    await until(client, String(startedChild!["childThreadId"]), "agent.turn.interrupted");
  });
});
