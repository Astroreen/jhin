import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type Client, type Step } from "./support.ts";

afterEach(stopAll);

const item = (method: "item/started" | "item/completed", value: Record<string, unknown>): Step => ({
  notify: method,
  params: { threadId: "$thread", turnId: "$turn", item: value },
});

const command = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  type: "commandExecution",
  id,
  command: "rm -rf build",
  cwd: "/work",
  commandActions: [],
  status,
  ...extra,
});

const commandApproval = (itemId: string): Step => ({
  request: "item/commandExecution/requestApproval",
  params: {
    threadId: "$thread",
    turnId: "$turn",
    itemId,
    command: "rm -rf build",
    reason: "Clean the build",
    startedAtMs: 0,
  },
});

/** Answers the turn's next request with `response` once it is recorded. */
async function answer(client: Client, threadId: string, count: number, response: unknown) {
  const events = await until(client, threadId, "agent.request.opened", count);
  const opened = payloads(events, "agent.request.opened").at(-1)!;
  await client.call("threads.respond", {
    threadId,
    requestId: opened["requestId"],
    response,
  });
  return opened;
}

describe("jhin.agent-codex: approvals", () => {
  it("asks before a command and runs it once accepted", async () => {
    const fake = fakeCodex({
      turns: [
        [
          item("item/started", command("c1", "inProgress")),
          commandApproval("c1"),
          item("item/completed", command("c1", "completed", { aggregatedOutput: "", exitCode: 0 })),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "approval-required",
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "clean" });
    const opened = await answer(client, thread.id, 1, { kind: "approval", decision: "accept" });
    expect(opened).toMatchObject({
      requestId: "c1:approval",
      request: {
        kind: "approval",
        tool: { kind: "command", title: "Run command", detail: "rm -rf build" },
        reason: "Clean the build",
      },
    });
    await completed;
    expect(fake.answers()).toEqual([{ decision: "accept" }]);
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
      approvalsReviewer: "user",
    });
  });

  it("records a declined command as declined", async () => {
    const fake = fakeCodex({
      turns: [
        [
          item("item/started", command("c1", "inProgress")),
          commandApproval("c1"),
          item("item/completed", command("c1", "declined")),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake, {});
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "approval-required",
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "clean" });
    await answer(client, thread.id, 1, { kind: "approval", decision: "decline" });
    const events = await completed;
    expect(fake.answers()).toEqual([{ decision: "decline" }]);
    expect(payloads(events, "agent.item.completed")[0]).toMatchObject({
      kind: "tool",
      status: "declined",
    });
  });

  it("accepts later commands of the session without asking once accepted for the session", async () => {
    const fake = fakeCodex({
      turns: [
        [commandApproval("c1"), commandApproval("c2"), { complete: "completed" }],
        [commandApproval("c3"), { complete: "completed" }],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "auto-accept-edits",
    });
    const first = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "one" });
    await answer(client, thread.id, 1, { kind: "approval", decision: "accept-for-session" });
    const events = await first;
    expect(payloads(events, "agent.request.opened")).toHaveLength(1);

    const second = until(client, thread.id, "agent.turn.completed", 2);
    await client.call("threads.send", { threadId: thread.id, text: "two" });
    const all = await second;
    expect(payloads(all, "agent.request.opened")).toHaveLength(1);
    expect(fake.answers()).toEqual([
      { decision: "acceptForSession" },
      { decision: "acceptForSession" },
      { decision: "acceptForSession" },
    ]);
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  it("asks again in a stricter mode after accepting for the session", async () => {
    const fake = fakeCodex({
      turns: [
        [commandApproval("c1"), { complete: "completed" }],
        [commandApproval("c2"), { complete: "completed" }],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "auto-accept-edits",
    });
    const first = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "one" });
    await answer(client, thread.id, 1, { kind: "approval", decision: "accept-for-session" });
    await first;
    const second = until(client, thread.id, "agent.turn.completed", 2);
    await client.call("threads.send", {
      threadId: thread.id,
      text: "two",
      runtimeMode: "approval-required",
    });
    await answer(client, thread.id, 2, { kind: "approval", decision: "accept" });
    await second;
    expect(fake.answers()).toEqual([{ decision: "acceptForSession" }, { decision: "accept" }]);
  });

  it("tells Codex a request Jhin does not answer is not found", async () => {
    const fake = fakeCodex({
      turns: [
        [
          { request: "item/somethingNew", params: { threadId: "$thread", turnId: "$turn" } },
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await completed;
    expect(fake.answers()).toEqual([expect.objectContaining({ code: -32601 })]);
  });

  it("names the files of a file change it asks about", async () => {
    const fake = fakeCodex({
      turns: [
        [
          item("item/started", {
            type: "fileChange",
            id: "f1",
            status: "inProgress",
            changes: [
              { path: "src/b.ts", kind: { type: "update", move_path: "src/c.ts" }, diff: "-b\n+c" },
              { path: "src/a.ts", kind: { type: "add" }, diff: "+a" },
            ],
          }),
          {
            request: "item/fileChange/requestApproval",
            params: { threadId: "$thread", turnId: "$turn", itemId: "f1", startedAtMs: 0 },
          },
          item("item/completed", {
            type: "fileChange",
            id: "f1",
            status: "completed",
            changes: [{ path: "src/a.ts", kind: { type: "add" }, diff: "+a" }],
          }),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "approval-required",
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "edit" });
    const opened = await answer(client, thread.id, 1, { kind: "approval", decision: "accept" });
    expect(opened).toMatchObject({
      request: {
        tool: { kind: "file_change", title: "Edit file", detail: "src/b.ts, src/a.ts" },
        reason: "add src/a.ts\nupdate src/b.ts -> src/c.ts",
      },
    });
    const events = await completed;
    expect(payloads(events, "agent.item.started")[0]).toMatchObject({
      tool: { kind: "file_change", title: "Edited file" },
    });
    expect(payloads(events, "agent.item.completed")[0]).toMatchObject({ output: "+a" });
  });

  it("grants permissions for the turn, and none when declined", async () => {
    const permissions = { fileSystem: { write: ["/work/out"] } };
    const ask = (itemId: string): Step => ({
      request: "item/permissions/requestApproval",
      params: {
        threadId: "$thread",
        turnId: "$turn",
        itemId,
        cwd: "/work",
        permissions,
        startedAtMs: 0,
      },
    });
    const fake = fakeCodex({
      turns: [
        [
          ask("p1"),
          ask("p2"),
          {
            notify: "item/completed",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              item: {
                type: "commandExecution",
                id: "p2",
                command: "touch out",
                cwd: "/work",
                commandActions: [],
                status: "failed",
              },
            },
          },
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "approval-required",
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "write" });
    const opened = await answer(client, thread.id, 1, { kind: "approval", decision: "accept" });
    expect(opened).toMatchObject({
      request: { tool: { kind: "file_change", title: "Grant permissions" } },
    });
    await answer(client, thread.id, 2, { kind: "approval", decision: "decline" });
    // The declined permission's item shows as declined, not failed.
    expect(payloads(await completed, "agent.item.completed")[0]).toMatchObject({
      status: "declined",
    });
    expect(fake.answers()).toEqual([
      { permissions, scope: "turn" },
      { permissions: {}, scope: "turn" },
    ]);
  });

  it("cancels an open approval when the turn is interrupted", async () => {
    const fake = fakeCodex({
      turns: [[commandApproval("c1"), { waitForInterrupt: true }, { complete: "interrupted" }]],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "approval-required",
    });
    const interrupted = until(client, thread.id, "agent.turn.interrupted");
    await client.call("threads.send", { threadId: thread.id, text: "clean" });
    await until(client, thread.id, "agent.request.opened");
    await client.call("threads.interrupt", { threadId: thread.id });
    await interrupted;
    expect(fake.answers()).toEqual([{ decision: "cancel" }]);
    expect(fake.received("turn/interrupt")[0]?.params).toEqual({
      threadId: "codex-thread-1",
      turnId: "turn-1",
    });
  });
});

describe("jhin.agent-codex: questions and plans", () => {
  it("asks Codex's questions and sends the answers back by id", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            request: "item/tool/requestUserInput",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              itemId: "q1",
              isBlocking: true,
              questions: [
                {
                  id: "db",
                  header: "Database",
                  question: "Which database?",
                  options: [
                    { label: "SQLite", description: "A file" },
                    { label: "Postgres", description: "A server" },
                  ],
                },
                { id: "name", header: "Name", question: "Its name?", isOther: true },
              ],
            },
          },
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "set up" });
    const opened = await answer(client, thread.id, 1, {
      kind: "user-input",
      answers: { db: "SQLite", name: "jhin", other: "dropped" },
    });
    expect(opened).toMatchObject({
      requestId: "q1:input",
      request: {
        kind: "user-input",
        questions: [
          {
            id: "db",
            header: "Database",
            question: "Which database?",
            options: [{ label: "SQLite", description: "A file" }, { label: "Postgres" }],
            allowCustomAnswer: false,
          },
          { id: "name", allowCustomAnswer: true },
        ],
      },
    });
    await completed;
    expect(fake.answers()).toEqual([
      { answers: { db: { answers: ["SQLite"] }, name: { answers: ["jhin"] } } },
    ]);
  });

  it("proposes a plan turn's plan and updates the todo plan", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "turn/plan/updated",
            params: {
              threadId: "$thread",
              turnId: "$turn",
              plan: [
                { step: "Read the code", status: "completed" },
                { step: "Write the plan", status: "inProgress" },
                { step: "", status: "pending" },
              ],
            },
          },
          {
            notify: "item/plan/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "p1", delta: "# Plan\n" },
          },
          item("item/completed", { type: "plan", id: "p1", text: "# Plan\n1. Do it" }),
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake, { effort: "high" });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      interactionMode: "plan",
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "plan it" });
    const events = await completed;
    expect(payloads(events, "agent.plan.updated")[0]).toMatchObject({
      steps: [
        { text: "Read the code", status: "completed" },
        { text: "Write the plan", status: "in_progress" },
        { text: "Step 3", status: "pending" },
      ],
    });
    expect(payloads(events, "agent.plan.proposed")).toEqual([
      expect.objectContaining({ itemId: "p1", markdown: "# Plan\n1. Do it" }),
    ]);
    // The plan shows once, as the proposal, not also as a message.
    expect(payloads(events, "agent.item.completed")).toEqual([]);
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      effort: "high",
      collaborationMode: { mode: "plan", settings: { reasoning_effort: "high" } },
    });
  });
});

