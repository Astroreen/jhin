import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, stopAll, until } from "./support.ts";

afterEach(stopAll);

describe("jhin.agent-codex: /feedback (D1317)", () => {
  it("sends the thread's Codex thread and logs to OpenAI, with the reason", async () => {
    const fake = fakeCodex({ turns: [[{ complete: "completed" }]] });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    // Before a turn there is no Codex thread to send.
    await expect(
      client.call("agents.feedback.upload", { threadId: thread.id }),
    ).rejects.toMatchObject({ message: "Send a message before you submit feedback." });

    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "hello" });
    await done;
    const codexThread = fake.received("thread/start").length;
    expect(codexThread).toBe(1);
    const { feedbackId } = await client.call<{ feedbackId: string }>("agents.feedback.upload", {
      threadId: thread.id,
      reason: "  The diff was wrong  ",
    });
    const [upload] = fake.received("feedback/upload");
    // Codex's own thread goes, the one thread/start answered; the id is Codex's answer.
    const started = "codex-thread-1";
    expect(upload!.params).toEqual({
      classification: "bug",
      includeLogs: true,
      reason: "The diff was wrong",
      threadId: started,
    });
    expect(feedbackId).toBe(`feedback-${started}`);
    // T3 lists it among Codex's commands, and agents.list says Codex takes feedback.
    const agents = await client.call<{ agentId: string; feedback?: boolean }[]>("agents.list");
    expect(agents.find((agent) => agent.agentId === CODEX_AGENT_ID)?.feedback).toBe(true);
  });
  it("says why an upload failed: Codex's error, or an answer that names no thread", async () => {
    const upload = async (scenario: Parameters<typeof fakeCodex>[0]) => {
      const fake = fakeCodex({ turns: [[{ complete: "completed" }]], ...scenario });
      const { client } = await node(fake);
      const thread = await client.call<{ id: string }>("threads.create", {
        agentId: CODEX_AGENT_ID,
      });
      const done = until(client, thread.id, "agent.turn.completed");
      await client.call("threads.send", { threadId: thread.id, text: "hello" });
      await done;
      return client.call("agents.feedback.upload", { threadId: thread.id });
    };
    await expect(
      upload({ errors: { "feedback/upload": [{ message: "upload rejected" }] } }),
    ).rejects.toMatchObject({
      message: "Failed to upload Codex thread feedback: upload rejected",
    });
    await expect(upload({ feedback: {} })).rejects.toMatchObject({
      message: "Failed to upload Codex thread feedback: Codex did not say which thread it sent.",
    });
  });
});
