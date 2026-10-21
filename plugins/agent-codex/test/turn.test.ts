import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type Step } from "./support.ts";

afterEach(stopAll);

const item = (method: "item/started" | "item/completed", value: Record<string, unknown>): Step => ({
  notify: method,
  params: { threadId: "$thread", turnId: "$turn", item: value },
});

const message = (itemId: string, text: string): Step =>
  item("item/completed", { type: "agentMessage", id: itemId, text });

describe("jhin.agent-codex: a turn", () => {
  it("streams a message and reasoning, runs a command and reports usage", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/reasoning/summaryTextDelta",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              itemId: "r1",
              summaryIndex: 0,
              delta: "Thinking",
            },
          },
          item("item/completed", {
            type: "reasoning",
            id: "r1",
            summary: ["Thinking hard"],
            content: [],
          }),
          item("item/started", {
            type: "commandExecution",
            id: "c1",
            command: "ls",
            cwd: "/work",
            commandActions: [],
            status: "inProgress",
          }),
          {
            notify: "item/commandExecution/outputDelta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "c1", delta: "README.md\n" },
          },
          item("item/completed", {
            type: "commandExecution",
            id: "c1",
            command: "ls",
            cwd: "/work",
            commandActions: [],
            status: "completed",
            aggregatedOutput: "README.md\n",
            exitCode: 0,
          }),
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "It is " },
          },
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Jhin." },
          },
          item("item/completed", {
            type: "agentMessage",
            id: "m1",
            text: "It is Jhin.",
            phase: "final_answer",
          }),
          {
            notify: "thread/tokenUsage/updated",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              tokenUsage: {
                last: {
                  inputTokens: 1200,
                  cachedInputTokens: 1000,
                  outputTokens: 30,
                  reasoningOutputTokens: 10,
                  totalTokens: 1230,
                },
                total: {
                  inputTokens: 1200,
                  cachedInputTokens: 1000,
                  outputTokens: 30,
                  reasoningOutputTokens: 10,
                  totalTokens: 1230,
                },
                modelContextWindow: 272000,
              },
            },
          },
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "What is this?" });
    const events = await completed;

    expect(events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "agent.turn.started",
      "agent.item.delta",
      "agent.item.completed",
      "agent.item.started",
      "agent.item.delta",
      "agent.item.completed",
      "agent.item.delta",
      "agent.item.delta",
      "agent.item.completed",
      "agent.usage.updated",
      "agent.turn.completed",
    ]);
    const done = payloads(events, "agent.item.completed");
    expect(done[0]).toMatchObject({ kind: "reasoning", text: "Thinking hard" });
    expect(done[1]).toMatchObject({ kind: "tool", status: "completed", output: "README.md\n" });
    expect(done[2]).toMatchObject({ kind: "message", text: "It is Jhin." });
    expect(payloads(events, "agent.item.started")[0]).toMatchObject({
      tool: { kind: "command", title: "Ran command", detail: "ls" },
    });
    expect(payloads(events, "agent.usage.updated")[0]).toMatchObject({
      usage: {
        inputTokens: 1200,
        cachedInputTokens: 1000,
        outputTokens: 30,
        contextTokens: 1230,
        contextWindow: 272000,
      },
    });

    // What Jhin told Codex: a new thread in the project's folder, then the turn.
    expect(fake.received("initialize")[0]?.params).toMatchObject({
      clientInfo: { name: "Jhin" },
      capabilities: { experimentalApi: true },
    });
    expect(fake.received("thread/start")[0]?.params).toMatchObject({
      config: { "tools.update_plan.enabled": true },
    });
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "What is this?" }],
      summary: "detailed",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: { mode: "default" },
    });
  });

  it("compacts the Codex thread on /compact, as a turn Codex names itself", async () => {
    const fake = fakeCodex({
      turns: [
        [message("m1", "Hi."), { complete: "completed" }],
        [
          { notify: "turn/started", params: { threadId: "$thread", turn: { id: "$turn" } } },
          item("item/started", { type: "contextCompaction", id: "k1" }),
          item("item/completed", { type: "contextCompaction", id: "k1" }),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    let completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    await completed;
    completed = until(client, thread.id, "agent.turn.completed", 2);
    await client.call("threads.send", { threadId: thread.id, text: " /compact " });
    const events = await completed;

    expect(fake.received("turn/start")).toHaveLength(1);
    expect(fake.received("thread/compact/start").map((call) => call.params)).toEqual([
      { threadId: "codex-thread-1" },
    ]);
    expect(payloads(events, "agent.item.started").at(-1)).toMatchObject({
      itemId: "k1",
      tool: { name: "compaction", kind: "other", title: "Compacting context" },
    });
    expect(payloads(events, "agent.item.completed").at(-1)).toMatchObject({
      itemId: "k1",
      kind: "tool",
      status: "completed",
    });
  });

  it("fails the turn with Codex's error", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "error",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              willRetry: true,
              error: { message: "Reconnecting... 1/5" },
            },
          },
          {
            notify: "error",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              willRetry: false,
              error: { message: "stream error", additionalDetails: "The model is overloaded." },
            },
          },
          { complete: "failed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    const events = await failed;
    expect(payloads(events, "agent.turn.failed")[0]).toMatchObject({
      error: expect.stringContaining("The model is overloaded."),
    });
    // Codex ended the turn itself: its app-server stays for the next one.
    expect(await client.call("codex.sessions.list", {})).toEqual([
      expect.objectContaining({ threadId: thread.id, busy: false }),
    ]);
  });
});

describe("jhin.agent-codex: the last line before an exit", () => {
  it("completes a turn whose turn/completed Codex writes just before it exits", async () => {
    const fake = fakeCodex({
      turns: [[message("m1", "Done."), { complete: "completed" }, { exit: 0 }]],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "finish" });
    expect(payloads(await completed, "agent.item.completed")[0]).toMatchObject({ text: "Done." });
  });
});