describe("jhin.agent-codex: legacy approvals", () => {
  it("maps execCommandApproval and applyPatchApproval to Codex's review decisions", async () => {
    const exec = (callId: string): Step => ({
      request: "execCommandApproval",
      params: {
        conversationId: "$thread",
        callId,
        command: ["rm", "-rf", "build"],
        cwd: "/work",
        parsedCmd: [],
      },
    });
    const fake = fakeCodex({
      turns: [
        [
          exec("e1"),
          exec("e2"),
          {
            request: "applyPatchApproval",
            params: {
              conversationId: "$thread",
              callId: "a1",
              fileChanges: { "src/a.ts": { type: "add" } },
            },
          },
          { complete: "completed" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
      runtimeMode: "approval-required",
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "clean" });
    const run = await answer(client, thread.id, 1, {
      kind: "approval",
      decision: "accept-for-session",
    });
    expect(run).toMatchObject({
      requestId: "e1:approval",
      request: { tool: { kind: "command", title: "Run command", detail: "rm -rf build" } },
    });
    const patch = await answer(client, thread.id, 2, { kind: "approval", decision: "decline" });
    expect(patch).toMatchObject({
      requestId: "a1:approval",
      request: { tool: { kind: "file_change", detail: "src/a.ts" }, reason: "add src/a.ts" },
    });
    await completed;
    expect(fake.answers()).toEqual([
      { decision: "approved_for_session" },
      // The second command needs no answer from the user.
      { decision: "approved_for_session" },
      { decision: { denied: { rejection: "User declined the request." } } },
    ]);
  });
});
